import type { Request, Response } from "express";
import { Router } from "express";
import { requireOrgHeaders } from "../middleware/auth.js";
import {
  SetBrandDailyBudgetRequestSchema,
  SetCampaignDailyBudgetRequestSchema,
} from "../schemas.js";
import { parseNonNegativeCents } from "../lib/cents.js";
import {
  getBrandDailyBudget,
  getBrandDailyBudgetByDay,
  getBrandDailyBudgetHistory,
  upsertBrandDailyBudget,
} from "../lib/brand-budgets.js";
import {
  MAX_DAY_RANGE_DAYS,
  currentUtcDay,
  parseUtcDay,
  utcDaySpan,
} from "../lib/utc-day.js";
import { notifyBrandDailyBudgetChanged } from "../lib/brand-budget-notification.js";
import {
  BrandBudgetManagedByCampaignsError,
  CeilingBelowMinimumError,
  ChannelTermsUnavailableError,
  InvalidCeilingError,
  UnknownAcquisitionChannelError,
  aggregateLegBudget,
  aggregateOfferBudget,
  campaignBudgetOf,
  campaignTotalsOf,
  getBrandCeilings,
  parseCampaignKey,
  setCampaignDailyBudget,
  sumCeilings,
  type CampaignBudgetTotal,
  type CampaignKey,
  type CeilingSubtotal,
} from "../lib/campaign-budgets.js";
import {
  brandGrainChange,
  ceilingChangesBetween,
} from "../lib/brand-running-budget.js";

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

function renderCampaigns(totals: CampaignBudgetTotal[]) {
  return totals.map((total) => ({
    offerId: total.offerId,
    legKey: total.legKey,
    featureSlug: total.featureSlug,
    dailyBudgetCents: total.dailyBudgetCents,
    updatedAt: total.updatedAt.toISOString(),
  }));
}

/** An offer's or a leg's ceiling, or the explicit "nothing funds it" answer. */
function renderSubtotal(subtotal: CeilingSubtotal | null) {
  if (!subtotal) {
    return { dailyBudgetCents: null, updatedAt: null, campaigns: [] };
  }
  return {
    dailyBudgetCents: subtotal.dailyBudgetCents,
    updatedAt: subtotal.updatedAt.toISOString(),
    campaigns: renderCampaigns(subtotal.campaigns),
  };
}

/**
 * One OFFER's ceiling, for a screen that paces that one proposition: the SUM of
 * the campaign ceilings funding it, plus those ceilings. An offer with no
 * ceiling answers null — nothing stated is not a ceiling of zero.
 */
async function composeOfferBudgetView(
  orgId: string,
  brandId: string,
  offerId: string
) {
  const stored = await getBrandCeilings(orgId, brandId);
  return { offerId, ...renderSubtotal(aggregateOfferBudget(stored, offerId)) };
}

/**
 * One LEG's ceiling: the SUM of the campaign ceilings funding it, plus those
 * ceilings. A leg with no ceiling answers null.
 */
async function composeLegBudgetView(
  orgId: string,
  brandId: string,
  legKey: string
) {
  const stored = await getBrandCeilings(orgId, brandId);
  return { legKey, ...renderSubtotal(aggregateLegBudget(stored, legKey)) };
}

