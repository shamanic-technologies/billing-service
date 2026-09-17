/**
 * Out-of-credit dunning engine (issue #147).
 *
 * Three entry points:
 *   - openBlockedCampaignEpisode: called from the blocked-campaign reload sweep
 *     for an org whose campaigns the affordability pre-flight refuses and which
 *     the sweep could not unblock — the one org that can never reach authorize.
 *   - openDepletionEpisodeIfDepleted: called from the authorize path. Opens a
 *     depletion episode (and sends the instant T0 email) the first time an org
 *     is observed depleted while running a campaign. Idempotent — a second
 *     depleted authorize for the same open episode is a no-op.
 *   - runDunningTick: the scheduler heartbeat. For each open episode it
 *     recomputes the balance; if restored it closes the episode (stop-on-
 *     recharge, no email); if still depleted it sends the +3d / +10d follow-ups
 *     when due. Each stage is atomic-claimed so overlapping ticks / multiple
 *     replicas never double-send.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  creditDepletionEpisodes,
  PLATFORM_USER_ID,
  type CreditDepletionEpisode,
  DUNNING_EVENT_T0,
  DUNNING_EVENT_3D,
  DUNNING_EVENT_10D,
  DUNNING_EVENT_T0_BLOCKED,
  DUNNING_EVENT_3D_BLOCKED,
  DUNNING_EVENT_10D_BLOCKED,
} from "../db/schema.js";
import { cmpCents } from "./cents.js";
import { computeBalance, type BalanceSnapshot } from "./balance.js";
import { cannotSpend, resolveSpendBlock } from "./spend-block.js";
import { createPlatformRun, completePlatformRun } from "./runs-client.js";
import { sendEmail } from "./email-client.js";
import type { WorkflowHeaders } from "../middleware/auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const FOLLOWUP_3D_MS = 3 * DAY_MS;
export const FOLLOWUP_10D_MS = 10 * DAY_MS;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toUuidOrNull(value: string | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

/** A request carries "campaign activity" if any workflow-tracking header is set. */
function hasCampaignActivity(wf: WorkflowHeaders): boolean {
  return Boolean(wf.campaignId || wf.workflowSlug || wf.featureSlug);
}

/**
 * Pick the dunning eventType for a stage. When the org's card can't be charged
 * off_session (auto-reload-blocked country, e.g. India), the base templates'
 * "turn on auto-topup" nudge is a dead-end, so we route to the `-blocked` sibling
 * template whose copy points to a manual recharge instead. `autoReloadSupported`
 * comes straight from the balance snapshot — no extra Stripe call.
 */
function dunningEventType(
  base: typeof DUNNING_EVENT_T0 | typeof DUNNING_EVENT_3D | typeof DUNNING_EVENT_10D,
  autoReloadSupported: boolean
): string {
  if (autoReloadSupported) return base;
  switch (base) {
    case DUNNING_EVENT_T0:
      return DUNNING_EVENT_T0_BLOCKED;
    case DUNNING_EVENT_3D:
      return DUNNING_EVENT_3D_BLOCKED;
    case DUNNING_EVENT_10D:
      return DUNNING_EVENT_10D_BLOCKED;
  }
}

export interface OpenEpisodeParams {
  orgId: string;
  userId: string;
  runId: string;
  /** Balance snapshot at the failing authorize. */
  balanceCents: string;
  /**
   * Depletion floor (the derived postpaid tier's NEGATIVE credit line, or "0"
   * for prepaid orgs with no auto-reload). An episode opens ONLY when the
   * balance is at/below this floor — a normal negative balance WITHIN the line
   * never triggers a T0 email. Defaults to "0" (legacy strictly-prepaid gate).
   */
  thresholdCents?: string;
  /**
   * The cost of the run this authorize was refusing. An org whose balance is
   * still inside its credit line but cannot cover the NEXT run is out of credit
   * in the only sense that matters — see lib/spend-block for the gap this
   * closes. Defaults to "0", which reduces the gate to the legacy
   * `balance <= floor` check.
   */
  requiredCents?: string;
  /** Credited snapshot at the failing authorize — the recovery baseline. */
  creditedCents: string;
  /** Parsed workflow headers — gates the open on campaign activity. */
  workflow: WorkflowHeaders;
  /**
   * False when the org's saved card can't be charged off_session (auto-reload-
   * blocked country, e.g. India). Routes the T0 email to the `-blocked` template
   * variant whose copy nudges a manual recharge instead of auto-topup.
   */
  autoReloadSupported: boolean;
  /** Forwarded tracking headers for the email-service call. */
  workflowHeaders: Record<string, string>;
  /** Stripe billing email; when null the email-service resolves via x-user-id. */
  recipientEmail?: string | null;
}

