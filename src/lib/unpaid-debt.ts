/**
 * An unpaid debt we cannot collect is VISIBLE, never silently skipped.
 *
 * An org whose balance is negative and whose last chargeable card is gone owes
 * us money we have no way to take. Before this, that org was counted `skipped`
 * by the month-end sweep and vanished from every surface: no customer email, no
 * staff signal, campaigns still running and the debt still growing.
 *
 * What happens instead, and what is deliberately REUSED rather than rebuilt:
 *
 *   - CAMPAIGNS STOP on their own, through the machinery that already exists.
 *     `resolvePostpaidTier` grants a NEGATIVE credit-line floor only to an org
 *     that can actually be reloaded (config + chargeable card + non-blocked
 *     issuing country). Losing the card drops the floor to "0", so the
 *     authorize gate and the read-only affordability pre-flight both read the
 *     org as depleted at any balance at or below zero and campaign-service
 *     stops dispatching. Nothing here has to stop anything.
 *   - THE STATE is the existing depletion EPISODE — the same row the dunning
 *     engine opens for an out-of-credit org — so recovery is the existing
 *     recovery: the episode closes when `credited` rises (a real recharge), and
 *     adding a card back restores the credit line, which re-arms auto-reload and
 *     the month-end sweep. No new lifecycle, nothing new to reconcile.
 *
 * What IS new is the telling: two emails (customer "a card is required to
 * resume, here is what you owe", staff "this org owes money we cannot collect")
 * claimed at most once per episode by `card_required_notified_at`, plus the
 * owed amount frozen on the row so a staff read costs one query.
 *
 * Fail-soft, the same posture as every other notification in this repo: nothing
 * here can fail, delay or roll back anything about the money it describes. The
 * money decisions (the floor, the sweep, the settle) are made elsewhere and have
 * already been made by the time any of this runs.
 */

import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, creditDepletionEpisodes } from "../db/schema.js";
import type { CreditDepletionEpisode } from "../db/schema.js";
import { computeBalance, type BalanceSnapshot } from "./balance.js";
import { cmpCents } from "./cents.js";
import { sendEmail } from "./email-client.js";
import { createPlatformRun, completePlatformRun } from "./runs-client.js";

/**
 * Customer email: "we could not collect what you owe, and we no longer have a
 * card — add one to resume". Registered by THIS service (see src/instrument.ts):
 * the fleet convention is that a template belongs to whoever SENDS it.
 *
 * NOT one of the six `credit-depleted*` dunning templates, and not the
 * `-blocked` variant either: those nudge "turn on auto-topup" and "recharge
 * manually", and neither is reachable for an org with no card on file. The one
 * action that unblocks this org is adding a card.
 */
export const UNPAID_DEBT_CARD_REQUIRED_EVENT = "credit-debt-card-required";

/**
 * Staff notification: this org owes money we cannot collect. Routed to the staff
 * list transactional-email-service already owns (its ADMIN_NOTIFICATION_EVENTS),
 * exactly like `brand_daily_budget_changed` — no recipient list lives here.
 */
export const UNPAID_DEBT_STAFF_EVENT = "unpaid_debt_uncollectable";

/**
 * The platform is the actor. There is no end user behind a sweep or a scheduler
 * tick, and none is invented for a READ — this is the all-zeros sentinel this
 * service already uses for a write it performs itself, stored on a row of its
 * OWN table. The recipient is resolved from the org's Stripe billing email, so
 * nothing downstream resolves a user from it.
 */
const PLATFORM_USER_ID = "00000000-0000-0000-0000-000000000000";

export type UnpaidDebtState =
  /** Balance is non-negative — nothing is owed. */
  | "no_debt"
  /** Owed, but a chargeable card exists — the normal collection paths own it. */
  | "collectable"
  /** Uncollectable, and this call is what flagged it (emails sent). */
  | "flagged"
  /** Uncollectable, already flagged on this episode — amount refreshed, no email. */
  | "already_flagged"
  /** Uncollectable, but the notification could not be claimed this tick (retried). */
  | "deferred";

export interface UnpaidDebtOutcome {
  state: UnpaidDebtState;
  /** Cents owed (positive) when the org is in debt; "0" otherwise. */
  owedCents: string;
}

function owedFrom(snapshot: BalanceSnapshot): string {
  return cmpCents(snapshot.balanceCents, "0") < 0
    ? snapshot.balanceCents.replace(/^-/, "")
    : "0";
}

