import type { Request, Response } from "express";
import { Router } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import {
  SetBrandDailyBudgetRequestSchema,
  SetBrandFunnelDailyBudgetRequestSchema,
  SetBrandFunnelDailyBudgetSetRequestSchema,
} from "../schemas.js";
import { parseNonNegativeCents } from "../lib/cents.js";
import {
  getBrandDailyBudget,
  getBrandDailyBudgetHistory,
  upsertBrandDailyBudget,
} from "../lib/brand-budgets.js";
import {
  BrandBudgetManagedByFunnelsError,
  ChannelSplitAcrossOffersError,
  OfferSplitAcrossLegsError,
  FunnelBudgetBelowMinimumError,
  UnknownAcquisitionChannelError,
  FunnelSplitAcrossChannelsError,
  InvalidFunnelSetError,
  aggregateChannelTotals,
  aggregateFunnelTotals,
  aggregateOfferBudget,
  aggregateLegBudget,
  aggregateOfferTotals,
  getBrandFunnelDailyBudgets,
  parseFunnelBudgetSet,
  setBrandFunnelDailyBudgets,
  sumFunnelBudgets,
  type ChannelBudgetTotal,
  type FunnelBudgetTotal,
  type OfferBudgetTotal,
  type ParsedFunnelBudget,
} from "../lib/brand-funnel-budgets.js";
import { notifyBrandDailyBudgetChanged } from "../lib/brand-budget-notification.js";
import type { BrandFunnelDailyBudget } from "../db/schema.js";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve + validate the internal `x-org-id` header on a service-to-service read.
 * Returns null and writes the 400 when it is missing or malformed.
 */
function requireInternalOrgId(req: Request, res: Response): string | null {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    console.error(
      `[billing-service] [billing-400] ${req.method} ${req.path}: missing x-org-id`
    );
    res.status(400).json({ error: "x-org-id header is required" });
    return null;
  }
  if (!UUID_RE.test(orgId)) {
    console.error(
      `[billing-service] [billing-400] ${req.method} ${req.path}: invalid x-org-id="${orgId}" (not a UUID)`
    );
    res.status(400).json({ error: "x-org-id must be a valid UUID" });
    return null;
  }
  return orgId;
}

/**
 * The per-FUNNEL figures — unchanged in shape and meaning for every consumer
 * that reads them today. Each is the SUM of the acquisition channels funding
 * that funnel, so a brand that has never split anything renders byte-identically
 * to what this service served before migration 0036.
 */
function renderFunnels(totals: FunnelBudgetTotal[]) {
  return totals.map((total) => ({
    funnelKey: total.funnelKey,
    dailyBudgetCents: total.dailyBudgetCents,
    updatedAt: total.updatedAt.toISOString(),
  }));
}

/**
 * The finer grain, ADDITIVE: one entry per (funnel, acquisition-channel feature
 * slug). The dashboard and campaign-service move onto it on their own schedule —
 * nothing they read today needs it.
 */
function renderChannels(totals: ChannelBudgetTotal[]) {
  return totals.map((total) => ({
    funnelKey: total.funnelKey,
    featureSlug: total.featureSlug,
    dailyBudgetCents: total.dailyBudgetCents,
    updatedAt: total.updatedAt.toISOString(),
  }));
}

/**
 * The per-OFFER grain, ADDITIVE: one entry per (funnel, acquisition-channel
 * feature, offer). Each is the SUM of the funnel LEGS funding that triple, so a
 * brand that has never stated a leg renders byte-identically to what this
 * service served before migration 0039 - when this WAS the stored grain.
 */
function renderOffers(totals: OfferBudgetTotal[]) {
  return totals.map((total) => ({
    funnelKey: total.funnelKey,
    featureSlug: total.featureSlug,
    offerId: total.offerId,
    dailyBudgetCents: total.dailyBudgetCents,
    updatedAt: total.updatedAt.toISOString(),
  }));
}

/**
 * The STORED grain, ADDITIVE: one entry per (funnel, acquisition-channel
 * feature, offer, LEG) - i.e. one per campaign, since a campaign is
 * (brand, offer, acquisition channel, leg). `offers` above is its per-triple
 * sum, `channels` the per-pair one and `funnels` the per-funnel one, so a
 * consumer that wants any of those figures never has to add these up.
 *
 * `legKey` is features-service's canonical leg id, carried opaque. `null` means
 * the ceiling is not scoped to a leg - every ceiling written before legs existed
 * carries it, and it is a permanent value rather than a placeholder.
 */
