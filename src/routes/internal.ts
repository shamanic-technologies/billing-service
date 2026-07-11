import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  InternalAccountTeardownResponseSchema,
  TransferBrandRequestSchema,
} from "../schemas.js";
import {
  billingAccounts,
  brandDailyBudgets,
  campaignAuthorizeCosts,
  creditDepletionEpisodes,
  localPromos,
} from "../db/schema.js";
import {
  listCustomersByMetadata,
  updateCustomer,
  type StripeCustomer,
} from "../lib/stripe-service-client.js";
import { runDunningTick } from "../lib/dunning.js";
import { getCampaignAuthorizeCost } from "../lib/campaign-costs.js";
import { computeBalance } from "../lib/balance.js";
import { resolvePostpaidTier } from "../lib/topup-tier.js";
import { fetchRunsOrgActualUsageTotal } from "../lib/runs-client.js";
import { getUsageDiscountPct } from "../lib/usage-discount.js";
import { gte as gteCents, isDepleted, subCents } from "../lib/cents.js";

const router = Router();

const SS_LIST_PAGE_LIMIT = 100;
const INTERNAL_IDENTITY: Record<string, string> = {
  "x-user-id": "00000000-0000-0000-0000-000000000000",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InternalAccountTeardownResponse = typeof InternalAccountTeardownResponseSchema._type;

async function deleteWelcomeCreditClaimsIfPresent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string
): Promise<number> {
  const tableCheck = await tx.execute(sql`
    SELECT to_regclass('public.welcome_credit_claims')::text AS table_name
  `);
  const tableName = (tableCheck as unknown as Array<{ table_name: string | null }>)[0]
    ?.table_name;
  if (!tableName) return 0;

  const deleted = await tx.execute(sql`
    DELETE FROM welcome_credit_claims
    WHERE org_id = ${orgId}
    RETURNING id
  `);
  return Number(
    (deleted as { count?: number }).count ??
      (Array.isArray(deleted) ? deleted.length : 0)
  );
}

