import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestPromoGrant,
  removeWelcomeCompletionCode,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  WELCOME_COMPLETION_CODE,
  WELCOME_COMPLETION_LAUNCH_AT_MS,
} from "../../src/db/schema.js";
import {
  settleWelcomeCompletion,
  WelcomeCompletionPromoCodeMissingError,
} from "../../src/lib/welcome-completion.js";
import { runWelcomeCompletionSweep } from "../../src/lib/welcome-completion-sweep.js";

/**
 * The notice a GRANDFATHERED ($25/$25) org sees — byte-equal to the string this
 * service shipped before the offer became per-account. `insertTestAccount` defaults
 * to that cohort, so every case in this suite quotes it.
 */
const GRANDFATHERED_NOTICE =
  "You get $25 in free credits. $5 now, the rest once your payments reach $25.";
const orgId = "00000000-0000-0000-0000-0000000000c1";
const userId = "00000000-0000-0000-0000-0000000000c2";

/** Every completion row for the org, so tests can assert exactly-once. */
async function completionRows(org: string) {
  return db
    .select({ amountCents: localPromos.amountCents, description: localPromos.description })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(eq(localPromoCodes.code, WELCOME_COMPLETION_CODE));
}

/** An eligible org that already carries the $5 signup welcome gift. */
async function newPayingOrg(paidTopupsCents: string, ssMocks: ReturnType<typeof setupStripeMocks>) {
  await insertTestAccount({ orgId, welcomeCompletionEligible: true });
  await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
  ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue(paidTopupsCents);
  ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(paidTopupsCents);
}

/** A day before the automation launched — a "pre-existing org" fixture. */
const BEFORE_LAUNCH = new Date(WELCOME_COMPLETION_LAUNCH_AT_MS - 86_400_000);

/**
 * One of the orgs that already existed when the automation launched: carries the $5
 * welcome row, eligible (migration 0030 gave every pre-existing account its
 * eligibility back), and its paid topups are mocked BOTH as of today and as of the
 * launch instant — the two figures are what decide whether the gift is owed.
 */
async function preLaunchOrg(
  paidTopupsCents: string,
  paidBeforeLaunchCents: string,
  ssMocks: ReturnType<typeof setupStripeMocks>
) {
  await insertTestAccount({
    orgId,
    welcomeCompletionEligible: true,
    createdAt: BEFORE_LAUNCH,
  });
  await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
  ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue(paidTopupsCents);
  ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(paidTopupsCents);
  ssMocks.sumPaidTopupsForOrgAsOf.mockResolvedValue(paidBeforeLaunchCents);
}

async function isEligible(org: string): Promise<boolean> {
  const [row] = await db
    .select({ eligible: billingAccounts.welcomeCompletionEligible })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, org));
  return row.eligible;
}

