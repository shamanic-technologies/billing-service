/**
 * MONTHLY LIMIT: a SPEND cap (owner 2026-10-12, inverted 2026-10-21, migration 0085).
 *
 * Owner 2026-10-12: « savoir que whatever happens il ne depensera jamais plus que
 * tant ». Owner 2026-10-21: « LE BILLING EST LE BILLING!! ON PREND TOUT CE QU'IL Y A
 * À PRENDRE EN FIN DE MOIS, À $50, QUAND IL RETIRE SA CARTE ETC. LE $30 C'EST BILLING
 * SERVICE QUI DOIT BLOQUER LES RUNS POUR S'ASSURER QU'ON NE DÉPENSE JAMAIS PLUS QUE
 * $30 PAR MOIS ».
 *
 * Worked example: limit $30. The org spends $29.90 this month; a run needing $0.20
 * is refused at authorize (spending stops, ONE email "Raise my monthly limit", one
 * owner Telegram line). Its card is still charged what it owes, at the $50 step
 * and/or at month end: NO charge is ever refused by the limit (lib/reload). On the
 * 1st of the next month (UTC) the spend restarts at $0.
 *
 *  - WHAT COUNTS: the org's CAMPAIGN spend this UTC calendar month, committed NET
 *    (runs-service `/v1/stats/costs`, runs started since the 1st, grouped by
 *    campaign; a run with no campaign is the platform's cost and never counts, the
 *    same rule as lib/platform-absorbed). That is the money the org is billed for.
 *  - WHAT IS REFUSED: a campaign spend at authorize (`checkMonthlySpendLimit`)
 *    whose estimate would take the month's spend past the limit. Never a charge.
 *  - CONCURRENCY: the month's spend is measured at most every 10 s per org; spends
 *    granted since that measurement are added, so a burst cannot all fit under the
 *    same room (billing runs one instance, same assumption as lib/reload-coalescer).
 *  - NO LIMIT = NO CHANGE: an org without a row reads one primary-key row.
 *  - Fail loud: a spend that cannot be read THROWS (authorize answers 502).
 *  - `charged_this_period_cents` (card charges this month) is still served, for
 *    information only.
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
import { Decimal } from "decimal.js";
import { fetchOrgCustomerOrNull, listOrgPayments } from "./stripe-service-client.js";
import { readJson } from "./runs-org-read.js";
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

/** The org's campaign spend this UTC month, committed NET, decimal cents. */
export async function spentThisMonthCents(orgId: string, now: Date = new Date()): Promise<string> {
  const { start } = calendarMonthUtc(now);
  const body = await readJson<{ groups?: Array<{ dimensions?: { campaignId?: string | null }; netTotalCostInUsdCents?: string }> }>(
    "/v1/stats/costs",
    orgId,
    new URLSearchParams({ groupBy: "campaignId", startedAfter: start.toISOString() })
  );
  if (!Array.isArray(body.groups)) throw new Error("runs-service /v1/stats/costs returned no groups array");
  let total = new Decimal(0);
  for (const g of body.groups) {
    if (!g.dimensions || !("campaignId" in g.dimensions)) {
      throw new Error("runs-service /v1/stats/costs group has no campaignId dimension");
    }
    if (!g.dimensions.campaignId) continue; // no campaign = the platform's cost
    if (g.netTotalCostInUsdCents == null) {
      throw new Error("runs-service /v1/stats/costs stated no netTotalCostInUsdCents");
    }
    total = total.plus(g.netTotalCostInUsdCents);
  }
  return total.toFixed(10);
}

const SPEND_CACHE_MS = 10_000;
const spendCache = new Map<string, { measuredAt: number; monthStart: number; spentCents: string; grantedCents: Decimal }>();

/** Test hook: forget every cached measurement. */
export function _resetMonthlySpendCache(): void {
  spendCache.clear();
}

export type SpendLimitCheck =
  | { limited: false }
  | { limited: true; allowed: boolean; limitCents: number; spentCents: string };

/**
 * May a campaign spend of `requiredCents` go ahead without this month's spend
 * passing the org's limit? An allowed spend is counted until the next measurement.
 */