/**
 * Format cents (a decimal string) as a dollar amount for customer-facing copy.
 * Whole cents, two decimals — a customer is told what they owe, not a
 * ten-decimal internal figure.
 */
export function formatOwed(cents: string): string {
  const n = Number(cents);
  return `$${(Math.round(n) / 100).toFixed(2)}`;
}

/**
 * Open (or reuse) the depletion episode for an org whose debt we cannot collect,
 * and tell the customer and staff about it exactly once.
 *
 * Pass a `snapshot` when the caller already holds one (the sweep does) so this
 * costs no extra reads. Per-org failure is the caller's to isolate — every
 * NOTIFICATION failure is swallowed here, but a database failure propagates
 * (fail-loud on state, fail-soft on telling).
 */
export async function flagUncollectableDebt(params: {
  orgId: string;
  snapshot?: BalanceSnapshot;
}): Promise<UnpaidDebtOutcome> {
  const snapshot = params.snapshot ?? (await computeBalance(params.orgId));
  const owedCents = owedFrom(snapshot);

  if (cmpCents(snapshot.balanceCents, "0") >= 0) {
    // Nothing owed. If a previous tick flagged this org, the flag is stale —
    // clear it so the staff surface does not show a debt that no longer exists.
    await clearUncollectableFlag(params.orgId);
    return { state: "no_debt", owedCents: "0" };
  }

  if (snapshot.hasCardPm) {
    // Owed, but collectable: the floor-crossing reload, the settle-before-card-
    // change and the month-end sweep all own this org. Clear any stale flag so
    // a card that came back is visible as such, and so a LATER loss re-notifies.
    await clearUncollectableFlag(params.orgId);
    return { state: "collectable", owedCents };
  }

  const episode = await ensureOpenEpisode(params.orgId, snapshot);

  if (episode.cardRequiredNotifiedAt != null) {
    // Already told. Refresh the amount so the staff surface tracks a growing
    // debt, and send nothing — a second tick must not re-email.
    await db
      .update(creditDepletionEpisodes)
      .set({ uncollectableDebtCents: owedCents, updatedAt: new Date() })
      .where(eq(creditDepletionEpisodes.id, episode.id));
    return { state: "already_flagged", owedCents };
  }

  // Resolve everything the sends need BEFORE claiming the marker: a claim taken
  // against a run we cannot open would burn the only notification. Same ordering
  // rule as the referral notifications.
  const runId = await createPlatformRun("unpaid-debt-notification");
  if (!runId) {
    console.error(
      `[billing-service] unpaid debt: no platform run for org ${params.orgId}, ` +
        `notification deferred to the next tick`
    );
    return { state: "deferred", owedCents };
  }

  const [claimed] = await db
    .update(creditDepletionEpisodes)
    .set({
      cardRequiredNotifiedAt: new Date(),
      uncollectableDebtCents: owedCents,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditDepletionEpisodes.id, episode.id),
        isNull(creditDepletionEpisodes.cardRequiredNotifiedAt)
      )
    )
    .returning();

  if (!claimed) {
    // A concurrent tick / replica won the claim and is sending.
    await completePlatformRun(runId);
    return { state: "already_flagged", owedCents };
  }

  console.warn(
    `[billing-service] unpaid debt: org ${params.orgId} owes ${owedCents} cents ` +
      `with no chargeable card — customer + staff notified, campaigns stopped`
  );

  const amountOwed = formatOwed(owedCents);
  sendEmail({
    eventType: UNPAID_DEBT_CARD_REQUIRED_EVENT,
    orgId: params.orgId,
    userId: episode.userId,
    runId,
    recipientEmail: snapshot.customer.email ?? undefined,
    metadata: { amountOwed, orgId: params.orgId },
  });
  sendEmail({
    eventType: UNPAID_DEBT_STAFF_EVENT,
    orgId: params.orgId,
    userId: episode.userId,
    runId,
    metadata: {
      amountOwed,
      orgId: params.orgId,
      billingEmail: snapshot.customer.email ?? "unknown",
    },
  });
  await completePlatformRun(runId);

  return { state: "flagged", owedCents };
}

/**
 * The org's OPEN depletion episode, opening one if there is none.
 *
 * Unlike `openDepletionEpisodeIfDepleted` this does NOT require campaign
 * activity and sends no T0: the debt already exists whether or not a campaign
 * happens to be authorizing right now, and the message this path sends is a
 * different one. The partial unique index `(org_id) WHERE recovered_at IS NULL`
 * is the race guard — a 23505 means someone else just opened it, so we re-read.
 */