function renderLegs(rows: BrandFunnelDailyBudget[]) {
  return rows.map((row) => ({
    funnelKey: row.funnelKey,
    featureSlug: row.featureSlug,
    offerId: row.offerId,
    legKey: row.legKey,
    dailyBudgetCents: row.dailyBudgetCents,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * The per-funnel view of a brand, plus the brand-level total the existing
 * daily-budget read serves. `dailyBudgetCents` is the SUM of the ceilings when
 * the brand is funnel-funded; otherwise it is the brand's own scalar (or null
 * when nothing has ever been set), so this surface can never disagree with
 * GET /internal/brands/:brandId/daily-budget.
 */
async function composeFunnelBudgetsView(orgId: string, brandId: string) {
  const stored = await getBrandFunnelDailyBudgets(orgId, brandId);
  if (stored.length > 0) {
    return {
      dailyBudgetCents: sumFunnelBudgets(stored),
      funnels: renderFunnels(aggregateFunnelTotals(stored)),
      channels: renderChannels(aggregateChannelTotals(stored)),
      offers: renderOffers(aggregateOfferTotals(stored)),
      legs: renderLegs(stored),
    };
  }
  const brandLevel = await getBrandDailyBudget(orgId, brandId);
  return {
    dailyBudgetCents: brandLevel ? brandLevel.dailyBudgetCents : null,
    funnels: [],
    channels: [],
    offers: [],
    legs: [],
  };
}

/**
 * One OFFER's ceiling, for a screen that paces that one proposition: the SUM of
 * the ceilings funding it, plus the same per-funnel and per-(funnel, channel)
 * figures this service already serves, restricted to it. An offer with no
 * ceiling answers null — nothing stated is not a ceiling of zero, and neither is
 * ever derived from the other.
 */
async function composeOfferBudgetView(
  orgId: string,
  brandId: string,
  offerId: string
) {
  const stored = await getBrandFunnelDailyBudgets(orgId, brandId);
  const offer = aggregateOfferBudget(stored, offerId);
  if (!offer) {
    return {
      offerId,
      dailyBudgetCents: null,
      updatedAt: null,
      funnels: [],
      channels: [],
      offers: [],
      legs: [],
    };
  }
  return {
    offerId,
    dailyBudgetCents: offer.dailyBudgetCents,
    updatedAt: offer.updatedAt.toISOString(),
    funnels: renderFunnels(offer.funnels),
    channels: renderChannels(offer.channels),
    offers: renderOffers(offer.offers),
    legs: renderLegs(offer.legs),
  };
}

/**
 * One LEG's ceiling, for the money that paces one campaign: a campaign is
 * (brand, offer, acquisition channel, leg), so this reads the ceiling on the
 * same key the campaign itself is keyed on. The SUM of the ceilings funding it,
 * plus every finer figure this service already serves restricted to it, so a
 * caller never enumerates anything nor adds anything up. A leg with no ceiling
 * answers null - nothing stated is not a ceiling of zero, and neither is ever
 * derived from the other.
 */
async function composeLegBudgetView(
  orgId: string,
  brandId: string,
  legKey: string
) {
  const stored = await getBrandFunnelDailyBudgets(orgId, brandId);
  const leg = aggregateLegBudget(stored, legKey);
  if (!leg) {
    return {
      legKey,
      dailyBudgetCents: null,
      updatedAt: null,
      funnels: [],
      channels: [],
      offers: [],
      legs: [],
    };
  }
  return {
    legKey,
    dailyBudgetCents: leg.dailyBudgetCents,
    updatedAt: leg.updatedAt.toISOString(),
    funnels: renderFunnels(leg.funnels),
    channels: renderChannels(leg.channels),
    offers: renderOffers(leg.offers),
    legs: renderLegs(leg.legs),
  };
}

/** Map a funnel-set validation failure onto its status. Rethrows anything else. */
function respondToFunnelWriteError(err: unknown, res: Response): void {
  if (
    err instanceof FunnelBudgetBelowMinimumError ||
    err instanceof UnknownAcquisitionChannelError ||
    err instanceof InvalidFunnelSetError
  ) {
    res.status(400).json({ error: err.message });
    return;
  }
  // A funnel-grain write against a funnel split across channels: same shape of
  // refusal as a brand-grain write against a funnel-funded brand — the figure
  // the caller is addressing is derived one level down.
  if (
    err instanceof FunnelSplitAcrossChannelsError ||
    err instanceof ChannelSplitAcrossOffersError ||
    err instanceof OfferSplitAcrossLegsError
  ) {
    res.status(409).json({ error: err.message });
    return;
  }
  throw err;
}

/**
 * Apply a validated per-funnel write and answer with the resulting view.
 *
 * Every write reports the brand-level TOTAL to the staff notification, because
 * that total is the number the rest of the fleet reads — a per-funnel change
 * that moved the brand's spend must not show staff a figure no other surface
 * serves. Strictly fire-and-forget, as on the brand-level write.
 *
 * The funded-minimum check runs INSIDE that write (it needs each funnel's own
 * stored ceiling under the write lock, because a sub-minimum ceiling predating
 * the minimum may be kept or raised), so its refusal surfaces here as the same
 * readable 400 the shape validation gives.
 */
async function applyFunnelWrite(
  req: Request,
  res: Response,
  orgId: string,
  brandId: string,
  entries: ParsedFunnelBudget[],
  mode: "replace" | "merge"
): Promise<void> {
  let written;
  try {
    written = await setBrandFunnelDailyBudgets(orgId, brandId, entries, mode);
  } catch (err) {
    respondToFunnelWriteError(err, res);
    return;
  }
  const {
    legs,
    offers,
    channels,
    funnels,
    previousBrandDailyBudgetCents,
    brandDailyBudgetCents,
  } = written;

  console.log(
    `[billing-service] brand funnel budgets ${mode}: brand=${brandId} org=${orgId} total=${brandDailyBudgetCents} funnels=${entries
      .map(
        (e) =>
          `${e.funnelKey}${e.featureSlug ? `/${e.featureSlug}` : ""}${e.offerId ? `/${e.offerId}` : ""}${e.legKey ? `/${e.legKey}` : ""}=${e.dailyBudgetCents}`
      )
      .join(",")}`
  );

  notifyBrandDailyBudgetChanged({
    orgId,
    userId: req.headers["x-user-id"] as string,
    runId: req.headers["x-run-id"] as string,
    brandId,
    previousDailyBudgetCents: previousBrandDailyBudgetCents,
    newDailyBudgetCents: brandDailyBudgetCents,
    actingEmail: (req.headers["x-email"] as string | undefined) ?? null,
  });

  res.json({
    brandId,
    orgId,
    dailyBudgetCents: brandDailyBudgetCents,
    funnels: renderFunnels(funnels),
    channels: renderChannels(channels),
    offers: renderOffers(offers),
    legs: renderLegs(legs),
  });
}

// GET /internal/brands/:brandId/daily-budget — read this org's current daily
// budget for a brand (the per-day spend ceiling for that org+brand).
//
// Auth: x-api-key (service-to-service) + x-org-id. Service callers must send
// the internal org UUID so shared brands never leak budget state across tenants.
// Resp: { brandId, dailyBudgetCents, updatedAt }. Unset brand → dailyBudgetCents
// and updatedAt are null (a brand with no configured budget is a legitimate
// state; the consumer decides what to do with it). 400 on a non-UUID brandId.
router.get("/internal/brands/:brandId/daily-budget", async (req, res) => {
  const { brandId } = req.params;
  if (!UUID_RE.test(brandId)) {
    res.status(400).json({ error: "brandId must be a valid UUID" });
    return;
  }

  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    console.error(
      `[billing-service] [billing-400] ${req.method} ${req.path}: missing x-org-id`
    );
    res.status(400).json({ error: "x-org-id header is required" });
    return;
  }
  if (!UUID_RE.test(orgId)) {
    console.error(
      `[billing-service] [billing-400] ${req.method} ${req.path}: invalid x-org-id="${orgId}" (not a UUID)`
    );
    res.status(400).json({ error: "x-org-id must be a valid UUID" });
    return;
  }

  const stored = await getBrandDailyBudget(orgId, brandId);
  res.json({
    brandId,
    dailyBudgetCents: stored ? stored.dailyBudgetCents : null,
    updatedAt: stored ? stored.updatedAt.toISOString() : null,
  });
});

// GET /internal/brands/:brandId/daily-budget/history — read this org's ordered
// daily-budget CHANGE history for a brand (the timeline of raises / lowers /
// zeroings), for the customer-health board.
//
// Auth: same as the current-value read — x-api-key (service-to-service) +
// x-org-id (the internal org UUID). Shared brands keep independent per-org
// history. Resp: { brandId, history: [{ dailyBudgetCents, changedAt }] },
// oldest-first (chronological). Forward-only: entries begin when this feature
// shipped, so a brand with no writes since then returns an empty history array
// (a legitimate state — never fabricated). 400 on a non-UUID brandId.
router.get(
  "/internal/brands/:brandId/daily-budget/history",
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }

    const orgId = req.headers["x-org-id"] as string | undefined;
    if (!orgId) {
      console.error(
        `[billing-service] [billing-400] ${req.method} ${req.path}: missing x-org-id`
      );
      res.status(400).json({ error: "x-org-id header is required" });
      return;
    }
    if (!UUID_RE.test(orgId)) {
      console.error(
        `[billing-service] [billing-400] ${req.method} ${req.path}: invalid x-org-id="${orgId}" (not a UUID)`
      );
      res.status(400).json({ error: "x-org-id must be a valid UUID" });
      return;
    }

    const changes = await getBrandDailyBudgetHistory(orgId, brandId);
    res.json({
      brandId,
      history: changes.map((c) => ({
        dailyBudgetCents: c.dailyBudgetCents,
        changedAt: c.changedAt.toISOString(),
      })),
    });
  }
);

