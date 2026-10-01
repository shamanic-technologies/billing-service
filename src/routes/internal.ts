import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  InternalAccountTeardownResponseSchema,
  OnDemandChargeRequestSchema,
  TransferBrandRequestSchema,
} from "../schemas.js";
import {
  billingAccounts,
  brandDailyBudgets,
  brandSalesBudgets,
  campaignDailyBudgets,
  campaignAuthorizeCosts,
  campaignReloadSweepAttempts,
  creditDepletionEpisodes,
  freeCreditPromises,
  welcomeRecipients,
  staffDebits,
  subscriptions,
  subscriptionCreditExpiries,
  localPromos,
  ORG_CREATION_BONUS_CODE,
} from "../db/schema.js";
import {
  BrandTransferConflictError,
  BrandTransferUpstreamError,
  transferBrand,
  type BrandTransferResult,
} from "../lib/brand-transfer.js";
import { runDunningTick } from "../lib/dunning.js";
import { getCampaignAuthorizeCost } from "../lib/campaign-costs.js";
import { computeBalance } from "../lib/balance.js";
import { cannotSpend, resolveOrgFloor } from "../lib/spend-block.js";
import { fetchOrgActualUsageTotal } from "../lib/transfer-usage.js";
import { getUsageDiscountPct } from "../lib/usage-discount.js";
import { isDepleted, subCents } from "../lib/cents.js";
import { flagUncollectableDebt, listUnpaidDebts } from "../lib/unpaid-debt.js";
import { getPaymentStoppedPeriods } from "../lib/payment-stopped.js";
import { getPaymentOutlook } from "../lib/payment-outlook.js";
import {
  getChargeSchedule,
  DEFAULT_CHARGE_SCHEDULE_HORIZON_DAYS,
  MAX_CHARGE_SCHEDULE_HORIZON_DAYS,
} from "../lib/charge-schedule.js";
import {
  seedTrialCredit,
  settleSignupWelcome,
  TrialSeedWelcomeAlreadyGrantedError,
} from "../lib/trial-seed.js";
import { personIdOrNull } from "../lib/welcome-recipient.js";
import { grantOrgCreationBonus } from "../lib/promos.js";
import {
  chargeOrgOnDemand,
  OnDemandChargeError,
} from "../lib/on-demand-charge.js";
import { STRIPE_MIN_CHARGE_CENTS } from "../lib/month-end-sweep.js";
import {
  getOrgRevenue,
  getFleetRevenue,
  DEFAULT_CASH_HORIZON_DAYS,
  MAX_CASH_HORIZON_DAYS,
} from "../lib/revenue.js";

