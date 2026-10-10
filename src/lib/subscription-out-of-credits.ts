/**
 * OUT OF CREDITS, subscription orgs (owner 2026-10-10, philadelphia-v2 relay).
 *
 * A subscription org spends only the credit its plan bought (floor 0, never
 * reloaded, lib/dunning keeps it out of the generic out-of-credit dunning). When
 * that credit runs out mid-period its campaigns stop. This tells the customer at
 * once, lists what stopped (reactive first, then proactive) and offers ONE button:
 * upgrade, which charges the new amount today and restarts the cycle today
 * (lib/subscription `startSubscriptionNow`, PATCH ... start_now: true). This
 * replaces, for subscription orgs, the 2026-10-06 deletion of the "credits used"
 * mail; the eventType keeps its name (`subscription-credits-used`) because
 * postmark-service already bills it to the platform (PLATFORM_LIFECYCLE_TAGS): a
 * mail about running out of credit must never be refused for lack of credit.
 *
 * "Out of credit" = lib/spend-block's one predicate (the org cannot pay for its
 * hungriest campaign's next run), the same verdict that refuses its campaigns.
 * Not when sending already stopped for another reason (paused, cancel pending).
 *
 * Once per RUN-OUT EPISODE = once per period of the org's primary plan, claimed on
 * `subscriptions.credits_used_notified_period_start` by a conditional UPDATE … WHERE
 * < current_period_start RETURNING. An upgrade restarts the period, so a later
 * run-out is a new episode. Claimed only AFTER the campaign list, the recipient and
 * a real platform run resolve: anything unresolved leaves it unclaimed and the next
 * check retries. Nothing ongoing = nothing stopped = no mail, no claim.
 *
 * Who decides what: campaign-service lists the org's sales funnel campaigns (name,
 * status), features-service serves each funnel's type (reactive | proactive).
 * Billing reconstructs neither. A funnel whose type cannot be read is listed apart,
 * never guessed.
 *
 * Triggers: a 5-minute watcher over live subscription orgs (first check a minute
 * after boot), and fire-and-forget from the refused-authorize / blocked-campaign
 * paths in lib/dunning. Fail-soft: never throws, nothing here touches money.
 */
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { PLATFORM_USER_ID, subscriptions } from "../db/schema.js";
import { computeBalance } from "./balance.js";
import { resolveSpendBlock } from "./spend-block.js";
import { getLiveSubscription, getOrgSendingStopped } from "./subscription.js";
import { fetchSalesFunnelCampaigns } from "./funnel-campaigns.js";
import { getSalesFunnel } from "./sales-funnel-catalogue.js";
import { fetchOrgCustomerOrNull } from "./stripe-service-client.js";
import { fetchBrandName, fetchOfferNames, fetchOrgIdentity } from "./budget-change-context.js";
import { createPlatformRun, completePlatformRun } from "./runs-client.js";
import { sendEmail } from "./email-client.js";
import { DASHBOARD_URL } from "./subscription-email-format.js";
import { composeOutOfCreditsEmail, type StoppedCampaign } from "./subscription-out-of-credits-email.js";

/** Kept from the deleted "credits used" mail: postmark-service bills it to the platform. */
export const SUBSCRIPTION_OUT_OF_CREDITS_EVENT = "subscription-credits-used";

/** The dashboard page where the plan amount is changed. */
export function upgradeUrl(clerkOrgId: string | null, brandId: string | null): string {
  if (!clerkOrgId) return DASHBOARD_URL;
  if (!brandId) return `${DASHBOARD_URL}/v2/orgs/${clerkOrgId}`;
  return `${DASHBOARD_URL}/v2/orgs/${clerkOrgId}/brands/${brandId}/billing`;
}

export type OutOfCreditsOutcome =
  | "sent"
  | "not_subscription"
  | "sending_stopped"
  | "already_notified"
  | "has_credit"
  | "nothing_running"
  | "unresolved"
  | "lost_claim"
  | "failed";