// PATCH /v1/brands/:brandId/daily-budget — set / update a brand's daily budget.
//
// Auth: x-api-key + org headers (the user, via the gateway). The value is keyed
// by (x-org-id, brandId), so shared brands have independent org budgets.
// Body: { dailyBudgetCents } — non-negative (0 = explicit pause; null/unset is a
// separate state expressed by never setting a row). Fractional cents allowed.
// Resp: { brandId, orgId, dailyBudgetCents, updatedAt } | 400 invalid.
//
// Every REAL change (a different value, or a first-ever set) also notifies staff
// via the transactional-email-service `brand_daily_budget_changed` event. The
// pre-write value comes from the same transaction as the write, so the reported
// "from" side cannot be stale. The send is strictly fire-and-forget: it can never
// change this response or throw. See lib/brand-budget-notification.ts.
router.patch(
  "/v1/brands/:brandId/daily-budget",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }

    const parsed = SetBrandDailyBudgetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }

    let dailyBudgetCents: string;
    try {
      dailyBudgetCents = parseNonNegativeCents(parsed.data.dailyBudgetCents);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "invalid dailyBudgetCents",
      });
      return;
    }

    const orgId = req.headers["x-org-id"] as string;
    let row;
    let previousDailyBudgetCents: string | null;
    try {
      ({ row, previousDailyBudgetCents } = await upsertBrandDailyBudget(
        orgId,
        brandId,
        dailyBudgetCents
      ));
    } catch (err) {
      if (err instanceof BrandBudgetManagedByFunnelsError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    console.log(
      `[billing-service] brand daily budget set: brand=${brandId} org=${orgId} budget=${dailyBudgetCents}`
    );

    notifyBrandDailyBudgetChanged({
      orgId,
      userId: req.headers["x-user-id"] as string,
      runId: req.headers["x-run-id"] as string,
      brandId,
      previousDailyBudgetCents,
      newDailyBudgetCents: row.dailyBudgetCents,
      actingEmail: (req.headers["x-email"] as string | undefined) ?? null,
    });

    res.json({
      brandId: row.brandId,
      orgId: row.orgId,
      dailyBudgetCents: row.dailyBudgetCents,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
);

// --- Per-funnel daily ceilings -------------------------------------------
//
// A brand sells through several SALES FUNNELS (brand-service's vocabulary), whose
// economics differ by orders of magnitude, so each carries its own daily ceiling.
// The brand-level read is unchanged and answers their SUM — see
// lib/brand-funnel-budgets.ts.

// GET /internal/brands/:brandId/funnel-budgets — service-to-service read of this
// org's per-funnel ceilings for a brand.
//
// Auth: x-api-key + x-org-id (same as the current-value read). Resp:
// { brandId, dailyBudgetCents, funnels: [{ funnelKey, dailyBudgetCents, updatedAt }] }.
// A brand with no per-funnel ceilings returns funnels: [] and its brand-level
// value (null when nothing was ever set) — a legitimate state, never a
// fabricated split. 400 on a non-UUID brandId.
router.get("/internal/brands/:brandId/funnel-budgets", async (req, res) => {
  const { brandId } = req.params;
  if (!UUID_RE.test(brandId)) {
    res.status(400).json({ error: "brandId must be a valid UUID" });
    return;
  }

  const orgId = requireInternalOrgId(req, res);
  if (!orgId) return;

  const view = await composeFunnelBudgetsView(orgId, brandId);
  res.json({ brandId, ...view });
});

// GET /v1/brands/:brandId/funnel-budgets — the same view for the user, via the
// gateway (brand Settings reads its ceilings back). Auth: org headers.
router.get(
  "/v1/brands/:brandId/funnel-budgets",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }

    const orgId = req.headers["x-org-id"] as string;
    const view = await composeFunnelBudgetsView(orgId, brandId);
    res.json({ brandId, orgId, ...view });
  }
);

// --- One offer's daily ceiling ------------------------------------------
//
// An offer-scoped screen shows a fraction: that offer's spend today over the
// ceiling it is paced against. The numerator is that offer's, so the denominator
// has to be too — the brand-wide total is about a different thing the moment a
// brand states a second proposition. It reads correctly today only because every
// live brand names one offer, which is a property of the data rather than of the
// design.
//
// This is its own answer, not a widening of the brand-wide read: that read's
// meaning is what several consumers pace and gate real spend on (including this
// service's own affordability checks), and it is untouched here.

// GET /internal/brands/:brandId/offers/:offerId/daily-budget — service-to-service
// read of ONE offer's daily ceiling for a brand.
//
// Auth: x-api-key + x-org-id (the same auth as every other ceiling read).
// Resp: { brandId, offerId, dailyBudgetCents, updatedAt, funnels, channels }.
// `dailyBudgetCents` is the SUM of the ceilings funding this offer; `funnels` and
// `channels` are the figures this service already serves, restricted to it — so a
// caller never enumerates the offer's channels nor adds anything up.
// An offer with NO ceiling answers dailyBudgetCents: null (nothing stated), which
// is a different answer from a ceiling of 0 (funded at nothing). 400 on a
// non-UUID brandId or offerId.
router.get(
  "/internal/brands/:brandId/offers/:offerId/daily-budget",
  async (req, res) => {
    const { brandId, offerId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    if (!UUID_RE.test(offerId)) {
      res.status(400).json({ error: "offerId must be a valid UUID" });
      return;
    }

    const orgId = requireInternalOrgId(req, res);
    if (!orgId) return;

    const view = await composeOfferBudgetView(
      orgId,
      brandId,
      offerId.toLowerCase()
    );
    res.json({ brandId, ...view });
  }
);

// GET /v1/brands/:brandId/offers/:offerId/daily-budget — the same answer for the
// user, via the gateway (an offer screen reads its own ceiling). Auth: org headers.
router.get(
  "/v1/brands/:brandId/offers/:offerId/daily-budget",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId, offerId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    if (!UUID_RE.test(offerId)) {
      res.status(400).json({ error: "offerId must be a valid UUID" });
      return;
    }

    const orgId = req.headers["x-org-id"] as string;
    const view = await composeOfferBudgetView(
      orgId,
      brandId,
      offerId.toLowerCase()
    );
    res.json({ brandId, orgId, ...view });
  }
);

// --- One funnel LEG's daily ceiling --------------------------------------
//
// A campaign is (brand, offer, acquisition channel, LEG) — the leg is the thing
// the customer buys, and the sales funnel is becoming a way of READING legs
// rather than the unit anything is keyed on (one leg belongs to several
// funnels). So this is the money that paces one campaign, read on the same key
// the campaign is keyed on.
//
// `:legKey` is features-service's canonical leg id (it mints the vocabulary and
// publishes it on GET /public/channels as legs[].legKey; campaign-service
// carries the same value on the campaign row). It is carried OPAQUE here and
// never parsed — the two steps a leg connects ride beside it on that catalogue.
//
// This is its own answer, not a widening of any existing read: the brand-wide,
// per-funnel, per-channel and per-offer figures are what several consumers pace
// and gate real spend on, and every one of them is untouched.

// GET /internal/brands/:brandId/legs/:legKey/daily-budget — service-to-service
// read of ONE leg's daily ceiling for a brand.
//
// Auth: x-api-key + x-org-id (the same auth as every other ceiling read).
// Resp: { brandId, legKey, dailyBudgetCents, updatedAt, funnels, channels,
// offers, legs }. `dailyBudgetCents` is the SUM of the ceilings funding this
// leg; the arrays are the figures this service already serves, restricted to it,
// so a caller never enumerates anything nor adds anything up.
// A leg with NO ceiling answers dailyBudgetCents: null (nothing stated), which
// is a different answer from a ceiling of 0 (funded at nothing). 400 on a
// non-UUID brandId or an empty legKey.
router.get(
  "/internal/brands/:brandId/legs/:legKey/daily-budget",
  async (req, res) => {
    const { brandId, legKey } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    if (!legKey.trim()) {
      res.status(400).json({ error: "legKey must be a non-empty funnel leg id" });
      return;
    }

    const orgId = requireInternalOrgId(req, res);
    if (!orgId) return;

    const view = await composeLegBudgetView(orgId, brandId, legKey.trim());
    res.json({ brandId, ...view });
  }
);

// GET /v1/brands/:brandId/legs/:legKey/daily-budget — the same answer for the
// user, via the gateway (a campaign screen reads its own ceiling). Auth: org
// headers.
router.get(
  "/v1/brands/:brandId/legs/:legKey/daily-budget",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId, legKey } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    if (!legKey.trim()) {
      res.status(400).json({ error: "legKey must be a non-empty funnel leg id" });
      return;
    }

    const orgId = req.headers["x-org-id"] as string;
    const view = await composeLegBudgetView(orgId, brandId, legKey.trim());
    res.json({ brandId, orgId, ...view });
  }
);

