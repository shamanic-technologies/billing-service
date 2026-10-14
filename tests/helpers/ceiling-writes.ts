/**
 * Writes onto the per-campaign ceiling store, for suites that need ceilings as
 * FIXTURES. The customer write routes (PUT /v1/brands/:id/campaign-budget, the
 * offer-level /v1 .../campaign-budgets) were retired on 2026-10-14: a campaign's
 * money is its sales funnel caps. The store itself is still read by the internal
 * routes until its last reader moves off, so suites still need to put rows in it.
 *
 * Each helper calls the lib the retired route called and answers { status, body }
 * in the route's old shape, so a suite's assertions read the same. Delete this
 * file together with the store.
 */
import {
  CeilingBelowMinimumError,
  ChannelTermsUnavailableError,
  InvalidCeilingError,
  SourcingHasItsOwnCampaignError,
  UnknownAcquisitionChannelError,
  campaignTotalsOf,
  parseCampaignKey,
  setCampaignDailyBudget,
} from "../../src/lib/campaign-budgets.js";
import { InvalidSourcingCeilingError } from "../../src/lib/campaign-sourcing.js";
import { SalesPathTermsUnavailableError } from "../../src/lib/sales-path-terms.js";
import {
  ItemBudgetRefused,
  getOfferItemsView,
  removeOfferItem,
  setOfferItems,
  type ItemInput,
} from "../../src/lib/campaign-items.js";
import type { ItemPeriod } from "../../src/lib/campaign-items-store.js";
import { notifyBrandDailyBudgetChanged } from "../../src/lib/brand-budget-notification.js";
import { brandGrainChange, ceilingChangesBetween } from "../../src/lib/brand-running-budget.js";
import { addCents, parseNonNegativeCents } from "../../src/lib/cents.js";

export interface WriteResult {
  status: number;
  body: any;
}

function ceilingError(err: unknown): WriteResult {
  if (
    err instanceof CeilingBelowMinimumError ||
    err instanceof UnknownAcquisitionChannelError ||
    err instanceof InvalidCeilingError ||
    err instanceof InvalidSourcingCeilingError
  ) {
    return { status: 400, body: { error: err.message } };
  }
  if (err instanceof ChannelTermsUnavailableError || err instanceof SalesPathTermsUnavailableError) {
    return { status: 502, body: { error: err.message } };
  }
  if (err instanceof SourcingHasItsOwnCampaignError) {
    return {
      status: 409,
      body: { error: err.message, code: "sourcing_has_its_own_campaign", sourceFeatureSlugs: err.sourceFeatureSlugs },
    };
  }
  throw err;
}

function itemError(err: unknown): WriteResult {
  if (err instanceof ItemBudgetRefused) {
    return { status: err.status, body: { error: err.message, code: err.code, ...err.details } };
  }
  throw err;
}

export interface Actor {
  userId?: string;
  runId?: string;
  email?: string | null;
}

/** One campaign's daily ceiling (offer x leg x channel), as the retired PUT stated it. */
export async function writeCampaignCeiling(
  orgId: string,
  brandId: string,
  body: {
    offerId?: unknown;
    legKey?: unknown;
    featureSlug?: unknown;
    dailyBudgetCents?: string | number;
    outreachDailyBudgetCents?: string | number;
    sourcingCeilingCents?: string | number | null;
  },
  actor: Actor = {}
): Promise<WriteResult> {
  let written;
  let key;
  try {
    key = parseCampaignKey(body);
    let dailyBudgetCents: unknown = body.dailyBudgetCents;
    if (dailyBudgetCents === undefined) {
      try {
        dailyBudgetCents = addCents(
          parseNonNegativeCents(body.outreachDailyBudgetCents),
          parseNonNegativeCents(body.sourcingCeilingCents)
        );
      } catch (err) {
        throw new InvalidCeilingError((err as Error).message);
      }
    }
    written = await setCampaignDailyBudget(orgId, brandId, key, dailyBudgetCents, {
      sourcingCeilingCents: body.sourcingCeilingCents,
    });
  } catch (err) {
    return ceilingError(err);
  }
  const changes = ceilingChangesBetween(written.previousCeilings, written.ceilings);
  if (written.previousCeilings.length === 0 && written.previousBrandDailyBudgetCents !== null) {
    changes.push(...brandGrainChange(written.previousBrandDailyBudgetCents, "0"));
  }
  void notifyBrandDailyBudgetChanged({
    orgId,
    userId: actor.userId as string,
    runId: actor.runId as string,
    brandId,
    previousDailyBudgetCents: written.previousBrandDailyBudgetCents,
    newDailyBudgetCents: written.brandDailyBudgetCents,
    changes,
    ceilings: written.ceilings,
    actingEmail: actor.email ?? null,
  });
  return {
    status: 200,
    body: {
      brandId,
      orgId,
      ...key,
      dailyBudgetCents: written.campaign.dailyBudgetCents,
      outreachDailyBudgetCents: written.campaign.outreachDailyBudgetCents,
      sourcingCeilingCents: written.campaign.sourcingCeilingCents,
      split: written.campaign.split,
      updatedAt: written.campaign.updatedAt.toISOString(),
      brandDailyBudgetCents: written.brandDailyBudgetCents,
      campaigns: campaignTotalsOf(written.ceilings).map((c) => ({ ...c, updatedAt: c.updatedAt.toISOString() })),
    },
  };
}

/** One offer's campaign budgets (lib/campaign-items), as the retired PUT stated them. */
export async function writeOfferItems(
  orgId: string,
  brandId: string,
  offerId: string,
  body: { items: ItemInput[]; period?: ItemPeriod },
  actor: Actor = {}
): Promise<WriteResult> {
  try {
    const result = await setOfferItems({ orgId, brandId, offerId, items: body.items, period: body.period });
    void notifyBrandDailyBudgetChanged({
      orgId,
      userId: actor.userId as string,
      runId: actor.runId as string,
      brandId: brandId.toLowerCase(),
      previousDailyBudgetCents: result.previousBrandDailyBudgetCents,
      newDailyBudgetCents: result.brandDailyBudgetCents,
      changes: ceilingChangesBetween(result.previousCeilings, result.ceilings),
      ceilings: result.ceilings,
      actingEmail: actor.email ?? null,
    });
    return {
      status: 200,
      body: {
        orgId,
        ...(await getOfferItemsView(orgId, brandId.toLowerCase(), offerId.toLowerCase(), [])),
        reactiveChargedCents: result.reactiveChargedCents,
        globalBudgetCleared: result.globalBudgetCleared,
      },
    };
  } catch (err) {
    return itemError(err);
  }
}

/** Back to "not set" for one campaign of an offer, as the retired DELETE did. */
export async function removeOfferItemBudget(
  orgId: string,
  brandId: string,
  offerId: string,
  featureSlug: string,
  legKey: string
): Promise<WriteResult> {
  try {
    const removed = await removeOfferItem({
      orgId,
      brandId: brandId.toLowerCase(),
      offerId: offerId.toLowerCase(),
      featureSlug,
      legKey,
    });
    return {
      status: 200,
      body: { orgId, ...(await getOfferItemsView(orgId, brandId.toLowerCase(), offerId.toLowerCase(), [])), removed },
    };
  } catch (err) {
    return itemError(err);
  }
}
