/**
 * Out-of-credit dunning engine (issue #147).
 *
 * Two entry points:
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

import crypto from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  creditDepletionEpisodes,
  DUNNING_EVENT_T0,
  DUNNING_EVENT_3D,
  DUNNING_EVENT_10D,
  DUNNING_EVENT_T0_BLOCKED,
  DUNNING_EVENT_3D_BLOCKED,
  DUNNING_EVENT_10D_BLOCKED,
} from "../db/schema.js";
import { isDepleted, cmpCents } from "./cents.js";
import { computeBalance } from "./balance.js";
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
 * Open a depletion episode + send the instant T0 email, IFF the org is depleted
 * AND has campaign activity AND has no already-open episode. Returns whether a
 * NEW episode was opened (false = not depleted, no activity, or already open).
 */
export async function openDepletionEpisodeIfDepleted(
  params: OpenEpisodeParams
): Promise<{ opened: boolean }> {
  if (!isDepleted(params.balanceCents)) return { opened: false };
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

    // No recharge. Only dun while ACTUALLY depleted right now — a transient
    // positive balance (provisioned holds released) sends nothing and leaves the
    // episode open to re-evaluate next tick (no false recovery, no re-arm).
    if (!isDepleted(snapshot.balanceCents)) continue;

    const ageMs = now - ep.startedAt.getTime();
    const recipientEmail = snapshot.customer.email ?? undefined;
    const runId = ep.runId ?? crypto.randomUUID();

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