const router = Router();

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
    // The person whose welcome lived on this org (welcome_recipients, migration
    // 0049) is freed with it, counted under the same "welcome credit claims" figure:
    // a staff teardown frees the email to sign up again, welcome included.
    const deletedWelcomeRecipients = await tx
      .delete(welcomeRecipients)
      .where(eq(welcomeRecipients.orgId, orgId))
      .returning({ userId: welcomeRecipients.userId });
    const deletedWelcomeClaims =
      (await deleteWelcomeCreditClaimsIfPresent(tx, orgId)) +
      deletedWelcomeRecipients.length;

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

    const deletedSweepAttempts = await tx
      .delete(campaignReloadSweepAttempts)
      .where(eq(campaignReloadSweepAttempts.orgId, orgId))
      .returning({ orgId: campaignReloadSweepAttempts.orgId });

    const deletedBrandBudgets = await tx
      .delete(brandDailyBudgets)
      .where(eq(brandDailyBudgets.orgId, orgId))
      .returning({ brandId: brandDailyBudgets.brandId });

    // A brand's global sales budget (migration 0054) is this org's pacing config
    // too: left behind, it would keep a brand in global mode after teardown.
    const deletedSalesBudgets = await tx
      .delete(brandSalesBudgets)
      .where(eq(brandSalesBudgets.orgId, orgId))
      .returning({ brandId: brandSalesBudgets.brandId });

    // Campaign ceilings are this org's own pacing config for the same brands.
    const deletedCampaignBudgets = await tx
      .delete(campaignDailyBudgets)
      .where(eq(campaignDailyBudgets.orgId, orgId))
      .returning({ brandId: campaignDailyBudgets.brandId });

    // This org's OWN promises. A promise held by ANOTHER org that merely REFERENCES
    // this one (an inviter's promise naming this org as the referral that converted)
    // is deliberately left alone: the inviter genuinely earned it, and it stays
    // payable whether or not the org they referred still exists.
    const deletedPromises = await tx
      .delete(freeCreditPromises)
      .where(eq(freeCreditPromises.orgId, orgId))
      .returning({ id: freeCreditPromises.id });

    // Staff debits on this org (migration 0053) go with it: they only ever adjust
    // this org's own balance.
    const deletedStaffDebits = await tx
      .delete(staffDebits)
      .where(eq(staffDebits.orgId, orgId))
      .returning({ id: staffDebits.id });

    // The org's subscription (migration 0056): its schedule, its charges and its
    // expired credit only ever concern this org. Charges cascade with it.
    const deletedExpiries = await tx
      .delete(subscriptionCreditExpiries)
      .where(eq(subscriptionCreditExpiries.orgId, orgId))
      .returning({ id: subscriptionCreditExpiries.id });
    const deletedSubscriptions = await tx
      .delete(subscriptions)
      .where(eq(subscriptions.orgId, orgId))
      .returning({ id: subscriptions.id });

    const deletedBillingAccounts = await tx
      .delete(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .returning({ id: billingAccounts.id });

    return {
      billingAccounts: deletedBillingAccounts.length,
      localPromos: deletedLocalPromos.length,
      creditDepletionEpisodes: deletedDunningEpisodes.length,
      campaignAuthorizeCosts: deletedCampaignCosts.length,
      campaignReloadSweepAttempts: deletedSweepAttempts.length,
      brandDailyBudgets: deletedBrandBudgets.length,
      campaignDailyBudgets: deletedCampaignBudgets.length,
      brandSalesBudgets: deletedSalesBudgets.length,
      welcomeCreditClaims: deletedWelcomeClaims,
      freeCreditPromises: deletedPromises.length,
      staffDebits: deletedStaffDebits.length,
      subscriptions: deletedSubscriptions.length,
      subscriptionCreditExpiries: deletedExpiries.length,
    };
  });
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
    // Reported so the caller can tell "there was nothing here" from "we removed it".
    // Deleting an org billing never saw is a pure no-op: this route only DELETEs, so
    // it can never create a billing account, a Stripe customer, or run a welcome
    // evaluation (pinned by tests/integration/internal-account-teardown.test.ts).
    const billingAccountExisted = deletedRows.billingAccounts > 0;
    if (!billingAccountExisted) {
      console.log(
        `[billing-service] teardown org ${orgId}: no billing account — nothing created, ${deletedRows.localPromos} ledger row(s) removed`
      );
    }
    res.json({ ok: true, orgId, billingAccountExisted, deletedRows });
  } catch (err) {
    console.error(`[billing-service] account teardown failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to delete billing account state" });
  }
});

// POST /internal/transfer-brand — a brand moves to another org with its HISTORY,
// never its MONEY (fleet contract, called by brand-service's transfer fan-out).
//
// Moves, in one transaction, every row billing holds per (org, brand):
//   - brand_daily_budgets          (the brand's current daily budget)
//   - brand_daily_budget_changes   (its dated history)
//   - campaign_daily_budgets       (one ceiling per campaign of the brand)
// and rewrites the brand id when `targetBrandId` is given.
//
// Money stays where it is. Nothing in local_promos and no Stripe customer moves:
// a credit, a payment or a card belongs to the org that holds it, whatever brand
// it was bought for. runs-service moves the brand's COST rows to the target org,
// so billing records what moved in `brand_transfers` and balance composition
// leaves it on the org that paid for it (lib/transfer-usage.ts): both orgs read
// the exact balance they read before. The row is also the audit trail.
//
// Org-level state (depletion episodes, reload-retry state, payment mode, promises,
// discount) stays with the org: it describes the org's money, not the brand.
// campaign_authorize_costs is keyed by campaign; its stored org heals on the
// campaign's next authorize, and the affordability read takes the campaign's org
// from its caller (campaign-service), so a moved campaign is gated on the target.
//
// Idempotent: a re-run finds nothing left under the source org, and the moved
// figures are overwritten with runs-service's cumulative answer (unchanged when
// nothing more moved).
router.post("/internal/transfer-brand", async (req, res) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  let result: BrandTransferResult;
  try {
    result = await transferBrand(parsed.data);
  } catch (err) {
    if (err instanceof BrandTransferConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof BrandTransferUpstreamError) {
      console.error("[billing-service] transfer-brand: runs-service read failed:", err);
      res.status(502).json({ error: err.message });
      return;
    }
    throw err;
  }

  res.json({ updatedTables: result.updatedTables, balanceAdjustment: result.balanceAdjustment });
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
// The refusal below IS a depletion (lib/spend-block): an org whose next run
// cannot be authorized is out of credit whatever side of its credit line the
// balance sits on. This route still has ZERO side effects and must keep them —
// the episode for such an org is opened by the hourly blocked-campaign reload
// sweep (lib/campaign-reload-sweep), which is the only path a wedged org can
// reach, since campaign-service stops dispatching before authorize.
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

  // Whose balance gates this campaign: the org campaign-service names on the
  // request (x-org-id — it owns which org a campaign belongs to), else the org
  // stored with the estimate. They differ only for a campaign whose brand moved
  // to another org since its last authorize (POST /internal/transfer-brand); the
  // stored org heals on that campaign's next authorize.
  const headerOrg = req.headers["x-org-id"];
  const orgId =
    typeof headerOrg === "string" && UUID_RE.test(headerOrg) ? headerOrg : stored.orgId;

  // No end-user on this read-only pre-flight. computeBalance reads stripe-service
  // via the user-less /internal/*/by-org/{orgId} routes (X-API-Key + org only) —
  // no x-user-id, no sentinel.
  let snapshot;
  try {
    snapshot = await computeBalance(orgId);
  } catch (err) {
    console.error(
      `[billing-service] affordability: balance compose failed for campaign ${campaignId} (org ${orgId}):`,
      err
    );
    res.status(502).json({ error: "Failed to compute balance" });
    return;
  }

  // The verdict is lib/spend-block's `cannotSpend`, the same predicate the sweep
  // and the dunning tick decide on, applied to THIS campaign's own estimate: a
  // reload-capable org is affordable while its (possibly negative) balance stays
  // within the line, and flips only when the next run would cross past the floor.
  const { floorCents } = await resolveOrgFloor(orgId, snapshot);
  const lastRequiredCents = stored.lastAuthorizeRequiredCents;

  res.json({
    affordable: !cannotSpend(snapshot.balanceCents, lastRequiredCents, floorCents),
    balanceCents: snapshot.balanceCents,
    lastRequiredCents,
    hasHistory: true,
  });
});

// POST /internal/accounts/by-org/:orgId/trial-seed
//
// Put the trial seed on an org that has not signed up — see lib/trial-seed.ts.
// Service-auth + the orgId in the PATH only (no x-org-id / x-user-id, no sentinel
// identity): there is no end user behind an org nobody has signed up for.
router.post("/internal/accounts/by-org/:orgId/trial-seed", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }

  try {
    const result = await seedTrialCredit(orgId);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof TrialSeedWelcomeAlreadyGrantedError) {
      res.status(409).json({
        error:
          "Org already holds the welcome gift — seeding it would take its free credit past the welcome amount",
      });
      return;
    }
    console.error(
      `[billing-service] trial-seed failed for org ${orgId}:`,
      err
    );
    res.status(500).json({ error: "Failed to seed trial credit" });
  }
});

// POST /internal/accounts/by-org/:orgId/org-creation-bonus
//
// Every newly created organization receives a small free credit ONCE, so its first
// setup steps (site read, offer + audience drafts) can run — the welcome gift is once
// per PERSON, so a person's second org otherwise starts at $0. Billing owns the
// amount (the `org_creation_bonus` code row). Not tied to the welcome: granted even
// when the person's welcome lives elsewhere. Idempotent per org. Service-auth + the
// orgId in the PATH only; no body. Creates no billing account and no Stripe customer.
router.post("/internal/accounts/by-org/:orgId/org-creation-bonus", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }

  try {
    const result = await grantOrgCreationBonus(orgId);
    console.log(
      `[billing-service] org-creation bonus: org=${orgId} granted=${result.grantedCents} alreadyGranted=${result.alreadyGranted}`
    );
    res.json({
      ok: true,
      orgId,
      reason: ORG_CREATION_BONUS_CODE,
      grantedCents: result.grantedCents,
      alreadyGranted: result.alreadyGranted,
    });
  } catch (err) {
    console.error(`[billing-service] org-creation bonus failed for org ${orgId}:`, err);
    res.status(500).json({ error: "Failed to grant the organization creation bonus" });
  }
});

// POST /internal/accounts/by-org/:orgId/signup
//
// The org signed up: land its TOTAL free credit on exactly the welcome amount. An
// unseeded org is byte-for-byte unaffected (it receives the whole welcome offer);
// a seeded one receives the remainder. Idempotent. Same auth as the seed above.
router.post("/internal/accounts/by-org/:orgId/signup", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }

  try {
    // Who signed up: the person's internal user id as `x-user-id`. It is what makes
    // the welcome once per PERSON (lib/welcome-recipient). Optional so a caller that
    // has not learned to send it keeps working — loudly, because without it billing
    // cannot tell whether this person already received the welcome elsewhere.
    const rawUserId = req.header("x-user-id");
    if (rawUserId !== undefined && !UUID_RE.test(rawUserId)) {
      res.status(400).json({ error: "x-user-id must be a valid UUID" });
      return;
    }
    const personId = personIdOrNull(rawUserId);
    if (!personId) {
      console.warn(
        `[billing-service] signup settle for org ${orgId} carries no person (x-user-id) — welcome checked per org only`
      );
    }
    const result = await settleSignupWelcome(orgId, personId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(
      `[billing-service] signup free-credit settle failed for org ${orgId}:`,
      err
    );
    res.status(500).json({ error: "Failed to settle signup free credit" });
  }
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
      fetchOrgActualUsageTotal(orgId, {}),
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

// POST /internal/payment-methods/lost — stripe-service tells us an org's last
// chargeable payment method is gone.
//
// It is the only service that can observe `payment_method.detached` and decide
// whether anything chargeable is left; it is NOT the service that knows whether
// the org owes us money. So it reports the EVENT and this route decides: an org
// with a negative balance and no card now carries a debt we cannot collect, and
// is flagged, told, and surfaced to staff immediately rather than an hour later
// on the scan.
//
// Idempotent by construction — the notification is claimed once per depletion
// episode, so a redelivered webhook re-reads the state and sends nothing. An org
// that owes nothing (or still has a card) is a no-op, so a false alarm is free.
router.post("/internal/payment-methods/lost", async (req, res) => {
  try {
    const orgId = (req.body ?? {}).orgId;
    if (typeof orgId !== "string" || !UUID_RE.test(orgId)) {
      res.status(400).json({ error: "orgId must be a valid UUID" });
      return;
    }
    const outcome = await flagUncollectableDebt({ orgId });
    res.json({ orgId, state: outcome.state, owed_cents: outcome.owedCents });
  } catch (err) {
    console.error("[billing-service] payment-method-lost handling failed:", err);
    res.status(502).json({ error: "Failed to evaluate unpaid debt" });
  }
});

// GET /internal/unpaid-debts — every org currently owing money we cannot
// collect, for the staff surface that already reads dunning state.
//
// A plain DB read: the amount was frozen on the depletion episode when the debt
// was flagged and is refreshed on every hourly tick while it persists, so this
// costs one query rather than a balance composition per org.
router.get("/internal/unpaid-debts", async (_req, res) => {
  try {
    const debts = await listUnpaidDebts();
    res.json({
      unpaid_debts: debts.map((d) => ({
        org_id: d.orgId,
        owed_cents: d.owedCents,
        flagged_at: d.flaggedAt,
        episode_started_at: d.episodeStartedAt,
      })),
    });
  } catch (err) {
    console.error("[billing-service] unpaid-debts read failed:", err);
    res.status(502).json({ error: "Failed to read unpaid debts" });
  }
});

// GET /internal/accounts/by-org/:orgId/payment-stopped-periods
//
// When this org's payment had STOPPED, as periods with a beginning and an end.
// The owner's rule: a failed card or credit gone takes the org out of the
// run-rate however active its campaigns look, and billing is the only service
// that can say when that was true.
//
// No new state — TWO existing sources, one per half of the rule:
//   - CREDIT GONE is a credit-depletion episode (opened when the balance falls
//     past the org's credit-line floor, closed when a real recharge lands).
//   - A FAILED CARD is an OPEN failed reload streak
//     (campaign_reload_sweep_attempts): the bank refused and the spaced retry
//     schedule is still walking its rungs. It ends when a reload succeeds or
//     when `credited` moves (a real recharge) — the same test the sweep makes.
// An org can be blocked by a refused card while its balance sits INSIDE its
// credit-line floor, where no episode ever opens, so the second source is not a
// refinement of the first: without it that org reads as paying.
// Overlapping stretches are merged, so a day is never described twice.
// PAST failed streaks are NOT recorded (the attempts row is overwritten in
// place and has no recovered_at), so only the OPEN one is expressible.
//
// Auth: x-api-key only, orgId in the PATH — no x-org-id / x-user-id / sentinel
// identity, same user-less shape as the balance-by-org read above. Pure read.
//
// Resp: { orgId, recordBeginsAt, periods: [{ startedAt, endedAt }] }, oldest
// first; endedAt null while the org is still in it. camelCase matches the
// daily-budget reads this is paired with by the same consumer.
//
// recordBeginsAt is the earliest instant EITHER source recorded fleet-wide (in
// practice the episodes, which are far older): a day before it
// is NOT RECORDED, and the absence of a period there is not evidence that
// payment was on. Note too that an episode opens on an authorize carrying
// campaign activity, so a period means payment had stopped WHILE THE ORG WAS
// TRYING TO SPEND — an org that stopped paying and also stopped working opens
// none. Both facts are stated rather than papered over.
router.get(
  "/internal/accounts/by-org/:orgId/payment-stopped-periods",
  async (req, res) => {
    const { orgId } = req.params;
    if (!UUID_RE.test(orgId)) {
      res.status(400).json({ error: "orgId must be a valid UUID" });
      return;
    }

    try {
      const { recordBeginsAt, periods } = await getPaymentStoppedPeriods(orgId);
      res.json({ orgId, recordBeginsAt, periods });
    } catch (err) {
      console.error(
        `[billing-service] payment-stopped-periods read failed for org ${orgId}:`,
        err
      );
      res.status(502).json({ error: "Failed to read payment-stopped periods" });
    }
  }
);

// GET /internal/accounts/by-org/:orgId/payment-outlook
//
// When will we next take money from this customer, and if never, why not.
//
// No new rule and no new state — this composes what billing already owns: the
// spendable balance and the credit-line floor (lib/balance + lib/spend-block,
// the same predicate the affordability pre-flight and the dunning tick read),
// the retry schedule for a refused card (lib/campaign-reload-sweep), the
// permanently-unusable verdict (lib/card-usability), the month-end settle date
// (lib/month-end-sweep), the realized spend per day (lib/realized-burn, from
// runs-service) and the configured-vs-running ceilings (billing's own tables +
// campaign-service, fail-soft).
//
// THREE THINGS THE PRODUCTION MEASUREMENT CHANGED, each against the obvious
// design, taken over the twelve orgs that spent anything in the fortnight to
// 2026-09-18:
//   - SIX OF TWELVE HAVE NO AUTO-TOPUP. They are never charged automatically;
//     they run out and stop. `no_autopay` therefore carries no date, because a
//     date there would be a fabrication about half the population.
//   - A DATE IS A CHARGE ATTEMPT, NOT A PAYMENT. The two orgs already past
//     their floor are exactly the two whose card the bank is refusing.
//   - THE BURN IS MEASURED, NEVER THE CEILING. Utilisation ran 4% to 146%, so
//     the configured budget is not even an upper bound. All three figures are
//     served side by side and must not be substituted for one another.
//
// A figure that cannot be established honestly is null with a NAMED reason,
// never zero: a consumer that cannot tell "we do not know" from "nothing was
// spent" renders the second, which is a lie about a paying customer.
//
// Auth: x-api-key only, orgId in the PATH — no x-org-id / x-user-id and no
// sentinel identity, the same user-less shape as the reads above. PURE read: it
// opens no episode, charges nothing and changes no retry state. No discount is
// applied to the floor or the ceilings — both are configuration, and the
// per-org usage modifier applies to charges only.
router.get("/internal/accounts/by-org/:orgId/payment-outlook", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }

  try {
    const outlook = await getPaymentOutlook(orgId);
    if (!outlook) {
      res.status(404).json({ error: "No billing account for this org" });
      return;
    }
    res.json(outlook);
  } catch (err) {
    console.error(
      `[billing-service] payment-outlook read failed for org ${orgId}:`,
      err
    );
    res.status(502).json({ error: "Failed to read payment outlook" });
  }
});

// GET /internal/accounts/by-org/:orgId/charge-schedule?horizonDays=90
//
// Every automatic charge billing expects over the horizon, not only the next one
// (see lib/charge-schedule): the payment outlook's decision, replayed forward
// through the same floor-reload and month-end-settle rules the live paths use.
// Consumer: the cash forecast, which must not re-implement those rules. Same
// auth and same pure-read posture as the payment outlook above.
router.get("/internal/accounts/by-org/:orgId/charge-schedule", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }
  const raw = req.query.horizonDays;
  let horizonDays = DEFAULT_CHARGE_SCHEDULE_HORIZON_DAYS;
  if (raw !== undefined) {
    const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CHARGE_SCHEDULE_HORIZON_DAYS) {
      res.status(400).json({
        error: `horizonDays must be an integer from 1 to ${MAX_CHARGE_SCHEDULE_HORIZON_DAYS}`,
      });
      return;
    }
    horizonDays = n;
  }

  try {
    const schedule = await getChargeSchedule(orgId, horizonDays);
    if (!schedule) {
      res.status(404).json({ error: "No billing account for this org" });
      return;
    }
    res.json(schedule);
  } catch (err) {
    console.error(
      `[billing-service] charge-schedule read failed for org ${orgId}:`,
      err
    );
    res.status(502).json({ error: "Failed to read charge schedule" });
  }
});

/** Parse `cashHorizonDays` (default 90). Returns the number or an error string. */
function parseCashHorizon(raw: unknown, min: number): number | string {
  if (raw === undefined) return DEFAULT_CASH_HORIZON_DAYS;
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > MAX_CASH_HORIZON_DAYS) {
    return `cashHorizonDays must be an integer from ${min} to ${MAX_CASH_HORIZON_DAYS}`;
  }
  return n;
}

// GET /internal/revenue/by-org/:orgId?cashHorizonDays=90
//
// The SaaS business for ONE org, in three figures (lib/revenue): its class
// (recurring / one_off / none, with the reason), its recurring revenue
// (DRR, MRR = DRR x 30, ARR = MRR x 12), its one-off money and run-out date,
// the 30/90-day projections, and its charge schedule (the cash). Every input is
// stated on the row, down to the campaigns counted. Consumers: the staff
// Revenue page and features-service's agency/self-serve MRR split. Same auth and
// pure-read posture as the payment outlook: x-api-key, orgId in the PATH.
router.get("/internal/revenue/by-org/:orgId", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }
  const horizon = parseCashHorizon(req.query.cashHorizonDays, 1);
  if (typeof horizon === "string") {
    res.status(400).json({ error: horizon });
    return;
  }
  try {
    const revenue = await getOrgRevenue(orgId, horizon);
    if (!revenue) {
      res.status(404).json({ error: "No billing account for this org" });
      return;
    }
    res.json(revenue);
  } catch (err) {
    console.error(`[billing-service] revenue read failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to read revenue" });
  }
});

