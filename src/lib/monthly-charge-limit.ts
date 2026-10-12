/**
 * MONTHLY CHARGE LIMIT (owner 2026-10-12, migration 0084).
 *
 * Owner, verbatim: « je me demande si ca ne serait pas plus rassurant pour un user
 * de mettre un max budget [...] de sorte à savoir que whatever happens il ne
 * depensera jamais plus que tant ». Agreed design: ONE limit per org, everything
 * included, monthly only.
 *
 * Worked example: plan $99, limit $299. Trial end charges $99 (month total $99).
 * Credit runs out, auto-upgrade charges $100 (total $199), again $100 (total $299).
 * Credit runs out again: the next $100 would make $399 > $299, so it is NOT made.
 * Spending stops exactly as when credit is gone, the customer gets ONE email with
 * ONE button to raise the limit, and the owner one Telegram line. On the 1st of the
 * next month (UTC) the total restarts at $0.
 *
 *  - WHAT COUNTS: every card payment of the org in the UTC calendar month, from
 *    stripe-service's acquirer-neutral payments list (`succeeded` AND `pending`:
 *    money in flight is money asked for). Checkout top-ups the customer makes by
 *    hand count toward the total, because the question is "how much was my card
 *    charged". Hand-recorded staff payments (`direct`) are not card charges.
 *    Gross: a later refund does not reopen room this month.
 *  - WHAT IS REFUSED: every AUTOMATIC (off-session) charge. They all go through ONE
 *    primitive, `reloadOffSession` (lib/reload): authorize / usage_apply reloads,
 *    the blocked-campaign sweep, the month-end settle, card-change and payment-mode
 *    settles, the on-demand charge, subscription renewals and first charges, the
 *    auto-upgrade step and the follow-up budget charge. A checkout page the customer
 *    fills in by hand is never refused: they are paying on purpose.
 *  - A charge that would pass the limit is refused WHOLE (never cut down to the
 *    room left), before any acquirer is asked. Its outcome carries `limitReached`,
 *    which every caller treats as "no charge was attempted": no card-refused email,
 *    no retry rung consumed, no out-of-credit dunning (this email replaces it).
 *  - NO LIMIT = NO CHANGE: an org without a row reads one primary-key row and
 *    nothing else; no payments read, no lock, byte-identical behaviour.
 *  - Concurrency: the check and the charge run under a per-org in-process lock
 *    (billing runs one instance, same assumption as lib/reload-coalescer), so two
 *    charges racing cannot both fit under the same room.
 *  - Fail loud: a payments list that cannot be read THROWS out of the primitive,
 *    which every caller already handles as "could not ask" (retried).
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  PLATFORM_USER_ID,
  monthlyChargeLimitRefusals,
  monthlyChargeLimits,
  subscriptions,
  type MonthlyChargeLimit,
} from "../db/schema.js";
import { fetchOrgCustomerOrNull, listOrgPayments } from "./stripe-service-client.js";
import { notifyOwnerBillingEvent, usd } from "./owner-alerts.js";
import { createPlatformRun, completePlatformRun } from "./runs-client.js";
import { sendEmail } from "./email-client.js";
import { DASHBOARD_URL, P, escapeHtml } from "./subscription-email-format.js";
import { fetchOrgIdentity } from "./budget-change-context.js";
import { fetchOrgBrandIdsOldestFirst } from "./subscription-plans.js";

/** failure_code on a refused outcome, and the `code` routes answer with. */
export const MONTHLY_CHARGE_LIMIT_REACHED = "monthly_charge_limit_reached";
/** The customer email (registered in src/instrument.ts, platform-billed by postmark-service). */
export const MONTHLY_CHARGE_LIMIT_REACHED_EVENT = "monthly-charge-limit-reached";
export const MONTHLY_CHARGE_LIMIT_CTA_LABEL = "Raise my monthly limit";
/** The served period name: the UTC calendar month. */
export const MONTHLY_CHARGE_LIMIT_PERIOD = "calendar_month_utc";