/** Map a ceiling-write validation failure onto its status. Rethrows anything else. */
function respondToCeilingWriteError(err: unknown, res: Response): void {
  if (
    err instanceof CeilingBelowMinimumError ||
    err instanceof UnknownAcquisitionChannelError ||
    err instanceof InvalidCeilingError
  ) {
    res.status(400).json({ error: err.message });
    return;
  }
  // The acquisition channels' published terms could not be read, so no daily
  // minimum is known. A gate that cannot be evaluated REFUSES — never lets the
  // write through — and it is the producer that is unavailable, not the request
  // that is wrong.
  if (err instanceof ChannelTermsUnavailableError) {
    res.status(502).json({ error: err.message });
    return;
  }
  throw err;
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

// GET /internal/brands/:brandId/daily-budget/by-day?from=&to=
//
// What daily amount was IN FORCE for this brand on each UTC day of a range —
// the past-day read a run-rate consumer needs, answered by replaying the
// append-only change log rather than by anyone snapshotting billing's state.
//
// Auth: same as the current-value and history reads — x-api-key
// (service-to-service) plus x-org-id (the internal org UUID). Shared brands
// keep independent per-org answers.
//
// GRAIN: the BRAND total. brand_daily_budget_changes carries the brand-level
// figure on EVERY write (per-campaign writes included), so the replay is
// complete at that grain. The campaign ceilings are
// upserted in place with no change log of their own, so a past-day answer
// there would be invented — hence no finer read.
//
// Resp: { brandId, orgId, grain: "brand", recordBeginsAt, days: [{ date,
// state, dailyBudgetCents, inForceSince }] }, oldest day first. A day before
// the first recorded change is state "not_recorded" with a null amount — never
// 0, and never the current value back-dated. A RECORDED "0" is a brand the
// customer deliberately defunded, which is a different fact; the two are
// distinguishable by `state`, not by reading a number as a sentinel.
//
// 400 on a non-UUID brandId, a missing/malformed date, to < from, a range over
// MAX_DAY_RANGE_DAYS, or a day in the FUTURE (no change can exist there, so
// answering would be a claim about what has not happened yet). TODAY is
// allowed and answers with the amount in force right now.
router.get(
  "/internal/brands/:brandId/daily-budget/by-day",
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }

    const orgId = requireInternalOrgId(req, res);
    if (!orgId) return;

    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    if (typeof fromRaw !== "string" || typeof toRaw !== "string") {
      res.status(400).json({
        error: "from and to query params are required (YYYY-MM-DD, UTC)",
      });
      return;
    }

    const fromDay = parseUtcDay(fromRaw);
    const toDay = parseUtcDay(toRaw);
    if (!fromDay || !toDay) {
      res
        .status(400)
        .json({ error: "from and to must be valid UTC dates (YYYY-MM-DD)" });
      return;
    }
    if (toDay.getTime() < fromDay.getTime()) {
      res.status(400).json({ error: "to must not be earlier than from" });
      return;
    }
    if (utcDaySpan(fromDay, toDay) > MAX_DAY_RANGE_DAYS) {
      res.status(400).json({
        error: `range must not exceed ${MAX_DAY_RANGE_DAYS} days`,
      });
      return;
    }
    if (toDay.getTime() > currentUtcDay().getTime()) {
      res
        .status(400)
        .json({ error: "to must not be a future UTC day" });
      return;
    }

    const { recordBeginsAt, days } = await getBrandDailyBudgetByDay(
      orgId,
      brandId,
      fromDay,
      toDay
    );
    res.json({ brandId, orgId, grain: "brand", recordBeginsAt, days });
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
      if (err instanceof BrandBudgetManagedByCampaignsError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    console.log(
      `[billing-service] brand daily budget set: brand=${brandId} org=${orgId} budget=${dailyBudgetCents}`
    );

    void notifyBrandDailyBudgetChanged({
      orgId,
      userId: req.headers["x-user-id"] as string,
      runId: req.headers["x-run-id"] as string,
      brandId,
      previousDailyBudgetCents,
      newDailyBudgetCents: row.dailyBudgetCents,
      changes: brandGrainChange(
        previousDailyBudgetCents,
        row.dailyBudgetCents
      ),
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
// Resp: { brandId, offerId, dailyBudgetCents, updatedAt, campaigns }.
// `dailyBudgetCents` is the SUM of the campaign ceilings funding this offer;
// `campaigns` lists them — so a caller never enumerates the offer's campaigns
// nor adds anything up.
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

// --- One LEG's daily ceiling ---------------------------------------------
//
// A campaign is (offer, leg, acquisition channel) — the leg is the thing the
// customer buys. So this is the money that paces the campaigns buying one leg,
// read on the key they are keyed on.
//
// `:legKey` is features-service's canonical leg id (it mints the vocabulary and
// publishes it on GET /public/channels as legs[].legKey; campaign-service
// carries the same value on the campaign row). It is carried OPAQUE here and
// never parsed — the two steps a leg connects ride beside it on that catalogue.
//
// This is its own answer, not a widening of any existing read: the brand-wide
// and per-offer figures are what several consumers pace and gate real spend on,
// and both are untouched.

// GET /internal/brands/:brandId/legs/:legKey/daily-budget — service-to-service
// read of ONE leg's daily ceiling for a brand.
//
// Auth: x-api-key + x-org-id (the same auth as every other ceiling read).
// Resp: { brandId, legKey, dailyBudgetCents, updatedAt, campaigns }.
// `dailyBudgetCents` is the SUM of the campaign ceilings funding this leg;
// `campaigns` lists them, so a caller never enumerates anything nor adds
// anything up.
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
      res.status(400).json({ error: "legKey must be a non-empty leg id" });
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
      res.status(400).json({ error: "legKey must be a non-empty leg id" });
      return;
    }

    const orgId = req.headers["x-org-id"] as string;
    const view = await composeLegBudgetView(orgId, brandId, legKey.trim());
    res.json({ brandId, orgId, ...view });
  }
);

// --- One CAMPAIGN's daily ceiling ---------------------------------------
//
// A campaign is (offer x leg x acquisition channel), so these routes address a
// ceiling by the campaign — see lib/campaign-budgets.ts.

/**
 * Every campaign ceiling of a brand, plus the brand total
 * (null when nothing was ever configured — the same answer as the brand-level
 * read). The entries add up to the total by construction.
 */
async function composeCampaignBudgetsView(orgId: string, brandId: string) {
  const all = await getBrandCeilings(orgId, brandId);
  if (all.length > 0) {
    return {
      dailyBudgetCents: sumCeilings(all),
      campaigns: renderCampaigns(campaignTotalsOf(all)),
    };
  }
  const brandLevel = await getBrandDailyBudget(orgId, brandId);
  return {
    dailyBudgetCents: brandLevel ? brandLevel.dailyBudgetCents : null,
    campaigns: [],
  };
}

async function composeCampaignBudgetView(
  orgId: string,
  brandId: string,
  key: CampaignKey
) {
  const found = campaignBudgetOf(await getBrandCeilings(orgId, brandId), key);
  return {
    ...key,
    dailyBudgetCents: found ? found.dailyBudgetCents : null,
    updatedAt: found ? found.updatedAt.toISOString() : null,
  };
}

/** Parse the campaign address out of the query string; writes the 400 itself. */
function campaignKeyFromQuery(req: Request, res: Response): CampaignKey | null {
  try {
    return parseCampaignKey(req.query as Record<string, unknown>);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return null;
  }
}

// GET /internal/brands/:brandId/campaign-budgets — every campaign ceiling of a
// brand. Auth: x-api-key + x-org-id.
router.get("/internal/brands/:brandId/campaign-budgets", async (req, res) => {
  const { brandId } = req.params;
  if (!UUID_RE.test(brandId)) {
    res.status(400).json({ error: "brandId must be a valid UUID" });
    return;
  }
  const orgId = requireInternalOrgId(req, res);
  if (!orgId) return;
  res.json({ brandId, ...(await composeCampaignBudgetsView(orgId, brandId)) });
});

// GET /v1/brands/:brandId/campaign-budgets — the same list for the user, via
// the gateway. Auth: org headers.
router.get(
  "/v1/brands/:brandId/campaign-budgets",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const orgId = req.headers["x-org-id"] as string;
    res.json({
      brandId,
      orgId,
      ...(await composeCampaignBudgetsView(orgId, brandId)),
    });
  }
);