async function ensureOpenEpisode(
  orgId: string,
  snapshot: BalanceSnapshot
): Promise<CreditDepletionEpisode> {
  const existing = await selectOpenEpisode(orgId);
  if (existing) return existing;

  try {
    const [row] = await db
      .insert(creditDepletionEpisodes)
      .values({
        orgId,
        userId: PLATFORM_USER_ID,
        creditedCentsAtOpen: snapshot.creditedCents,
      })
      .returning();
    return row;
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    const raced = await selectOpenEpisode(orgId);
    if (!raced) throw err;
    return raced;
  }
}

async function selectOpenEpisode(
  orgId: string
): Promise<CreditDepletionEpisode | undefined> {
  const [row] = await db
    .select()
    .from(creditDepletionEpisodes)
    .where(
      and(
        eq(creditDepletionEpisodes.orgId, orgId),
        isNull(creditDepletionEpisodes.recoveredAt)
      )
    )
    .limit(1);
  return row;
}

/**
 * Drop the uncollectable flag from this org's open episode, if it carries one.
 *
 * The EPISODE is not closed — that stays keyed on `credited` rising, the
 * existing recovery. Only the "we cannot collect this" marker goes, so the staff
 * surface stops listing a debt that is collectable again and a LATER card loss
 * notifies the customer afresh.
 */
async function clearUncollectableFlag(orgId: string): Promise<void> {
  await db
    .update(creditDepletionEpisodes)
    .set({
      cardRequiredNotifiedAt: null,
      uncollectableDebtCents: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditDepletionEpisodes.orgId, orgId),
        isNull(creditDepletionEpisodes.recoveredAt),
        isNotNull(creditDepletionEpisodes.cardRequiredNotifiedAt)
      )
    );
}

export interface UnpaidDebtScanResult {
  scanned: number;
  flagged: number;
  alreadyFlagged: number;
  cleared: number;
  failed: number;
}

/**
 * Hourly backstop: find every org that now owes money with no chargeable card.
 *
 * The immediate signal is `POST /internal/payment-methods/lost`, which
 * stripe-service calls the moment an org's last chargeable method is detached.
 * This scan is what makes the state correct WITHOUT that call — it also catches
 * the org that went into debt while already card-less, and it refreshes or
 * clears a flag when the situation changes. Bounded by the number of billing
 * accounts (~100 in prod), one balance composition each, isolated per org.
 */
export async function runUnpaidDebtScan(): Promise<UnpaidDebtScanResult> {
  const result: UnpaidDebtScanResult = {
    scanned: 0,
    flagged: 0,
    alreadyFlagged: 0,
    cleared: 0,
    failed: 0,
  };

  const accounts = await db
    .select({ orgId: billingAccounts.orgId })
    .from(billingAccounts);

  for (const account of accounts) {
    result.scanned += 1;
    try {
      const outcome = await flagUncollectableDebt({ orgId: account.orgId });
      if (outcome.state === "flagged") result.flagged += 1;
      else if (outcome.state === "already_flagged") result.alreadyFlagged += 1;
    } catch (err) {
      result.failed += 1;
      console.error(
        `[billing-service] unpaid-debt scan failed for org ${account.orgId}, skipping:`,
        err
      );
    }
  }

  return result;
}

export interface UnpaidDebtRow {
  orgId: string;
  owedCents: string;
  flaggedAt: string;
  episodeStartedAt: string;
}

/**
 * Every org currently carrying an uncollectable debt — the staff read.
 *
 * A plain DB read: the amount was frozen on the episode at flag time and is
 * refreshed on every tick while the debt persists, so this costs one query
 * rather than a balance composition per org.
 */
export async function listUnpaidDebts(): Promise<UnpaidDebtRow[]> {
  const rows = await db
    .select()
    .from(creditDepletionEpisodes)
    .where(
      and(
        isNull(creditDepletionEpisodes.recoveredAt),
        isNotNull(creditDepletionEpisodes.cardRequiredNotifiedAt)
      )
    );

  return rows.map((row) => ({
    orgId: row.orgId,
    owedCents: row.uncollectableDebtCents ?? "0",
    flaggedAt: (row.cardRequiredNotifiedAt as Date).toISOString(),
    episodeStartedAt: row.startedAt.toISOString(),
  }));
}