/** The stopped campaigns, named by campaign-service, typed by features-service. */
async function stoppedCampaigns(orgId: string): Promise<{ campaigns: StoppedCampaign[]; brandId: string | null } | null> {
  const answer = await fetchSalesFunnelCampaigns(orgId);
  if (!answer.ok) return null;
  const ongoing = answer.campaigns.filter((c) => c.status === "ongoing");
  if (ongoing.length === 0) return { campaigns: [], brandId: null };

  const kinds = new Map<string, StoppedCampaign["kind"]>();
  await Promise.all(
    [...new Set(ongoing.map((c) => c.salesFunnelId))].map(async (id) => {
      try {
        kinds.set(id, (await getSalesFunnel(id)).type);
      } catch (err) {
        console.error(`[billing-service] out-of-credits: funnel ${id} type unreadable (listed apart):`, err);
        kinds.set(id, null);
      }
    })
  );

  // A name shared by two of the org's campaigns (one per offer) carries its offer.
  const counts = new Map<string, number>();
  for (const c of ongoing) {
    const n = c.salesFunnelName ?? "";
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const offerNames = new Map<string, Map<string, string> | null>();
  for (const brandId of new Set(ongoing.map((c) => c.brandId))) {
    offerNames.set(brandId, await fetchOfferNames(orgId, brandId));
  }
  const campaigns = ongoing.map((c) => {
    const base = c.salesFunnelName?.trim() || "Unnamed campaign";
    const offer = offerNames.get(c.brandId)?.get(c.offerId.toLowerCase());
    const name = (counts.get(c.salesFunnelName ?? "") ?? 0) > 1 && offer ? `${base} (${offer})` : base;
    return { name, kind: kinds.get(c.salesFunnelId) ?? null };
  });
  return { campaigns, brandId: ongoing[0].brandId };
}

/** Tell a subscription org it ran out of credit, once per period. Never throws. */
export async function notifySubscriptionOutOfCreditsIfDue(orgId: string): Promise<OutOfCreditsOutcome> {
  try {
    const sub = await getLiveSubscription(orgId);
    if (!sub || (sub.status !== "trialing" && sub.status !== "active")) return "not_subscription";
    if (sub.pausedAt || sub.cancelAtPeriodEnd || (await getOrgSendingStopped(orgId))) return "sending_stopped";
    if (
      sub.creditsUsedNotifiedPeriodStart &&
      sub.creditsUsedNotifiedPeriodStart.getTime() >= sub.currentPeriodStart.getTime()
    ) {
      return "already_notified";
    }

    const block = await resolveSpendBlock(orgId, await computeBalance(orgId));
    if (!block.blocked) return "has_credit";

    const stopped = await stoppedCampaigns(orgId);
    if (!stopped) {
      console.warn(`[billing-service] out-of-credits for org ${orgId}: campaigns unreadable, retried`);
      return "unresolved";
    }
    if (stopped.campaigns.length === 0) return "nothing_running";

    const customer = await fetchOrgCustomerOrNull(orgId);
    const recipientEmail = customer?.email ?? null;
    if (!recipientEmail && !sub.startedByUserId) {
      console.warn(`[billing-service] out-of-credits: org ${orgId} has no recipient`);
      return "unresolved";
    }
    const runId = await createPlatformRun("subscription-out-of-credits");
    if (!runId) {
      console.error(`[billing-service] out-of-credits for org ${orgId}: no platform run, retried`);
      return "unresolved";
    }

    const claimed = await db
      .update(subscriptions)
      .set({ creditsUsedNotifiedPeriodStart: sub.currentPeriodStart })
      .where(
        and(
          eq(subscriptions.id, sub.id),
          ne(subscriptions.status, "canceled"),
          or(
            isNull(subscriptions.creditsUsedNotifiedPeriodStart),
            lt(subscriptions.creditsUsedNotifiedPeriodStart, sub.currentPeriodStart)
          )
        )
      )
      .returning({ id: subscriptions.id });
    if (claimed.length === 0) {
      await completePlatformRun(runId);
      return "lost_claim";
    }

    const brandId = sub.brandId ?? stopped.brandId;
    const [identity, brandName] = await Promise.all([
      fetchOrgIdentity(orgId),
      brandId ? fetchBrandName(orgId, brandId) : Promise.resolve(null),
    ]);
    const email = composeOutOfCreditsEmail({
      campaigns: stopped.campaigns,
      brandName,
      trialing: sub.status === "trialing",
      monthlyAmountCents: sub.monthlyAmountCents,
      ctaUrl: upgradeUrl(identity?.externalId ?? null, brandId),
    });
    sendEmail({
      eventType: SUBSCRIPTION_OUT_OF_CREDITS_EVENT,
      orgId,
      userId: sub.startedByUserId ?? PLATFORM_USER_ID,
      runId,
      recipientEmail,
      metadata: { ...email },
    });
    await completePlatformRun(runId);
    console.log(
      `[billing-service] out-of-credits email sent for org ${orgId} (period ${sub.currentPeriodStart.toISOString()}, ${stopped.campaigns.length} campaigns)`
    );
    return "sent";
  } catch (err) {
    console.error(`[billing-service] out-of-credits notification failed for org ${orgId}:`, err);
    return "failed";
  }
}

/** Every org with a plan that has not ended, checked once. */
export async function runSubscriptionOutOfCreditsCheck(): Promise<{ checked: number; sent: number }> {
  const rows = await db
    .selectDistinct({ orgId: subscriptions.orgId })
    .from(subscriptions)
    .where(ne(subscriptions.status, "canceled"));
  let sent = 0;
  for (const { orgId } of rows) {
    if ((await notifySubscriptionOutOfCreditsIfDue(orgId)) === "sent") sent += 1;
  }
  return { checked: rows.length, sent };
}

export const OUT_OF_CREDITS_CHECK_MS = 5 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let running = false;

/** In-process 5-minute watcher, first check a minute after boot. One check at a time. */
export function startSubscriptionOutOfCreditsWatcher(): void {
  const tick = async () => {
    if (!running) {
      running = true;
      try {
        const r = await runSubscriptionOutOfCreditsCheck();
        if (r.sent > 0) console.log(`[billing-service] out-of-credits check: checked=${r.checked} sent=${r.sent}`);
      } catch (err) {
        console.error("[billing-service] out-of-credits check failed:", err);
      } finally {
        running = false;
      }
    }
    timer = setTimeout(tick, OUT_OF_CREDITS_CHECK_MS);
  };
  timer = setTimeout(tick, FIRST_CHECK_MS);
}

export function stopSubscriptionOutOfCreditsWatcher(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
