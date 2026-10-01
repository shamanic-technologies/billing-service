/**
 * features-service's period recap for one org (`GET /internal/orgs/:orgId/period-recap`)
 * — the figures the "all your outbound went out" email states
 * (lib/subscription-notifications). features-service owns every one of them (they
 * equal what the dashboard shows); billing renders them and computes none.
 *
 * Fail-soft (the documented exception, like every customer email here): a recap
 * that cannot be read is null and the email drops the sentences that needed it.
 * A figure features-service could not establish arrives null and is dropped too.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export interface SubscriptionRecap {
  sentCount: number | null;
  deliveryRatePct: number | null;
  expectedPositiveReplies: number | null;
  expectedRoiMultiple: number | null;
  /** The lifetime revenue per client (USD) the return is based on. */
  lifetimeRevenueUsd: number | null;
  /** Revenue multiple at current results if the plan is raised by $100/month. */
  raiseRevenueMultiple: number | null;
  /** Extra revenue (USD) at current results if the plan is raised by $100/month. */
  raiseAdditionalRevenueUsd: number | null;
}

/** The wire fields billing reads (features-service `OrgPeriodRecapResponse`). */
interface PeriodRecapWire {
  outbound?: { emailsSent?: number; deliveryRatePct?: number | null };
  expectedPositiveReplies?: number | null;
  expectedReturn?: { roiMultiple?: number | null; lifetimeRevenuePerClientUsd?: number | null };
  budgetIncrease?: { revenueMultiple?: number | null; expectedAdditionalRevenueUsd?: number | null };
}

const READ_TIMEOUT_MS = 15_000;

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Pure mapping, exported so the wire contract is pinned by a test. */
export function toSubscriptionRecap(w: PeriodRecapWire): SubscriptionRecap {
  return {
    sentCount: num(w.outbound?.emailsSent),
    deliveryRatePct: num(w.outbound?.deliveryRatePct),
    expectedPositiveReplies: num(w.expectedPositiveReplies),
    expectedRoiMultiple: num(w.expectedReturn?.roiMultiple),
    lifetimeRevenueUsd: num(w.expectedReturn?.lifetimeRevenuePerClientUsd),
    raiseRevenueMultiple: num(w.budgetIncrease?.revenueMultiple),
    raiseAdditionalRevenueUsd: num(w.budgetIncrease?.expectedAdditionalRevenueUsd),
  };
}

export async function fetchSubscriptionRecap(
  orgId: string,
  from: Date,
  to: Date
): Promise<SubscriptionRecap | null> {
  const url = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.warn("[billing-service] FEATURES_SERVICE_URL/API_KEY unset — the credits-used email states no figures");
    return null;
  }
  const path = `/internal/orgs/${encodeURIComponent(orgId)}/period-recap?from=${day(from)}&to=${day(to)}`;
  try {
    const res = await fetchWithRetry(`${url}${path}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[billing-service] features-service ${path} answered ${res.status}: ${await res.text()}`);
      return null;
    }
    return toSubscriptionRecap((await res.json()) as PeriodRecapWire);
  } catch (err) {
    console.error(`[billing-service] features-service period recap failed for org ${orgId}:`, err);
    return null;
  }
}