// PUT /v1/brands/:brandId/funnel-budgets — write the WHOLE set at once (signup
// checkout). Auth: org headers.
// Body: { funnels: [{ funnelKey, featureSlug?, dailyBudgetCents }] }.
//
// Each entry is one (funnel, acquisition-channel feature) pair; `featureSlug` is
// optional and resolves exactly as on the PATCH above.
//
// ATOMIC: the whole set is validated before the transaction opens and written
// inside it, so a rejected set leaves nothing half-applied. Pairs absent from
// the body are removed, so the stored set is exactly what was sent. A ceiling of
// 0 means "not funding that funnel right now" and is accepted — including a set
// where EVERY funnel is 0 (a brand in pause). A FUNDED funnel below its product
// minimum is refused with a readable reason (400), UNLESS that funnel's own
// stored ceiling already sits below the minimum and the write keeps or raises it
// (a ceiling predating the minimum is grandfathered — see
// lib/brand-funnel-budgets.ts). Each funnel is judged against its own ceiling.
router.put(
  "/v1/brands/:brandId/funnel-budgets",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }

    const parsedBody = SetBrandFunnelDailyBudgetSetRequestSchema.safeParse(
      req.body
    );
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.issues[0].message });
      return;
    }

    let entries: ParsedFunnelBudget[];
    try {
      entries = parseFunnelBudgetSet(parsedBody.data.funnels);
    } catch (err) {
      respondToFunnelWriteError(err, res);
      return;
    }

    const orgId = req.headers["x-org-id"] as string;
    await applyFunnelWrite(req, res, orgId, brandId, entries, "replace");
  }
);

