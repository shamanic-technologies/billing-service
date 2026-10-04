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
  /** Decision-makers lined up in the window (lead grain), sent or still queued. */
  recipientsCount: number | null;
  /** Decision-makers who got at least one email in the window (features-service #1301; null on an older one). */
  recipientsEmailedCount: number | null;
  /**
   * features-service's verdict: did anything actually go out (`emails_sent`), or is
   * it only lined up (`lined_up_not_sent`)? null on a features-service older than #1301.
   */
  sendStatus: "emails_sent" | "lined_up_not_sent" | "nothing_sent" | null;
  deliveryRatePct: number | null;
  expectedPositiveReplies: number | null;
  expectedRoiMultiple: number | null;
  /** The lifetime revenue per client (USD) the return is based on. */
  lifetimeRevenueUsd: number | null;
  /** Where it was read: the customer's own offer (`offer_stated`) or brand economics. null when unknown. */
  lifetimeRevenueSource: "offer_stated" | "brand_economics" | null;
  /** Revenue multiple at current results if the plan is raised by $100/month. */
  raiseRevenueMultiple: number | null;
  /** Extra revenue (USD) at current results if the plan is raised by $100/month. */
  raiseAdditionalRevenueUsd: number | null;
  /** Extra positive replies at current results if the plan is raised by $100/month. */
  raiseAdditionalPositiveReplies: number | null;
}

/** The wire fields billing reads (features-service `OrgPeriodRecapResponse`). */
interface PeriodRecapWire {
  outbound?: {
    emailsSent?: number;
    recipientsContacted?: number;
    recipientsEnrolled?: number;
    recipientsEmailed?: number;
    sendStatus?: string;
    deliveryRatePct?: number | null;
  };
  expectedPositiveReplies?: number | null;
  expectedReturn?: {
    roiMultiple?: number | null;
    lifetimeRevenuePerClientUsd?: number | null;
    lifetimeRevenueSource?: string | null;
  };
  budgetIncrease?: {
    revenueMultiple?: number | null;
    expectedAdditionalRevenueUsd?: number | null;
    expectedAdditionalPositiveReplies?: number | null;
  };
}

const READ_TIMEOUT_MS = 15_000;

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sendStatus(v: unknown): SubscriptionRecap["sendStatus"] {
  return v === "emails_sent" || v === "lined_up_not_sent" || v === "nothing_sent" ? v : null;
}

/** Pure mapping, exported so the wire contract is pinned by a test. */
export function toSubscriptionRecap(w: PeriodRecapWire): SubscriptionRecap {
  return {
    sentCount: num(w.outbound?.emailsSent),
    recipientsCount: num(w.outbound?.recipientsEnrolled ?? w.outbound?.recipientsContacted),
    recipientsEmailedCount: num(w.outbound?.recipientsEmailed),
    sendStatus: sendStatus(w.outbound?.sendStatus),
    deliveryRatePct: num(w.outbound?.deliveryRatePct),
    expectedPositiveReplies: num(w.expectedPositiveReplies),
    expectedRoiMultiple: num(w.expectedReturn?.roiMultiple),
    lifetimeRevenueUsd: num(w.expectedReturn?.lifetimeRevenuePerClientUsd),
    lifetimeRevenueSource:
      w.expectedReturn?.lifetimeRevenueSource === "offer_stated" ||
      w.expectedReturn?.lifetimeRevenueSource === "brand_economics"
        ? w.expectedReturn.lifetimeRevenueSource
        : null,
    raiseRevenueMultiple: num(w.budgetIncrease?.revenueMultiple),
    raiseAdditionalRevenueUsd: num(w.budgetIncrease?.expectedAdditionalRevenueUsd),
    raiseAdditionalPositiveReplies: num(w.budgetIncrease?.expectedAdditionalPositiveReplies),
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