export function calendarMonthUtc(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function getMonthlyChargeLimit(orgId: string): Promise<MonthlyChargeLimit | null> {
  const [row] = await db
    .select()
    .from(monthlyChargeLimits)
    .where(eq(monthlyChargeLimits.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/** State or change the limit. A new figure re-opens the month: its refusal row goes. */
export async function setMonthlyChargeLimit(
  orgId: string,
  limitCents: number,
  userId: string | null,
  now: Date = new Date()
): Promise<MonthlyChargeLimit> {
  if (!Number.isInteger(limitCents) || limitCents < 0) {
    throw new Error(`setMonthlyChargeLimit: limitCents must be a non-negative integer, got ${limitCents}`);
  }
  const setBy = userId && userId !== PLATFORM_USER_ID ? userId : null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(monthlyChargeLimits)
      .values({ orgId, limitCents, setByUserId: setBy, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: monthlyChargeLimits.orgId,
        set: { limitCents, setByUserId: setBy, updatedAt: now },
      })
      .returning();
    await tx
      .delete(monthlyChargeLimitRefusals)
      .where(
        and(
          eq(monthlyChargeLimitRefusals.orgId, orgId),
          eq(monthlyChargeLimitRefusals.periodStart, calendarMonthUtc(now).start)
        )
      );
    return row;
  });
}

/** Remove the limit (no limit = today's behaviour). Idempotent: false when there was none. */
export async function clearMonthlyChargeLimit(orgId: string, now: Date = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(monthlyChargeLimits)
      .where(eq(monthlyChargeLimits.orgId, orgId))
      .returning({ orgId: monthlyChargeLimits.orgId });
    await tx
      .delete(monthlyChargeLimitRefusals)
      .where(
        and(
          eq(monthlyChargeLimitRefusals.orgId, orgId),
          eq(monthlyChargeLimitRefusals.periodStart, calendarMonthUtc(now).start)
        )
      );
    return deleted.length > 0;
  });
}

/** Card charges of the org in [monthStart, now]: succeeded + pending, never `direct`. */
export async function chargedThisMonthCents(orgId: string, now: Date = new Date()): Promise<number> {
  const { start } = calendarMonthUtc(now);
  const fromUnix = Math.floor(start.getTime() / 1000);
  const payments = await listOrgPayments(orgId);
  let total = 0;
  for (const p of payments) {
    if (p.acquirer === "direct") continue;
    if (p.status !== "succeeded" && p.status !== "pending") continue;
    if (typeof p.created !== "number" || p.created < fromUnix) continue;
    if (typeof p.amount !== "number" || !Number.isFinite(p.amount)) {
      throw new Error(`[billing-service] payment ${p.id} of org ${orgId} has no numeric amount`);
    }
    total += p.amount;
  }
  return total;
}

export type LimitCheck =
  | { limited: false }
  | { limited: true; allowed: boolean; limitCents: number; chargedCents: number; remainingCents: number };

/** May `amountCents` be charged now without passing the org's limit? */
export async function checkMonthlyChargeLimit(
  orgId: string,
  amountCents: number,
  now: Date = new Date(),
  limit?: MonthlyChargeLimit | null
): Promise<LimitCheck> {
  const row = limit === undefined ? await getMonthlyChargeLimit(orgId) : limit;
  if (!row) return { limited: false };
  const chargedCents = await chargedThisMonthCents(orgId, now);
  const remainingCents = Math.max(0, row.limitCents - chargedCents);
  return {
    limited: true,
    allowed: chargedCents + amountCents <= row.limitCents,
    limitCents: row.limitCents,
    chargedCents,
    remainingCents,
  };
}

// --- per-org lock around check + charge -------------------------------------

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call for this org has settled. */
export async function withOrgChargeLock<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(orgId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(orgId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(orgId) === tail) locks.delete(orgId);
  }
}

// --- the refusal: record, tell once ----------------------------------------

/**
 * Record that the limit refused a charge this month (positive evidence for the
 * read), then tell the customer and the owner once. Never throws on the telling.
 */