export async function checkMonthlySpendLimit(
  orgId: string,
  requiredCents: string,
  now: Date = new Date()
): Promise<SpendLimitCheck> {
  const row = await getMonthlyChargeLimit(orgId);
  if (!row) return { limited: false };
  const monthStart = calendarMonthUtc(now).start.getTime();
  let entry = spendCache.get(orgId);
  if (!entry || entry.monthStart !== monthStart || now.getTime() - entry.measuredAt > SPEND_CACHE_MS) {
    const spentCents = await spentThisMonthCents(orgId, now);
    entry = { measuredAt: now.getTime(), monthStart, spentCents, grantedCents: new Decimal(0) };
    spendCache.set(orgId, entry);
  }
  const spent = new Decimal(entry.spentCents).plus(entry.grantedCents);
  const allowed = spent.plus(requiredCents).lte(row.limitCents);
  if (allowed) entry.grantedCents = entry.grantedCents.plus(requiredCents);
  return { limited: true, allowed, limitCents: row.limitCents, spentCents: spent.toFixed(10) };
}

// --- the refusal: record, tell once ----------------------------------------

/**
 * Record that the limit refused a spend this month (positive evidence for the
 * read), then tell the customer and the owner once. Never throws on the telling.
 * `chargedCents` here is the month's SPEND (whole cents, the column keeps its name).
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
    `[billing-service] monthly limit: refused a ${params.amountCents}-cent spend for org ${params.orgId} ` +
      `(spent ${params.chargedCents} of ${params.limitCents} this month)`
  );
  notifyOwnerBillingEvent({
    orgId: params.orgId,
    emoji: "🧱",
    text: `Monthly limit reached: ${usd(params.chargedCents)} spent of ${usd(params.limitCents)}, campaigns stopped until the 1st`,
    dedupKey: `monthly-limit:${params.orgId}:${start.toISOString().slice(0, 7)}`,
  });
  void notifyMonthlyChargeLimitReached(params.orgId, now).catch((err) =>
    console.error(`[billing-service] monthly limit email for org ${params.orgId} failed:`, err)
  );
}

/** True once the limit refused a spend this month (deleted when the limit changes). */
export async function monthlyLimitReachedThisMonth(orgId: string, now: Date = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ orgId: monthlyChargeLimitRefusals.orgId })
    .from(monthlyChargeLimitRefusals)
    .where(
      and(
        eq(monthlyChargeLimitRefusals.orgId, orgId),
        eq(monthlyChargeLimitRefusals.periodStart, calendarMonthUtc(now).start)
      )
    )
    .limit(1);
  return !!row;
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
    `Your monthly limit is ${usd(params.limitCents)}. Your campaigns spent ${usd(params.chargedCents)} this month.`,
    `We paused them so this month stays within your limit.`,
    `Your campaigns start again on ${longDate(params.resetsAt)}, or right away if you raise your limit.`,
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
  /** Campaign spend this month, committed net, decimal cents (null when no limit is set). */
  spent_this_period_cents: string | null;
  /** True once the limit refused a spend this month: why spending stopped. */
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
      spent_this_period_cents: null,
      remaining_cents: null,
      limit_reached: false,
      limit_reached_at: null,
      refused_amount_cents: null,
      updated_at: null,
    };
  }
  const [charged, spent] = await Promise.all([chargedThisMonthCents(orgId, now), spentThisMonthCents(orgId, now)]);
  const [refusal] = await db
    .select()
    .from(monthlyChargeLimitRefusals)
    .where(and(eq(monthlyChargeLimitRefusals.orgId, orgId), eq(monthlyChargeLimitRefusals.periodStart, start)))
    .limit(1);
  return {
    ...base,
    monthly_charge_limit_cents: limit.limitCents,
    charged_this_period_cents: charged,
    spent_this_period_cents: spent,
    remaining_cents: Math.max(0, Math.floor(new Decimal(limit.limitCents).minus(spent).toNumber())),
    limit_reached: !!refusal,
    limit_reached_at: refusal ? refusal.firstRefusedAt.toISOString() : null,
    refused_amount_cents: refusal ? refusal.refusedAmountCents : null,
    updated_at: limit.updatedAt.toISOString(),
  };
}