// GET /internal/revenue/fleet?cashHorizonDays=90
//
// Every billing account's revenue row, the fleet totals (each the sum of the
// rows shown; unknown rows listed beside, never counted as 0), the 30/90-day
// projections and the cash flow bucketed by day and by ISO week. Org-less:
// x-api-key only. The horizon is at least 90 so the 90-day window is complete.
router.get("/internal/revenue/fleet", async (req, res) => {
  const horizon = parseCashHorizon(req.query.cashHorizonDays, 90);
  if (typeof horizon === "string") {
    res.status(400).json({ error: horizon });
    return;
  }
  try {
    res.json(await getFleetRevenue(horizon));
  } catch (err) {
    console.error("[billing-service] fleet revenue read failed:", err);
    res.status(502).json({ error: "Failed to read fleet revenue" });
  }
});

// POST /internal/accounts/by-org/:orgId/charge — charge a STATED amount
// off-session against the org's saved card, crediting the balance like an
// ordinary topup.
//
// Consumer: the api-service gateway, for the rebuilt sell-first onboarding.
// The first purchase is paid via hosted Checkout (which saves the card); later
// ones are paid one call at a time here, with no second redirect.
//
// No second Stripe integration: the charge is the existing reloadOffSession
// path, so a succeeded charge is mirrored by stripe-service on the same
// request and credited/balance rise immediately (verify via the existing
// balance read).
//
// Every non-success is DISTINGUISHABLE by `code` + HTTP status:
//   200 {ok, charged:true, amountCents, reference}
//   402 charge_declined                    — card declined / money not taken
//   409 no_chargeable_payment_method       — nothing saved to charge
//   409 card_not_chargeable_off_session    — issuing country can't be charged
//   429 charge_backoff                     — recent failure; retry later
//   502 upstream_error                     — stripe-service unreachable/errored
// So the dashboard can fall back to hosted checkout exactly on a 402/409 and
// treat a 502 as "try again", never as a decline.
router.post("/internal/accounts/by-org/:orgId/charge", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a valid UUID" });
    return;
  }

  const parsed = OnDemandChargeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { amountCents, idempotencyKey } = parsed.data;
  if (amountCents < STRIPE_MIN_CHARGE_CENTS) {
    res.status(400).json({
      error: `amountCents must be at least ${STRIPE_MIN_CHARGE_CENTS} (Stripe minimum charge)`,
    });
    return;
  }

  try {
    const result = await chargeOrgOnDemand(orgId, amountCents, idempotencyKey);
    res.json({
      ok: true,
      charged: true,
      amountCents: result.amountCents,
      reference: result.reference,
    });
  } catch (err) {
    if (err instanceof OnDemandChargeError) {
      const status =
        err.code === "charge_declined"
          ? 402
          : err.code === "charge_backoff"
            ? 429
            : err.code === "upstream_error"
              ? 502
              : 409;
      console.error(
        `[billing-service] on-demand charge of ${amountCents} cents failed ` +
          `for org ${orgId}: [${err.code}] ${err.message}`
      );
      res.status(status).json({
        ok: false,
        charged: false,
        amountCents,
        code: err.code,
        error: err.message,
      });
      return;
    }
    console.error(
      `[billing-service] on-demand charge errored for org ${orgId}:`,
      err
    );
    res.status(502).json({ error: "Failed to charge the saved card" });
  }
});

export default router;