export async function recordMonthlyLimitRefusal(params: {
  orgId: string;
  amountCents: number;
  limitCents: number;
  chargedCents: number;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const { start } = calendarMonthUtc(now);
  await db
    .insert(monthlyChargeLimitRefusals)
    .values({
      orgId: params.orgId,
      periodStart: start,
      limitCents: params.limitCents,
      chargedCents: params.chargedCents,
      refusedAmountCents: params.amountCents,
      firstRefusedAt: now,
      lastRefusedAt: now,
    })
    .onConflictDoUpdate({
      target: [monthlyChargeLimitRefusals.orgId, monthlyChargeLimitRefusals.periodStart],
      set: {
        limitCents: params.limitCents,
        chargedCents: params.chargedCents,
        refusedAmountCents: params.amountCents,
        lastRefusedAt: now,
      },
    });
  console.warn(
    `[billing-service] monthly charge limit: refused ${params.amountCents} cents for org ${params.orgId} ` +
      `(charged ${params.chargedCents} of ${params.limitCents} this month)`
  );
  notifyOwnerBillingEvent({
    orgId: params.orgId,
    emoji: "🧱",
    text: `Monthly limit reached: ${usd(params.chargedCents)} charged of ${usd(params.limitCents)}, ${usd(params.amountCents)} not charged`,
    dedupKey: `monthly-limit:${params.orgId}:${start.toISOString().slice(0, 7)}`,
  });
  void notifyMonthlyChargeLimitReached(params.orgId, now).catch((err) =>
    console.error(`[billing-service] monthly limit email for org ${params.orgId} failed:`, err)
  );
}

export interface MonthlyChargeLimitEmail {
  subject: string;
  heading: string;
  bodyHtml: string;
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
}

function longDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** Pure: the one email. Short, plain, one button. */
export function composeMonthlyChargeLimitEmail(params: {
  limitCents: number;
  chargedCents: number;
  refusedAmountCents: number;
  resetsAt: Date;
  ctaUrl: string;
}): MonthlyChargeLimitEmail {
  const heading = "You reached your monthly limit";
  const lines = [
    `Your monthly limit is ${usd(params.limitCents)}. Your card was charged ${usd(params.chargedCents)} this month.`,
    `The next charge would be ${usd(params.refusedAmountCents)}. That would go over your limit, so we did not make it.`,
    `Your campaigns have stopped. They start again on ${longDate(params.resetsAt)}, or right away if you raise your limit.`,
  ];
  const html = [
    `<h1 style="color:#0a0a14;font-size:24px;font-weight:700;letter-spacing:-0.02em;line-height:1.25;margin:0 0 20px;">${escapeHtml(heading)}</h1>`,
    ...lines.map((l) => `<p ${P}>${escapeHtml(l)}</p>`),
    `<p style="margin:0 0 28px;"><a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;background:#2563EB;color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-size:16px;font-weight:600;">${escapeHtml(MONTHLY_CHARGE_LIMIT_CTA_LABEL)}</a></p>`,
    `<p style="color:#3a3d47;font-size:16px;line-height:1.65;margin:0;">Kevin<br />Founder, distribute.you</p>`,
  ];
  const text = [
    heading,
    "",
    ...lines,
    "",
    `${MONTHLY_CHARGE_LIMIT_CTA_LABEL}: ${params.ctaUrl}`,
    "",
    "Kevin",
    "Founder, distribute.you",
    "",
    "--",
    "distribute.you",
    "Revenue made easy.",
  ];
  return {
    subject: heading,
    heading,
    bodyHtml: html.join("\n"),
    bodyText: text.join("\n"),
    ctaLabel: MONTHLY_CHARGE_LIMIT_CTA_LABEL,
    ctaUrl: params.ctaUrl,
  };
}

/** The dashboard billing page, where the limit is raised. */
export function monthlyLimitUrl(clerkOrgId: string | null, brandId: string | null): string {
  if (!clerkOrgId) return DASHBOARD_URL;
  if (!brandId) return `${DASHBOARD_URL}/v2/orgs/${clerkOrgId}`;
  return `${DASHBOARD_URL}/v2/orgs/${clerkOrgId}/brands/${brandId}/billing`;
}

export type LimitEmailOutcome = "sent" | "already_notified" | "no_refusal" | "unresolved" | "lost_claim";

/**
 * Tell the customer once per month. The claim (notified_at) is taken only after
 * the recipient and a real platform run resolve, so anything unresolved is retried
 * on the next refusal. Raising the limit deletes the row, so a later refusal at the
 * new figure is news again.
 */
export async function notifyMonthlyChargeLimitReached(
  orgId: string,
  now: Date = new Date()
): Promise<LimitEmailOutcome> {
  const { start, end } = calendarMonthUtc(now);
  const [refusal] = await db
    .select()
    .from(monthlyChargeLimitRefusals)
    .where(and(eq(monthlyChargeLimitRefusals.orgId, orgId), eq(monthlyChargeLimitRefusals.periodStart, start)))
    .limit(1);
  if (!refusal) return "no_refusal";
  if (refusal.notifiedAt) return "already_notified";

  const customer = await fetchOrgCustomerOrNull(orgId);
  const recipientEmail = customer?.email ?? null;
  const [plan] = await db
    .select({ startedByUserId: subscriptions.startedByUserId })
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .orderBy(subscriptions.createdAt)
    .limit(1);
  const userId = plan?.startedByUserId ?? null;
  if (!recipientEmail && !userId) {
    console.warn(`[billing-service] monthly limit email: org ${orgId} has no recipient (retried on the next refusal)`);
    return "unresolved";
  }
  const runId = await createPlatformRun("monthly-charge-limit-reached");
  if (!runId) {
    console.error(`[billing-service] monthly limit email for org ${orgId}: no platform run (retried on the next refusal)`);
    return "unresolved";
  }
  const claimed = await db
    .update(monthlyChargeLimitRefusals)
    .set({ notifiedAt: now })
    .where(
      and(
        eq(monthlyChargeLimitRefusals.orgId, orgId),
        eq(monthlyChargeLimitRefusals.periodStart, start),
        isNull(monthlyChargeLimitRefusals.notifiedAt)
      )
    )
    .returning({ orgId: monthlyChargeLimitRefusals.orgId });
  if (claimed.length === 0) {
    await completePlatformRun(runId);
    return "lost_claim";
  }

  const [identity, brandIds] = await Promise.all([
    fetchOrgIdentity(orgId).catch(() => null),
    fetchOrgBrandIdsOldestFirst(orgId).catch((err) => {
      console.error(`[billing-service] monthly limit email: brands of org ${orgId} unreadable (link to the org):`, err);
      return [] as string[];
    }),
  ]);
  const email = composeMonthlyChargeLimitEmail({
    limitCents: refusal.limitCents,
    chargedCents: refusal.chargedCents,
    refusedAmountCents: refusal.refusedAmountCents,
    resetsAt: end,
    ctaUrl: monthlyLimitUrl(identity?.externalId ?? null, brandIds[0] ?? null),
  });
  sendEmail({
    eventType: MONTHLY_CHARGE_LIMIT_REACHED_EVENT,
    orgId,
    userId: userId ?? PLATFORM_USER_ID,
    runId,
    recipientEmail,
    metadata: { ...email },
  });
  await completePlatformRun(runId);
  console.log(`[billing-service] monthly limit email sent for org ${orgId} (${start.toISOString().slice(0, 7)})`);
  return "sent";
}

// --- the read ----------------------------------------------------------------

export interface MonthlyChargeLimitState {
  org_id: string;
  monthly_charge_limit_cents: number | null;
  period: typeof MONTHLY_CHARGE_LIMIT_PERIOD;
  period_start: string;
  period_end: string;
  /** Card charges this month (null when no limit is set: not read). */
  charged_this_period_cents: number | null;
  remaining_cents: number | null;
  /** True once the limit refused an automatic charge this month: why spending stopped. */
  limit_reached: boolean;
  limit_reached_at: string | null;
  refused_amount_cents: number | null;
  updated_at: string | null;
}

export async function readMonthlyChargeLimitState(
  orgId: string,
  now: Date = new Date()
): Promise<MonthlyChargeLimitState> {
  const { start, end } = calendarMonthUtc(now);
  const limit = await getMonthlyChargeLimit(orgId);
  const base = {
    org_id: orgId,
    period: MONTHLY_CHARGE_LIMIT_PERIOD,
    period_start: start.toISOString(),
    period_end: end.toISOString(),
  } as const;
  if (!limit) {
    return {
      ...base,
      monthly_charge_limit_cents: null,
      charged_this_period_cents: null,
      remaining_cents: null,
      limit_reached: false,
      limit_reached_at: null,
      refused_amount_cents: null,
      updated_at: null,
    };
  }
  const charged = await chargedThisMonthCents(orgId, now);
  const [refusal] = await db
    .select()
    .from(monthlyChargeLimitRefusals)
    .where(and(eq(monthlyChargeLimitRefusals.orgId, orgId), eq(monthlyChargeLimitRefusals.periodStart, start)))
    .limit(1);
  return {
    ...base,
    monthly_charge_limit_cents: limit.limitCents,
    charged_this_period_cents: charged,
    remaining_cents: Math.max(0, limit.limitCents - charged),
    limit_reached: !!refusal,
    limit_reached_at: refusal ? refusal.firstRefusedAt.toISOString() : null,
    refused_amount_cents: refusal ? refusal.refusedAmountCents : null,
    updated_at: limit.updatedAt.toISOString(),
  };
}