// Every fixture here is a GRANDFATHERED account (insertTestAccount defaults to the
// $25/$25 offer), so this suite is also the regression guard that the re-price left
// pre-existing orgs byte-identical. The $400 cohort lives in
// tests/integration/free-credit-offer-cohorts.test.ts.
describe("welcome-completion gift ($25 grandfathered offer)", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // --- AC1 / AC2: the gift lands, derived from what the org was actually gifted ---

  // REMOVED SURFACE: the up-front checkout discount. A first checkout at the old
  // floor (entitlement + trigger = $50 here) used to carry a pre-applied coupon.
  // It now carries the notice like every other checkout, and the gift is granted
  // after the fact. Setting the coupon env var must not resurrect it.
  it("removed: a first checkout at the old discount floor carries no discount", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
    // Never paid yet — the condition the discount used to require.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    ssMocks.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_x",
      session_id: "cs_x",
    });

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/s",
        cancel_url: "https://example.com/c",
        topup_amount_cents: 5000,
      });

    const body = ssMocks.createCheckoutSession.mock.calls[0][1];
    expect(body).not.toHaveProperty("discounts");
    // The notice takes its place, and the buyer is charged the full amount.
    expect(body.custom_text.submit.message).toContain("free credits");
    expect(body.line_items[0].price_data.unit_amount).toBe(5000);

    // Paying the full $50 earns the completion; credit is payment + the gift.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("5000.0000000000");
    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.credited_paid_cents).toBe("5000.0000000000");
    expect(res.body.credited_gifted_cents).toBe("2500.0000000000");
    expect(res.body.credited_cents).toBe("7500.0000000000");
  });

  it("AC2: $32 first checkout gets no discount and $57 of credit (gift on top)", async () => {
    await newPayingOrg("3200.0000000000", ssMocks);

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(res.body.credited_paid_cents).toBe("3200.0000000000");
    // $5 welcome + $20 completion = the full $25 entitlement.
    expect(res.body.credited_gifted_cents).toBe("2500.0000000000");
    expect(res.body.credited_cents).toBe("5700.0000000000");
  });

  it("completion amount is DERIVED from grants, not a hardcoded $20 (no welcome row → full $25)", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("2500.0000000000");

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(res.body.credited_gifted_cents).toBe("2500.0000000000");
    expect((await completionRows(orgId))[0].amountCents).toBe("2500.0000000000");
  });

  it("a re-priced welcome ($10) leaves a $15 completion — entitlement stays $25", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    await insertTestPromoGrant({ orgId, userId, amountCents: 1000, promoCode: "welcome" });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("2500.0000000000");

    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect((await completionRows(orgId))[0].amountCents).toBe("1500.0000000000");
  });

  it("an org already gifted its full $25 receives no completion", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    await insertTestPromoGrant({ orgId, userId, amountCents: 2500, promoCode: "invite_welcome" });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("9000.0000000000");

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(await completionRows(orgId)).toHaveLength(0);
    expect(res.body.credited_gifted_cents).toBe("2500.0000000000");
  });

  // --- AC3: below the trigger, nothing lands; it lands later, automatically ---

  it("AC3: $8 first checkout gets no discount, no gift; the gift lands once payments reach $25", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    ssMocks.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_x",
      session_id: "cs_x",
    });

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/s",
        cancel_url: "https://example.com/c",
        topup_amount_cents: 800,
      });

    const body = ssMocks.createCheckoutSession.mock.calls[0][1];
    // Below the $50 floor → no discount, but the promise is shown.
    expect(body).not.toHaveProperty("discounts");
    expect(body.custom_text).toEqual({
      submit: { message: GRANDFATHERED_NOTICE },
    });

    // $8 paid: $13 of credit, no gift yet.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("800.0000000000");
    let res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(res.body.credited_cents).toBe("1300.0000000000");
    expect(await completionRows(orgId)).toHaveLength(0);

    // Cumulative payments reach $25 → the completion lands on its own.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("2500.0000000000");
    res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(res.body.credited_gifted_cents).toBe("2500.0000000000");
    expect(await completionRows(orgId)).toHaveLength(1);
  });

  it("$24.99 of payments does not earn it; $25.00 exactly does", async () => {
    await newPayingOrg("2499.0000000000", ssMocks);
    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(await completionRows(orgId)).toHaveLength(0);

    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("2500.0000000000");
    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(await completionRows(orgId)).toHaveLength(1);
  });

  // --- AC4: only the FIRST checkout can be discounted ---

  it("AC4: a second / third / tenth top-up by an already-paying org is never discounted", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    ssMocks.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_x",
      session_id: "cs_x",
    });

    for (const paid of ["100.0000000000", "5000.0000000000", "100000.0000000000"]) {
      ssMocks.createCheckoutSession.mockClear();
      ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue(paid);
      await request(app)
        .post("/v1/checkout-sessions")
        .set(getAuthHeaders(orgId))
        .send({
          success_url: "https://example.com/s",
          cancel_url: "https://example.com/c",
          topup_amount_cents: 20000,
        });
      const body = ssMocks.createCheckoutSession.mock.calls[0][1];
      expect(body).not.toHaveProperty("discounts");
    }
  });

  it("a $49.99 first checkout is not discounted (floor would push the charge under $25)", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    ssMocks.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_x",
      session_id: "cs_x",
    });

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/s",
        cancel_url: "https://example.com/c",
        topup_amount_cents: 4999,
      });

    const body = ssMocks.createCheckoutSession.mock.calls[0][1];
    expect(body).not.toHaveProperty("discounts");
    expect(body.custom_text).toEqual({
      submit: { message: GRANDFATHERED_NOTICE },
    });
  });

  it("the discount is withheld when the completion could not be granted (missing ledger key)", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    ssMocks.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_x",
      session_id: "cs_x",
    });
    await removeWelcomeCompletionCode();

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/s",
        cancel_url: "https://example.com/c",
        topup_amount_cents: 5000,
      });

    const body = ssMocks.createCheckoutSession.mock.calls[0][1];
    expect(body).not.toHaveProperty("discounts");
  });

  it("the discount is withheld when no coupon is configured", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    ssMocks.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_x",
      session_id: "cs_x",
    });

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/s",
        cancel_url: "https://example.com/c",
        topup_amount_cents: 5000,
      });

    const body = ssMocks.createCheckoutSession.mock.calls[0][1];
    expect(body).not.toHaveProperty("discounts");
    expect(body.custom_text).toEqual({
      submit: { message: GRANDFATHERED_NOTICE },
    });
  });

  it("an ineligible org sees neither a discount nor the notice (the gift is not coming)", async () => {
    await insertTestAccount({ orgId }); // welcomeCompletionEligible defaults false
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("0.0000000000");
    ssMocks.createCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_x",
      session_id: "cs_x",
    });

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        success_url: "https://example.com/s",
        cancel_url: "https://example.com/c",
        topup_amount_cents: 5000,
      });

    const body = ssMocks.createCheckoutSession.mock.calls[0][1];
    expect(body).not.toHaveProperty("discounts");
    expect(body).not.toHaveProperty("custom_text");
  });

  // --- AC5: exactly once, under replay + concurrency ---

  it("AC5: replaying the same payment grants the completion exactly once", async () => {
    await newPayingOrg("2500.0000000000", ssMocks);

    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(await completionRows(orgId)).toHaveLength(1);
    expect(res.body.credited_gifted_cents).toBe("2500.0000000000");
  });

  it("concurrent settles grant the completion exactly once", async () => {
    await newPayingOrg("2500.0000000000", ssMocks);

    const outcomes = await Promise.all([
      settleWelcomeCompletion(orgId, "2500.0000000000"),
      settleWelcomeCompletion(orgId, "2500.0000000000"),
      settleWelcomeCompletion(orgId, "2500.0000000000"),
    ]);

    expect(outcomes.filter((o) => o.granted)).toHaveLength(1);
    expect(await completionRows(orgId)).toHaveLength(1);
  });

  // --- AC8: "no backfill" excludes ONE population — the orgs that had already
  // crossed the $25 trigger before the automation launched. Every other
  // pre-existing org still earns it on its future payments. ---

  it("AC8: an org already excluded receives nothing, whatever it has paid", async () => {
    await insertTestAccount({ orgId }); // welcomeCompletionEligible defaults false
    await insertTestPromoGrant({ orgId, userId, amountCents: 200, promoCode: "welcome" });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("100000.0000000000");
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100000.0000000000");

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    const sweep = await runWelcomeCompletionSweep();

    expect(await completionRows(orgId)).toHaveLength(0);
    expect(sweep.candidates).toBe(0); // not even a candidate
    expect(sweep.granted).toBe(0);
    // Untouched: still the old $2-era welcome row only.
    expect(res.body.credited_gifted_cents).toBe("200.0000000000");
  });

  it("a pre-existing org that had NOT reached $25 before launch earns it on its future payments", async () => {
    // The population the automation exists for: signed up long ago, holds the $5
    // welcome row, had paid nothing when the feature shipped.
    await preLaunchOrg("0.0000000000", "0.0000000000", ssMocks);

    // Nothing yet — payments are below the trigger.
    let res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(await completionRows(orgId)).toHaveLength(0);
    expect(res.body.credited_gifted_cents).toBe("500.0000000000");

    // It pays $25 AFTER launch → the gift lands on its own, no hand-granting.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("2500.0000000000");
    res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect((await completionRows(orgId))[0].amountCents).toBe("2000.0000000000");
    expect(res.body.credited_gifted_cents).toBe("2500.0000000000");
    // Still eligible on the row — it was granted, not excluded.
    expect(await isEligible(orgId)).toBe(true);
  });

  it("the hourly sweep grants it to a pre-existing under-trigger org with no request traffic", async () => {
    await preLaunchOrg("2500.0000000000", "0.0000000000", ssMocks);

    const sweep = await runWelcomeCompletionSweep();

    expect(sweep.candidates).toBe(1);
    expect(sweep.granted).toBe(1);
    expect((await completionRows(orgId))[0].amountCents).toBe("2000.0000000000");
  });

  it("a pre-existing org that had ALREADY crossed $25 before launch receives nothing, now or later", async () => {
    // Its $1000 of payments all pre-date the launch: the trigger was satisfied
    // before the offer existed, so granting would be the retroactive credit the
    // product owner ruled out.
    await preLaunchOrg("100000.0000000000", "100000.0000000000", ssMocks);

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(await completionRows(orgId)).toHaveLength(0);
    expect(res.body.credited_gifted_cents).toBe("500.0000000000");
    // The answer is frozen on the account, so it is never re-derived...
    expect(await isEligible(orgId)).toBe(false);
    // ...and it drops out of the sweep permanently.
    const sweep = await runWelcomeCompletionSweep();
    expect(sweep.candidates).toBe(0);
    expect(sweep.granted).toBe(0);

    // Later payments do not resurrect it either.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("200000.0000000000");
    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(await completionRows(orgId)).toHaveLength(0);
  });

  it("re-resolving an excluded pre-existing org changes nothing (idempotent on immutable history)", async () => {
    await preLaunchOrg("100000.0000000000", "100000.0000000000", ssMocks);

    // Two settles = the resolution applied twice, as a re-applied migration would.
    const first = await settleWelcomeCompletion(
      orgId,
      "100000.0000000000"
    );
    // Simulate migration 0030 being re-applied: eligibility handed back.
    await db
      .update(billingAccounts)
      .set({ welcomeCompletionEligible: true })
      .where(eq(billingAccounts.orgId, orgId));
    const second = await settleWelcomeCompletion(
      orgId,
      "100000.0000000000"
    );

    expect(first.reason).toBe("trigger_crossed_before_launch");
    expect(second.reason).toBe("trigger_crossed_before_launch");
    expect(await isEligible(orgId)).toBe(false);
    expect(await completionRows(orgId)).toHaveLength(0);
  });

  it("a pre-existing org already gifted its full $25 receives nothing, whatever its payment history", async () => {
    await insertTestAccount({
      orgId,
      welcomeCompletionEligible: true,
      createdAt: BEFORE_LAUNCH,
    });
    await insertTestPromoGrant({ orgId, userId, amountCents: 2500, promoCode: "invite_welcome" });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("9000.0000000000");
    ssMocks.sumPaidTopupsForOrgAsOf.mockResolvedValue("0.0000000000");

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(await completionRows(orgId)).toHaveLength(0);
    expect(res.body.credited_gifted_cents).toBe("2500.0000000000");
    // The entitlement ceiling stops it before the grandfather check is even asked.
    expect(ssMocks.sumPaidTopupsForOrgAsOf).not.toHaveBeenCalled();
  });

  it("an account created AFTER launch is never demoted and never pays for the extra read", async () => {
    // A brand-new signup: no pre-launch payments exist by construction, so the
    // grandfather check must be skipped entirely — even if the pre-launch read
    // would have answered "over the trigger".
    await newPayingOrg("2500.0000000000", ssMocks);
    ssMocks.sumPaidTopupsForOrgAsOf.mockResolvedValue("100000.0000000000");

    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect((await completionRows(orgId))[0].amountCents).toBe("2000.0000000000");
    expect(await isEligible(orgId)).toBe(true);
    expect(ssMocks.sumPaidTopupsForOrgAsOf).not.toHaveBeenCalled();
  });

  // --- The server-side driver ---

  it("the hourly sweep grants the completion with no request traffic at all", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("2500.0000000000");

    const first = await runWelcomeCompletionSweep();
    expect(first.candidates).toBe(1);
    expect(first.granted).toBe(1);
    expect((await completionRows(orgId))[0].amountCents).toBe("2000.0000000000");

    // Granted orgs drop out of the candidate set permanently.
    const second = await runWelcomeCompletionSweep();
    expect(second.candidates).toBe(0);
    expect(second.granted).toBe(0);
  });

  it("the sweep isolates a per-org failure and keeps going", async () => {
    const otherOrg = "00000000-0000-0000-0000-0000000000c9";
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    await insertTestAccount({ orgId: otherOrg, welcomeCompletionEligible: true });
    ssMocks.sumSucceededTopupsForOrg.mockImplementation(async (org: string) => {
      if (org === orgId) throw new Error("stripe-service down");
      return "2500.0000000000";
    });

    const result = await runWelcomeCompletionSweep();

    expect(result.failed).toBe(1);
    expect(result.granted).toBe(1);
  });

  it("fails loud when the ledger key is missing — never silently skips the grant", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    await removeWelcomeCompletionCode();

    await expect(
      settleWelcomeCompletion(orgId, "2500.0000000000")
    ).rejects.toThrow(WelcomeCompletionPromoCodeMissingError);
  });

  it("propagates the missing-ledger-key failure to the account read as a 502", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("2500.0000000000");
    await removeWelcomeCompletionCode();

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(res.status).toBe(502);
  });

  // --- AC7: the paid / gifted split is served, never computed client-side ---

  it("AC7: credited_cents decomposes exactly into credited_paid_cents + credited_gifted_cents", async () => {
    await insertTestAccount({ orgId });
    await insertTestPromoGrant({ orgId, userId, amountCents: 2500, promoCode: "welcome" });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("700.0000000000");

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    // Kevin's requested view: "Credit paid Stripe $7 / Welcome credits $25".
    expect(res.body.credited_paid_cents).toBe("700.0000000000");
    expect(res.body.credited_gifted_cents).toBe("2500.0000000000");
    expect(res.body.credited_cents).toBe("3200.0000000000");
  });
});