// PATCH /v1/brands/:brandId/funnel-budgets/:funnelKey — set ONE ceiling (brand
// Settings). Auth: org headers. Body: { dailyBudgetCents, featureSlug? }.
//
// `featureSlug` names the ACQUISITION CHANNEL being funded, so one pair can be
// stated without disturbing its siblings. Omitted (every caller before migration
// 0036), it addresses the funnel as a whole: its single channel when it funds
// one, the default channel when it funds none, and a 409 when it is split across
// two — there is no honest way to guess which campaign the money is for.
//
// Untouched pairs keep their ceiling. Same 0-is-legal, funded-minimum and
// grandfathered-ceiling rules as the whole-set write, all judged on the FUNNEL
// TOTAL rather than on one channel.
router.patch(
  "/v1/brands/:brandId/funnel-budgets/:funnelKey",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId, funnelKey } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }

    const parsedBody = SetBrandFunnelDailyBudgetRequestSchema.safeParse(
      req.body
    );
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.issues[0].message });
      return;
    }

    let entries: ParsedFunnelBudget[];
    try {
      entries = parseFunnelBudgetSet([
        {
          funnelKey,
          featureSlug: parsedBody.data.featureSlug,
          offerId: parsedBody.data.offerId,
          legKey: parsedBody.data.legKey,
          dailyBudgetCents: parsedBody.data.dailyBudgetCents,
        },
      ]);
    } catch (err) {
      respondToFunnelWriteError(err, res);
      return;
    }

    const orgId = req.headers["x-org-id"] as string;
    await applyFunnelWrite(req, res, orgId, brandId, entries, "merge");
  }
);

export default router;
