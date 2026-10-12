/**
 * A subscription trial IS the org's whole free offer (owner 2026-10-12: « Le gars est
 * arrivé avec un $99/mo - 3 day trial: ok. On ne devrait donc pas lui donner $30 de
 * free credits en plus »).
 *
 * Prod case (org 62594115-…): match_100 org, $30 onboarding credit at signup, welcome
 * promise $100 @ $100, then a $99 trial topped up by $69. The dashboard listed
 * "Welcome credits, $31 to come" and drew "Trial credit left … of $69". Pinned here:
 *   - the trial withdraws the welcome / match offer, whatever the order;
 *   - the subscription read serves the WHOLE trial credit (9900), trial_credit_cents;
 *   - the $30 is counted once, as trial credit (never also as the match_100 advance);
 *   - a prepaid match_100 org is unchanged;
 *   - migration 0084 cleans orgs that already hold both, idempotently.
 *
 * Own file: other suites close the shared connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount, insertTestPromoGrant } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db, sql } from "../../src/db/index.js";
import { billingAccounts, freeCreditPromises, localPromoCodes, WELCOME_PROMO_CODE } from "../../src/db/schema.js";
import { startSubscription, grantSubscriptionTrial } from "../../src/lib/subscription.js";
import { ensureWelcomePromise } from "../../src/lib/free-credit-promises.js";
import { settleWelcomeCompletion } from "../../src/lib/welcome-completion.js";

const orgId = "00000000-0000-0000-0000-0000000008a1";
const userId = "00000000-0000-0000-0000-0000000008a9";
const headers = getAuthHeaders(orgId, userId);
const cents = (n: number) => `${n}.0000000000`;

const REVOLUT_CARD = {
  object: "saved_payment_method",
  org_id: orgId,
  acquirer: "revolut",
  saved: true,
  method: { id: "rpm_1", type: "card", saved_for: "merchant", funding: "debit", prepaid: false },
};

describe("a subscription trial is the org's whole free offer", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@new.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(0));
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.getSavedPaymentMethod.mockResolvedValue(REVOLUT_CARD);

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({ spent_cents: cents(0) } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({ spent_cents: cents(0) } as never);
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("00000000-0000-0000-0000-00000000a001");
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined);
    const cs = await import("../../src/lib/campaign-service-client.js");
    vi.spyOn(cs, "fetchSpendableBudget").mockResolvedValue(null);
    vi.spyOn(cs, "fetchRecurringCampaignStatuses").mockResolvedValue({ ok: true, campaigns: [] });
    const ctx = await import("../../src/lib/budget-change-context.js");
    vi.spyOn(ctx, "fetchOrgIdentity").mockResolvedValue({ name: "Acme", externalId: "org_clerk1" });
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
    await db.update(localPromoCodes).set({ amountCents: 3000 }).where(eq(localPromoCodes.code, WELCOME_PROMO_CODE));
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** The prod shape: match_100 org, $30 onboarding credit at signup, welcome promise $100 @ $100. */
  async function match100Org() {
    await insertTestAccount({
      orgId,
      freeCreditOffer: "match_100",
      welcomeCompletionEligible: true,
      freeCreditEntitlementCents: 10000,
      freeCreditPaidTriggerCents: 10000,
    });
    await insertTestPromoGrant({ orgId, userId, amountCents: 3000, promoCode: "org_creation_bonus" });
  }

  async function outstandingWelcome() {
    const res = await request(app).get("/v1/free-credit-promises").set(headers);
    expect(res.status).toBe(200);
    return {
      total: res.body.outstanding_total_cents as string,
      welcome: (res.body.promises as Array<{ kind: string }>).filter((p) => p.kind === "welcome"),
    };
  }

  it("promise BEFORE the trial: the trial withdraws it; nothing to come, never granted", async () => {
    await match100Org();
    await ensureWelcomePromise(orgId);
    expect((await outstandingWelcome()).welcome).toHaveLength(1);

    await startSubscription({ orgId, userId, monthlyAmountCents: 9900 });

    const after = await outstandingWelcome();
    expect(after.welcome).toHaveLength(0);
    expect(after.total).toBe("0.0000000000");
    // Paying $100 (2nd month) never lands the match on top of the trial.
    const outcome = await settleWelcomeCompletion(orgId, cents(10000));
    expect(outcome.granted).toBe(false);
    const [acct] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
    expect(acct.freeCreditEntitlementCents).toBe(0);
    expect(acct.freeCreditPaidTriggerCents).toBe(0);
  });

  it("promise AFTER the trial: it mirrors the withdrawn offer and is never listed", async () => {
    await match100Org();
    await grantSubscriptionTrial(orgId);
    await ensureWelcomePromise(orgId);
    expect((await outstandingWelcome()).welcome).toHaveLength(0);
  });

  it("the subscription read serves the WHOLE trial credit: $30 + $69 = 9900", async () => {
    await match100Org();
    await startSubscription({ orgId, userId, monthlyAmountCents: 9900 });
    const res = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.trial_grant_cents).toBe(6900);
    expect(res.body.trial_credit_cents).toBe(9900);
    expect(res.body.credits_remaining_cents).toBe(cents(9900));
  });

  it("the $30 is counted ONCE, as trial credit: no match_100 advance, gifted never negative", async () => {
    await match100Org();
    await startSubscription({ orgId, userId, monthlyAmountCents: 9900 });
    const res = await request(app).get("/v1/accounts").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.credited_cents).toBe(cents(9900));
    expect(res.body.credited_trial_advance_cents).toBe(cents(9900));
    expect(res.body.credited_advance_cents).toBe(cents(0));
    expect(res.body.credited_gifted_cents).toBe(cents(0));
    expect(res.body.free_credit_pending_cents).toBe(cents(0));
  });

  it("a subscription read with no trial ever: trial_credit_cents is null", async () => {
    await match100Org();
    const res = await request(app).get("/v1/accounts/subscription").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.trial_grant_cents).toBeNull();
    expect(res.body.trial_credit_cents).toBeNull();
  });

  it("a prepaid match_100 org (no trial) is unchanged: $30 advance, $100 match to come", async () => {
    await match100Org();
    await ensureWelcomePromise(orgId);
    const promises = await outstandingWelcome();
    expect(promises.welcome).toHaveLength(1);
    const res = await request(app).get("/v1/accounts").set(headers);
    expect(res.body.credited_advance_cents).toBe(cents(3000));
    expect(res.body.free_credit_pending_cents).toBe(cents(10000));
  });

  it("migration 0084 cleans an org that already holds both, and a replay moves nothing", async () => {
    await match100Org();
    await ensureWelcomePromise(orgId);
    await grantSubscriptionTrial(orgId);
    // Put back the pre-fix state (the offer and the promise still live beside the trial).
    await db
      .update(billingAccounts)
      .set({ freeCreditEntitlementCents: 10000, freeCreditPaidTriggerCents: 10000 })
      .where(eq(billingAccounts.orgId, orgId));
    await db
      .update(freeCreditPromises)
      .set({ amountCents: 10000, paidTriggerCents: 10000 })
      .where(and(eq(freeCreditPromises.orgId, orgId), eq(freeCreditPromises.kind, "welcome")));
    expect((await outstandingWelcome()).welcome).toHaveLength(1);

    const migration = readFileSync("drizzle/0084_subscription_trial_withdraws_welcome_offer.sql", "utf8");
    const statements = migration.split("--> statement-breakpoint");
    for (const pass of [1, 2]) {
      for (const stmt of statements) await sql.unsafe(stmt);
      const [acct] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
      expect(acct.freeCreditEntitlementCents, `pass ${pass}`).toBe(0);
      expect((await outstandingWelcome()).welcome, `pass ${pass}`).toHaveLength(0);
    }
  });
});