// GET /internal/brands/:brandId/campaign-budget?offerId=&legKey=&featureSlug=
// — ONE campaign's ceiling (campaign-service pacing). All three are required.
// Nothing funds it -> dailyBudgetCents: null, never 0. Auth: x-api-key + x-org-id.
router.get("/internal/brands/:brandId/campaign-budget", async (req, res) => {
  const { brandId } = req.params;
  if (!UUID_RE.test(brandId)) {
    res.status(400).json({ error: "brandId must be a valid UUID" });
    return;
  }
  const orgId = requireInternalOrgId(req, res);
  if (!orgId) return;
  const key = campaignKeyFromQuery(req, res);
  if (!key) return;
  res.json({ brandId, ...(await composeCampaignBudgetView(orgId, brandId, key)) });
});

// GET /v1/brands/:brandId/campaign-budget?offerId=&legKey=&featureSlug= — the
// same answer for the user, via the gateway. Auth: org headers.
router.get(
  "/v1/brands/:brandId/campaign-budget",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const key = campaignKeyFromQuery(req, res);
    if (!key) return;
    const orgId = req.headers["x-org-id"] as string;
    res.json({
      brandId,
      orgId,
      ...(await composeCampaignBudgetView(orgId, brandId, key)),
    });
  }
);

// PUT /v1/brands/:brandId/campaign-budget — state ONE campaign's ceiling (the
// dashboard's budget controls). Body: { offerId, legKey, featureSlug,
// dailyBudgetCents }. Other campaigns untouched. 0 is legal; a funded channel
// below its published floor is a 400 (a channel already below it may be kept or
// raised). Auth: org headers.
router.put(
  "/v1/brands/:brandId/campaign-budget",
  requireOrgHeaders,
  async (req, res) => {
    const { brandId } = req.params;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a valid UUID" });
      return;
    }
    const parsedBody = SetCampaignDailyBudgetRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: parsedBody.error.issues[0].message });
      return;
    }

    let key: CampaignKey;
    try {
      key = parseCampaignKey(parsedBody.data);
    } catch (err) {
      respondToCeilingWriteError(err, res);
      return;
    }

    const orgId = req.headers["x-org-id"] as string;
    let written;
    try {
      written = await setCampaignDailyBudget(
        orgId,
        brandId,
        key,
        parsedBody.data.dailyBudgetCents
      );
    } catch (err) {
      respondToCeilingWriteError(err, res);
      return;
    }

    console.log(
      `[billing-service] campaign budget set: brand=${brandId} org=${orgId} campaign=${key.offerId}/${key.legKey}/${key.featureSlug} value=${written.campaign.dailyBudgetCents} total=${written.brandDailyBudgetCents}`
    );

    const changes = ceilingChangesBetween(
      written.previousCeilings,
      written.ceilings
    );
    if (
      written.previousCeilings.length === 0 &&
      written.previousBrandDailyBudgetCents !== null
    ) {
      changes.push(
        ...brandGrainChange(written.previousBrandDailyBudgetCents, "0")
      );
    }
    void notifyBrandDailyBudgetChanged({
      orgId,
      userId: req.headers["x-user-id"] as string,
      runId: req.headers["x-run-id"] as string,
      brandId,
      previousDailyBudgetCents: written.previousBrandDailyBudgetCents,
      newDailyBudgetCents: written.brandDailyBudgetCents,
      changes,
      actingEmail: (req.headers["x-email"] as string | undefined) ?? null,
    });

    res.json({
      brandId,
      orgId,
      ...key,
      dailyBudgetCents: written.campaign.dailyBudgetCents,
      updatedAt: written.campaign.updatedAt.toISOString(),
      brandDailyBudgetCents: written.brandDailyBudgetCents,
      campaigns: renderCampaigns(campaignTotalsOf(written.ceilings)),
    });
  }
);

export default router;