async function deleteBillingStateByOrg(
  orgId: string
): Promise<InternalAccountTeardownResponse["deletedRows"]> {
  return db.transaction(async (tx) => {
    const deletedWelcomeClaims = await deleteWelcomeCreditClaimsIfPresent(tx, orgId);

    const deletedLocalPromos = await tx
      .delete(localPromos)
      .where(eq(localPromos.orgId, orgId))
      .returning({ id: localPromos.id });

    const deletedDunningEpisodes = await tx
      .delete(creditDepletionEpisodes)
      .where(eq(creditDepletionEpisodes.orgId, orgId))
      .returning({ id: creditDepletionEpisodes.id });

    const deletedCampaignCosts = await tx
      .delete(campaignAuthorizeCosts)
      .where(eq(campaignAuthorizeCosts.orgId, orgId))
      .returning({ campaignId: campaignAuthorizeCosts.campaignId });

    const deletedBrandBudgets = await tx
      .delete(brandDailyBudgets)
      .where(eq(brandDailyBudgets.orgId, orgId))
      .returning({ brandId: brandDailyBudgets.brandId });

    const deletedBillingAccounts = await tx
      .delete(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .returning({ id: billingAccounts.id });

    return {
      billingAccounts: deletedBillingAccounts.length,
      localPromos: deletedLocalPromos.length,
      creditDepletionEpisodes: deletedDunningEpisodes.length,
      campaignAuthorizeCosts: deletedCampaignCosts.length,
      brandDailyBudgets: deletedBrandBudgets.length,
      welcomeCreditClaims: deletedWelcomeClaims,
    };
  });
}

/**
 * Parse a Stripe customer's `metadata.brand_id` value. We store it as a
 * comma-separated string (Stripe metadata values are strings, max 500 chars).
 * Empty/missing → []. Trims whitespace.
 */
function parseBrandIds(metadata: Record<string, string>): string[] {
  const raw = metadata.brand_id;
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Decide whether a Stripe customer is safe to repoint to the target org.
 *
 * Mirrors the local_promos solo-brand semantics: a customer is in scope only
 * if its `brand_id` metadata holds exactly one brand AND that brand is the
 * source brand. Multi-brand customers are skipped — moving them would orphan
 * the other brands. Customers with no `brand_id` are skipped (org-wide
 * artifact, not brand-scoped).
 */
function isSoloBrandMatch(customer: StripeCustomer, sourceBrandId: string): boolean {
  const brandIds = parseBrandIds(customer.metadata ?? {});
  return brandIds.length === 1 && brandIds[0] === sourceBrandId;
}

async function listAllOrgCustomers(sourceOrgId: string): Promise<StripeCustomer[]> {
  const out: StripeCustomer[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await listCustomersByMetadata(INTERNAL_IDENTITY, {
      metadata: { org_id: sourceOrgId },
      limit: SS_LIST_PAGE_LIMIT,
      starting_after: startingAfter,
    });
    out.push(...page.data);
    if (!page.has_more) break;
    const last = page.data[page.data.length - 1];
    if (!last) break;
    startingAfter = last.id;
  }
  return out;
}

// DELETE /internal/accounts/by-org/:orgId — billing-service leg of org teardown.
//
// Local-only cleanup: removes billing-owned org rows that can keep active money,
// pacing, dunning, or affordability effects alive after client-service deletes
// the org. Stripe customers/subscriptions and runs usage are owned by their
// services; this endpoint deliberately does not fan out.
router.delete("/internal/accounts/by-org/:orgId", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }

  try {
    const deletedRows = await deleteBillingStateByOrg(orgId);
    res.json({ ok: true, orgId, deletedRows });
  } catch (err) {
    console.error(`[billing-service] account teardown failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to delete billing account state" });
  }
});

// POST /internal/transfer-brand — re-assigns solo-brand rows between orgs.
//
// Two-sided:
//   - billing-local `local_promos` (per-org promo credits) — UPDATE here
//   - stripe-service customers — list by metadata.org_id=source, patch
//     metadata for the subset whose metadata.brand_id is the source brand
//     (solo-brand only — multi-brand customers stay put).
router.post("/internal/transfer-brand", async (req, res) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

  const localStep1 = await db.execute(sql`
    UPDATE local_promos
    SET org_id = ${targetOrgId}
    WHERE org_id = ${sourceOrgId}
      AND array_length(brand_ids, 1) = 1
      AND brand_ids[1] = ${sourceBrandId}
  `);
  let localCount = Number(localStep1.count ?? 0);

  if (targetBrandId) {
    const localStep2 = await db.execute(sql`
      UPDATE local_promos
      SET brand_ids = ARRAY[${targetBrandId}]
      WHERE array_length(brand_ids, 1) = 1
        AND brand_ids[1] = ${sourceBrandId}
    `);
    localCount = Math.max(localCount, Number(localStep2.count ?? 0));
  }

  let candidates: StripeCustomer[];
  try {
    candidates = await listAllOrgCustomers(sourceOrgId);
  } catch (err) {
    console.error("[billing-service] stripe-service customer list failed:", err);
    res.status(502).json({ error: "Failed to list customers from stripe-service" });
    return;
  }

  const targets = candidates.filter((c) => isSoloBrandMatch(c, sourceBrandId));
  const skippedMultiBrand = candidates.filter((c) => {
    const ids = parseBrandIds(c.metadata ?? {});
    return ids.length > 1 && ids.includes(sourceBrandId);
  });

  if (skippedMultiBrand.length > 0) {
    console.warn(
      `[billing-service] transfer-brand: skipping ${skippedMultiBrand.length} multi-brand customer(s) tagged with sourceBrandId=${sourceBrandId} ` +
      `(would orphan co-brands). Customer ids: ${skippedMultiBrand.map((c) => c.id).join(",")}`
    );
  }

  let ssCount = 0;
  for (const customer of targets) {
    const newMetadata: Record<string, string> = {
      ...(customer.metadata ?? {}),
      org_id: targetOrgId,
    };
    if (targetBrandId) {
      newMetadata.brand_id = targetBrandId;
    }
    try {
      await updateCustomer(customer.id, INTERNAL_IDENTITY, { metadata: newMetadata });
      ssCount += 1;
    } catch (err) {
      console.error(`[billing-service] stripe-service updateCustomer ${customer.id} failed:`, err);
      res.status(502).json({
        error: "Failed to update customer metadata in stripe-service",
        partial: { stripe_service_customers_patched: ssCount, total_targets: targets.length },
      });
      return;
    }
  }

  console.log(
    `[billing-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} from=${sourceOrgId} to=${targetOrgId} ` +
    `local_promos=${localCount} stripe_customers_patched=${ssCount} stripe_candidates_scanned=${candidates.length} stripe_skipped_multibrand=${skippedMultiBrand.length}`
  );

  res.json({
    updatedTables: [
      { tableName: "local_promos", count: localCount },
      { tableName: "stripe_service_customers", count: ssCount },
    ],
  });
});

// GET /internal/campaigns/:campaignId/affordability
//
// Read-only pre-flight gate for campaign-service: "can this org afford another
// run of campaign X right now?". ZERO side effects — no charge, no reload, no
// depletion-episode mutation. The cost estimate is the required_cents of the
// LAST authorize attempt for the campaign (stored by the authorize route); a
// campaign re-runs the same workflow → ~constant cost.
//
//   - No stored cost (hasHistory=false) → affordable=true (first-run default:
//     a brand-new campaign runs once to establish its cost). balanceCents is
//     "0" because the org isn't resolvable without a stored row.
//   - else affordable = running the next run keeps the balance at/above the
//     org's postpaid credit-line floor: (balance − lastRequired) >= floor.
//
// The floor is the SAME derived postpaid threshold the authorize route gates on
// (resolvePostpaidTier): a NEGATIVE credit line for a reload-capable org (config
// enabled + chargeable card + non-blocked issuing country), else "0" (strictly
// prepaid). So a postpaid org stays affordable while its balance runs negative
// within its line, and flips to not-affordable only when the next run would
// cross past the floor — matching what authorize would actually allow. A
// zero-floor org is unchanged: affordable only while balance covers the run.
//
// Fail-loud: a balance-compose failure surfaces as 502.
const ZERO_CENTS = "0.0000000000";

router.get("/internal/campaigns/:campaignId/affordability", async (req, res) => {
  const { campaignId } = req.params;
  if (!UUID_RE.test(campaignId)) {
    res.status(400).json({ error: "campaignId must be a valid UUID" });
    return;
  }

  const stored = await getCampaignAuthorizeCost(campaignId);

  if (!stored) {
    res.json({
      affordable: true,
      balanceCents: ZERO_CENTS,
      lastRequiredCents: null,
      hasHistory: false,
    });
    return;
  }

  // The org's stored auto-topup flag (non-null topup amount ⇒ enabled) gates
  // whether it has a postpaid credit line at all — read-only SELECT, no side
  // effects. Absent account row ⇒ no config ⇒ zero floor (strictly prepaid).
  const [account] = await db
    .select({ topupAmountCents: billingAccounts.topupAmountCents })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, stored.orgId))
    .limit(1);

  // No end-user on this read-only pre-flight. computeBalance reads stripe-service
  // via the user-less /internal/*/by-org/{orgId} routes (X-API-Key + org only) —
  // no x-user-id, no sentinel.
  let snapshot;
  try {
    snapshot = await computeBalance(stored.orgId);
  } catch (err) {
    console.error(
      `[billing-service] affordability: balance compose failed for campaign ${campaignId} (org ${stored.orgId}):`,
      err
    );
    res.status(502).json({ error: "Failed to compute balance" });
    return;
  }

  // Honor the SAME postpaid credit-line floor authorize gates on: a reload-capable
  // org is affordable while its (possibly negative) balance stays within the line,
  // and only flips to not-affordable when the next run would cross past the floor.
  const { thresholdCents } = resolvePostpaidTier({
    topupEnabled: account?.topupAmountCents != null,
    hasCardPm: snapshot.hasCardPm,
    autoReloadSupported: snapshot.autoReloadSupported,
    paidTopupsCents: snapshot.paidTopupsCents,
  });

  const lastRequiredCents = stored.lastAuthorizeRequiredCents;
  res.json({
    affordable: gteCents(
      subCents(snapshot.balanceCents, lastRequiredCents),
      thresholdCents
    ),
    balanceCents: snapshot.balanceCents,
    lastRequiredCents,
    hasHistory: true,
  });
});

// GET /internal/accounts/by-org/:orgId/balance
//
// User-less spendable-balance read for platform/staff fleet aggregators
// (features-service accounts audit + fleet send-forecast) that need an org's
// balance without a real end-user in context. Mirrors GET /v1/accounts/balance
// (same balance/actual_balance/depleted shape + field names + semantics) plus an
// additive has_auto_topup flag (see below) — keyed by the orgId PATH param and
// guarded by requireApiKey only — no x-org-id / x-user-id / x-run-id headers, no
// sentinel identity.
//
// Pure read: computeBalance (user-less /internal/*/by-org/{orgId} stripe reads +
// runs-service org-usage) — NO auto-reload, NO depletion-episode mutation, no
// side effects. 404 when the org has no billing account (same as /v1). Fail-loud
// 502 when stripe-service / runs-service is unreachable.
router.get("/internal/accounts/by-org/:orgId/balance", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }

  const [account] = await db
    .select({
      id: billingAccounts.id,
      topupAmountCents: billingAccounts.topupAmountCents,
      topupThresholdCents: billingAccounts.topupThresholdCents,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);

  if (!account) {
    res.status(404).json({ error: "Billing account not found" });
    return;
  }

  let snapshot;
  let actualUsage;
  try {
    [snapshot, actualUsage] = await Promise.all([
      computeBalance(orgId),
      fetchRunsOrgActualUsageTotal(orgId, {}),
    ]);
  } catch (err) {
    console.error(
      `[billing-service] internal balance-by-org: compose failed for org ${orgId}:`,
      err
    );
    res.status(502).json({ error: "Failed to compute balance" });
    return;
  }

  // has_auto_topup uses the SAME name + semantics as GET /v1/accounts (one field
  // for one concept across both billing balance surfaces): the stored topup columns
  // are the enabled flag (non-null ⇒ configured), AND the reload can actually fire
  // (a chargeable card exists AND its issuing country is not off_session-blocked,
  // e.g. India / RBI). This is the "will never run dry" signal fleet aggregators
  // (features-service accounts audit) use to classify an org as active even when its
  // momentary spendable balance is low. Additive field — the
  // balance/actual_balance/depleted shape above is unchanged.
  const hasAutoTopup =
    account.topupAmountCents != null &&
    account.topupThresholdCents != null &&
    snapshot.hasCardPm &&
    snapshot.autoReloadSupported;

  res.json({
    // Both usage figures from runs-service are already NET of the org's usage
    // discount (frozen at cost-write). Billing subtracts them verbatim and applies
    // no discount here. balance_cents = credited − committed usage;
    // actual_balance_cents = credited − actualized usage.
    balance_cents: snapshot.balanceCents,
    actual_balance_cents: subCents(snapshot.creditedCents, actualUsage.spent_cents),
    depleted: isDepleted(snapshot.balanceCents),
    has_auto_topup: hasAutoTopup,
  });
});

// GET /internal/accounts/by-org/:orgId/usage-discount
//
// User-less read of an org's platform-usage discount percentage, keyed by the
// orgId PATH param and guarded by requireApiKey ONLY — no x-org-id / x-user-id,
// no sentinel. Two service-to-service consumers:
//   - runs-service calls it at cost-write time to FREEZE the discount onto each
//     cost row (the discount is applied exactly once, there — billing never
//     re-applies it at balance composition).
//   - features-service (PR #510, already deployed) reads it to render net-priced
//     cost metrics.
//
// Two service-to-service consumers with DIFFERENT field names + scales — the
// response carries BOTH keys:
//   - features-service (#510, billing-discount-client.ts): `discount_percent`,
//     integer in [0, 100].
//   - runs-service (services/usage-discount.ts): `discount_pct`, fraction in
//     [0, 1] (0.5 == 50%), fail-loud 422 if the key is absent.
// A known org with NO discount returns discount_percent = 0 / discount_pct = 0
// (NOT null, NOT 404) so a non-discounted org resolves to "0% off" = no change.
// The `orgId` echo is additive. 400 on a non-UUID orgId.
router.get("/internal/accounts/by-org/:orgId/usage-discount", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }

  const pct = (await getUsageDiscountPct(orgId)) ?? 0;
  // Serve BOTH field names — two consumers, two contracts:
  //   - features-service (#510): `discount_percent`, integer [0,100].
  //   - runs-service (services/usage-discount.ts): `discount_pct`, fraction
  //     [0,1] (0.5 == 50%), fail-loud 422 if absent. #250 dropped this key and
  //     broke every platform cost write; restored here.
  res.json({ orgId, discount_percent: pct, discount_pct: pct / 100 });
});

// POST /internal/dunning/tick — manually run one dunning scheduler pass.
//
// The same pass runs automatically on the in-process hourly scheduler; this
// route is for ops ("re-run dunning now") and integration testing. Fail-loud:
// a tick-level error (not a per-episode skip) surfaces as 502.
router.post("/internal/dunning/tick", async (_req, res) => {
  try {
    const result = await runDunningTick();
    res.json(result);
  } catch (err) {
    console.error("[billing-service] dunning tick (manual) failed:", err);
    res.status(502).json({ error: "Dunning tick failed" });
  }
});

export default router;
