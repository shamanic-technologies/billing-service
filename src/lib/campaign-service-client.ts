/**
 * Read campaign-service's answer to "how much of this brand's configured daily
 * budget is actually attached to a campaign that is running right now".
 *
 * WHY THIS CALL EXISTS. billing-service owns the ceilings and stores no campaign
 * status, so the total it can compute on its own is status-BLIND: it counts a
 * ceiling whose campaign has been stopped for weeks exactly like one whose
 * campaign is sending today. The staff notification on a budget change is read
 * as a business signal (a raise is expansion, a drop is churn), so an
 * overstated figure reads as a bigger expansion than happened and an understated
 * churn as a smaller one.
 *
 * WE DO NOT RE-DERIVE THE JOIN. `GET /brands/:brandId/spendable-budget` already
 * answers exactly this, and its matching rules already handle the two traps this
 * data hits: billing still emits the pre-rename funnel spellings
 * (`reply_meeting`) while campaign-service stores the canonical ones
 * (`sales_meetings_from_conversation`), and production carries ceilings written
 * before offers existed (`offer_id IS NULL`) while every running campaign names
 * an offer. A second copy of that matching in this repo would drift from the
 * first one within a release.
 *
 * NEW EDGE IN THE SERVICE GRAPH. campaign-service's spendable-budget reads
 * billing's own budgets back, so this is billing → campaign-service → billing.
 * It is read-only, it runs AFTER the customer's write has committed, and it is
 * off the request path entirely (the notification is fire-and-forget), so there
 * is no deadlock and no added latency on the write. It must stay that way.
 *
 * FAIL-SOFT, and this is the documented exception to fail-loud — the same
 * posture as `brand-service-client.ts`. A notification must never delay, change
 * or fail the customer's budget write, so every failure path here logs loudly
 * and returns null. The caller then states the configured totals and says the
 * running split was unavailable; it never presents a configured figure AS a
 * running one.
 */

import { fetchWithRetry } from "./fetch-retry.js";

const SPENDABLE_TIMEOUT_MS = 5_000;

/** One stored ceiling, with whether a campaign is standing behind it. */
export interface SpendableBudgetRow {
  funnelKey: string | null;
  featureSlug: string | null;
  offerId: string | null;
  resolvedOfferId: string | null;
  dailyBudgetCents: number;
  running: boolean;
  campaignId: string | null;
  campaignStatus: string | null;
}

/** One campaign of this brand, with the ceiling grain it is attributed to. */
export interface SpendableBudgetCampaign {
  campaignId: string;
  status: string;
  running: boolean;
  funnelKey: string | null;
  featureSlug: string | null;
  offerId: string | null;
  configuredDailyBudgetCents: number;
  runningDailyBudgetCents: number;
}

/**
 * campaign-service's answer. Both totals are SERVED — never recomposed here,
 * for the same reason billing serves every grain of its own ceilings.
 */
export interface SpendableBudget {
  orgId: string;
  brandId: string;
  grain: "offer" | "channel" | "funnel" | "brand" | "none";
  configuredDailyBudgetCents: number;
  runningDailyBudgetCents: number;
  campaigns: SpendableBudgetCampaign[];
  rows: SpendableBudgetRow[];
}

function getCampaignServiceConfig(): { url: string; apiKey: string } | null {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/**
 * Read the configured-vs-running split for one (org, brand).
 *
 * **Never throws.** Returns null when campaign-service is unconfigured,
 * unreachable, slow, or answers anything but a well-formed 200 — the caller
 * degrades explicitly rather than guessing a number.
 */
export async function fetchSpendableBudget(
  orgId: string,
  brandId: string
): Promise<SpendableBudget | null> {
  const config = getCampaignServiceConfig();
  if (!config) {
    console.warn(
      "[billing-service] CAMPAIGN_SERVICE not configured — the budget-change notification will carry no running split"
    );
    return null;
  }

  try {
    const res = await fetchWithRetry(
      `${config.url}/brands/${brandId}/spendable-budget`,
      {
        method: "GET",
        headers: {
          "x-api-key": config.apiKey,
          "x-org-id": orgId,
        },
        signal: AbortSignal.timeout(SPENDABLE_TIMEOUT_MS),
      }
    );

    if (!res.ok) {
      console.error(
        `[billing-service] campaign-service spendable-budget failed for brand=${brandId} org=${orgId}: ${res.status} ${await res.text()}`
      );
      return null;
    }

    const body = (await res.json()) as Partial<SpendableBudget>;
    if (
      typeof body?.runningDailyBudgetCents !== "number" ||
      typeof body?.configuredDailyBudgetCents !== "number"
    ) {
      console.error(
        `[billing-service] campaign-service spendable-budget answered an unusable shape for brand=${brandId} org=${orgId}`
      );
      return null;
    }

    return {
      orgId: body.orgId ?? orgId,
      brandId: body.brandId ?? brandId,
      grain: body.grain ?? "none",
      configuredDailyBudgetCents: body.configuredDailyBudgetCents,
      runningDailyBudgetCents: body.runningDailyBudgetCents,
      campaigns: Array.isArray(body.campaigns) ? body.campaigns : [],
      rows: Array.isArray(body.rows) ? body.rows : [],
    };
  } catch (err) {
    console.error(
      `[billing-service] campaign-service spendable-budget unreachable for brand=${brandId} org=${orgId}:`,
      err
    );
    return null;
  }
}