/**
 * Open a depletion episode + send the instant T0 email, IFF the org cannot pay
 * for the run this authorize was refusing AND has campaign activity AND has no
 * already-open episode. Returns whether a NEW episode was opened (false = it can
 * spend, no activity, or already open).
 *
 * "Cannot pay" is `lib/spend-block`'s one predicate, so this agrees by
 * construction with the affordability pre-flight that refuses the run — every
 * call site here is on the insufficient branch, which is exactly that refusal.
 */
export async function openDepletionEpisodeIfDepleted(
  params: OpenEpisodeParams
): Promise<{ opened: boolean }> {
  const blocked = cannotSpend(
    params.balanceCents,
    params.requiredCents ?? "0",
    params.thresholdCents ?? "0"
  );
  if (!blocked) return { opened: false };
  if (!hasCampaignActivity(params.workflow)) return { opened: false };

  // The partial unique index `(org_id) WHERE recovered_at IS NULL` is the
  // idempotency + race guard: a second concurrent/sequential open for the same
  // org hits a unique violation (23505), which we treat as "already open".
  // Everything else re-throws (fail loud).
  try {
    await db.insert(creditDepletionEpisodes).values({
      orgId: params.orgId,
      userId: params.userId,
      runId: toUuidOrNull(params.runId),
      campaignId: toUuidOrNull(params.workflow.campaignId),
      creditedCentsAtOpen: params.creditedCents,
      t0SentAt: new Date(),
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { opened: false };
    throw err;
  }

  console.log(
    `[billing-service] credit depletion episode opened for org ${params.orgId} ` +
      `(campaign=${params.workflow.campaignId ?? "n/a"})`
  );

  sendEmail({
    eventType: dunningEventType(DUNNING_EVENT_T0, params.autoReloadSupported),
    orgId: params.orgId,
    userId: params.userId,
    runId: params.runId,
    recipientEmail: params.recipientEmail ?? undefined,
    metadata: {},
    workflowHeaders: params.workflowHeaders,
  });

  return { opened: true };
}

/**
 * The org's OPEN depletion episode, opening one if there is none — the ONE
 * writer for an episode opened outside the authorize path (no request, no end
 * user, no campaign-activity gate). `lib/unpaid-debt` and the blocked-campaign
 * sweep both go through here.
 *
 * The partial unique index `(org_id) WHERE recovered_at IS NULL` is the race
 * guard — a 23505 means someone else just opened it, so we re-read. `opened`
 * is true only for the caller whose INSERT won.
 */
export async function ensureOpenEpisode(
  orgId: string,
  snapshot: BalanceSnapshot,
  opts: { t0SentAt?: Date } = {}
): Promise<{ episode: CreditDepletionEpisode; opened: boolean }> {
  const existing = await selectOpenEpisode(orgId);
  if (existing) return { episode: existing, opened: false };

  try {
    const [row] = await db
      .insert(creditDepletionEpisodes)
      .values({
        orgId,
        userId: PLATFORM_USER_ID,
        creditedCentsAtOpen: snapshot.creditedCents,
        t0SentAt: opts.t0SentAt ?? null,
      })
      .returning();
    return { episode: row, opened: true };
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    const raced = await selectOpenEpisode(orgId);
    if (!raced) throw err;
    return { episode: raced, opened: false };
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
 * Open a depletion episode for an org the affordability pre-flight is refusing,
 * and send it the instant T0 — the path the authorize route can never take for
 * a WEDGED org, because campaign-service stops dispatching before authorize is
 * ever reached (see lib/campaign-reload-sweep).
 *
 * Idempotent through the same partial unique index `(org_id) WHERE recovered_at
 * IS NULL` the authorize opener relies on, so the hourly sweep re-examining the
 * same org every tick opens one episode and mails once.
 *
 * WHY T0 IS SENT HERE, AND WHEN IT IS NOT. The episode exists to tell a customer
 * their campaigns stopped, and for a wedged org they HAVE stopped — for days,
 * silently. Opening the state without the message would fix the staff surfaces
 * and leave the customer exactly as uninformed as the bug left them. Two things
 * keep it honest, and both live in the caller: the sweep reaches this only AFTER
 * failing to unblock the org itself (an org whose card is charged successfully
 * is never told it ran out of credit), and it passes `sendT0: false` when it has
 * ALREADY mailed that org on this tick — a declining card gets one message, not
 * "we could not charge your card" followed seconds later by "you are out of
 * credit". The episode still opens either way, so the +3d / +10d ladder and
 * every staff surface pick the org up regardless.
 *
 * No campaign-activity gate: the sweep carries no request headers, and the org
 * being refused on a stored campaign estimate IS the campaign activity. Unlike
 * lib/unpaid-debt's `ensureOpenEpisode` this one DOES send T0 — that path
 * describes a different thing (a debt we cannot collect) with its own message.
 */
export async function openBlockedCampaignEpisode(params: {
  orgId: string;
  snapshot: BalanceSnapshot;
  /** False when the caller has already mailed this org on this tick. */
  sendT0?: boolean;
}): Promise<{ opened: boolean }> {
  const sendT0 = params.sendT0 ?? true;
  // Marked sent when we suppress it too: the marker claims the stage, and the
  // stage is genuinely spent — the customer WAS told, by the message the caller
  // had just sent about the same failure.
  const { opened } = await ensureOpenEpisode(params.orgId, params.snapshot, {
    t0SentAt: new Date(),
  });
  if (!opened) return { opened: false };

  console.warn(
    `[billing-service] credit depletion episode opened for org ${params.orgId} ` +
      `— its campaigns are refused by the affordability pre-flight and it could ` +
      `not be reloaded (balance=${params.snapshot.balanceCents})`
  );

  // A send with no end user behind it needs a run that ALREADY EXISTS in
  // runs-service: the email service records the mail as a CHILD of the id we
  // pass, so a minted uuid answers 200 with `sent: false` and the mail is
  // dropped in silence. The episode still opened — the customer is told by the
  // +3d follow-up, which opens its own run.
  if (!sendT0) return { opened: true };

  const runId = await createPlatformRun("blocked-campaign-depletion");
  if (!runId) {
    console.error(
      `[billing-service] blocked-campaign episode for org ${params.orgId}: ` +
        `no platform run, T0 not sent`
    );
    return { opened: true };
  }

  sendEmail({
    eventType: dunningEventType(
      DUNNING_EVENT_T0,
      params.snapshot.autoReloadSupported
    ),
    orgId: params.orgId,
    userId: PLATFORM_USER_ID,
    runId,
    recipientEmail: params.snapshot.customer.email ?? undefined,
    metadata: {},
  });
  await completePlatformRun(runId);

  return { opened: true };
}

export interface DunningTickResult {
  processed: number;
  recovered: number;
  followup3dSent: number;
  followup10dSent: number;
}

/**
 * Process every open depletion episode once. Restored balances close their
 * episode (no email); still-depleted episodes get their due +3d / +10d
 * follow-ups. A per-episode balance-recompute failure is logged and skipped
 * (retried next tick) — one unreachable org never blocks the others.
 */
export async function runDunningTick(): Promise<DunningTickResult> {
  const open = await db
    .select()
    .from(creditDepletionEpisodes)
    .where(isNull(creditDepletionEpisodes.recoveredAt));

  const result: DunningTickResult = {
    processed: 0,
    recovered: 0,
    followup3dSent: 0,
    followup10dSent: 0,
  };
  const now = Date.now();

  for (const ep of open) {
    result.processed += 1;

    let snapshot;
    try {
      snapshot = await computeBalance(ep.orgId);
    } catch (err) {
      console.error(
        `[billing-service] dunning tick: balance recompute failed for org ${ep.orgId}, ` +
          `will retry next tick:`,
        err
      );
      continue;
    }

    // Recovery is keyed on a REAL recharge — `credited` rising above its
    // snapshot at depletion — NOT on balance > 0. Balance flutters around zero
    // from provisioned-cost churn (usage includes provisioned holds); a
    // balance-based recovery false-closed episodes and re-armed a fresh T0 email
    // on every oscillation (duplicate "out of credit" emails). `credited` only
    // rises on a paid topup / promo, so it never flutters.
    const creditedAtOpen = ep.creditedCentsAtOpen;
    if (creditedAtOpen == null) {
      // Row opened before migration 0020 — no baseline yet. Capture it from the
      // current credited and treat this tick as neither recovery nor a missed
      // send (we have no pre-depletion reference). Follow-ups below still fire
      // if due AND still depleted.
      await db
        .update(creditDepletionEpisodes)
        .set({ creditedCentsAtOpen: snapshot.creditedCents, updatedAt: new Date() })
        .where(eq(creditDepletionEpisodes.id, ep.id));
    } else if (cmpCents(snapshot.creditedCents, creditedAtOpen) > 0) {
      // Real recharge → close the episode, send nothing (stop-on-recharge).
      const [closed] = await db
        .update(creditDepletionEpisodes)
        .set({ recoveredAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(creditDepletionEpisodes.id, ep.id),
            isNull(creditDepletionEpisodes.recoveredAt)
          )
        )
        .returning();
      if (closed) {
        result.recovered += 1;
        console.log(
          `[billing-service] dunning: org ${ep.orgId} recovered (credited ${creditedAtOpen} → ${snapshot.creditedCents}), episode closed`
        );
      }
      continue;
    }

    // No recharge. Only dun while the org STILL cannot spend — the same verdict
    // that opens an episode, so the two can never disagree (lib/spend-block).
    //
    // This gate used to compare the balance against a hardcoded "0", which made
    // every postpaid org running normally negative within its credit line read
    // as depleted. That was invisible only because the OPEN gate was narrower
    // than this one; widening the open gate without reconciling this one would
    // have started mailing "you are out of credit" to orgs paying us perfectly
    // well. A transient recovery (provisioned holds released, a reload landing)
    // sends nothing and leaves the episode open to re-evaluate next tick.
    const { blocked } = await resolveSpendBlock(ep.orgId, snapshot);
    if (!blocked) continue;

    const ageMs = now - ep.startedAt.getTime();
    const recipientEmail = snapshot.customer.email ?? undefined;

    // The follow-ups run on a scheduler tick, so there is no request run to
    // borrow when the episode was opened without one. A minted UUID is NOT a
    // usable substitute: transactional-email-service hangs its send off this id
    // as a child run, so runs-service rejects a parent that does not exist and
    // the send is dropped with `{sent: false, reason: "Run creation failed…"}` —
    // silently, because the send is fire-and-forget. Open a real platform run
    // instead, and skip the episode this tick if we cannot (the stage markers
    // are claimed below, so an unsent stage stays due and retries next tick).
    const runId = ep.runId ?? (await createPlatformRun("dunning-followup"));
    if (!runId) {
      console.error(
        `[billing-service] dunning tick: no run available for org ${ep.orgId}, ` +
          `follow-ups deferred to the next tick`
      );
      continue;
    }

    // Stages are independent: if the scheduler was down past both windows,
    // each unsent due stage still fires (at most once each, via atomic claim).
    if (ageMs >= FOLLOWUP_3D_MS && ep.followup3dSentAt == null) {
      const [claimed] = await db
        .update(creditDepletionEpisodes)
        .set({ followup3dSentAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(creditDepletionEpisodes.id, ep.id),
            isNull(creditDepletionEpisodes.followup3dSentAt)
          )
        )
        .returning();
      if (claimed) {
        result.followup3dSent += 1;
        sendEmail({
          eventType: dunningEventType(DUNNING_EVENT_3D, snapshot.autoReloadSupported),
          orgId: ep.orgId,
          userId: ep.userId,
          runId,
          recipientEmail,
          metadata: {},
        });
      }
    }

    if (ageMs >= FOLLOWUP_10D_MS && ep.followup10dSentAt == null) {
      const [claimed] = await db
        .update(creditDepletionEpisodes)
        .set({ followup10dSentAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(creditDepletionEpisodes.id, ep.id),
            isNull(creditDepletionEpisodes.followup10dSentAt)
          )
        )
        .returning();
      if (claimed) {
        result.followup10dSent += 1;
        sendEmail({
          eventType: dunningEventType(DUNNING_EVENT_10D, snapshot.autoReloadSupported),
          orgId: ep.orgId,
          userId: ep.userId,
          runId,
          recipientEmail,
          metadata: {},
        });
      }
    }
  }

  return result;
}
