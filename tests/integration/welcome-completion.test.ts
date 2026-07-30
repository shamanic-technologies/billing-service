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
import { localPromoCodes, localPromos, WELCOME_COMPLETION_CODE } from "../../src/db/schema.js";
import {
  settleWelcomeCompletion,
  WelcomeCompletionPromoCodeMissingError,
  WELCOME_COMPLETION_CHECKOUT_NOTICE,
} from "../../src/lib/welcome-completion.js";
import { runWelcomeCompletionSweep } from "../../src/lib/welcome-completion-sweep.js";

const COUPON_ID = "coupon_welcome25";
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

describe("welcome-completion gift ($25 total free credits)", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    process.env.WELCOME_DISCOUNT_COUPON_ID = COUPON_ID;
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
  });

  afterAll(async () => {
    delete process.env.WELCOME_DISCOUNT_COUPON_ID;
    await cleanTestData();
    await closeDb();
  });

  // --- AC1 / AC2: the gift lands, derived from what the org was actually gifted ---

  it("AC1: $50 first checkout is discounted $25, the buyer pays $25, credit lands at $50", async () => {
    await insertTestAccount({ orgId, welcomeCompletionEligible: true });
    await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
    // Never paid yet at checkout-create time.
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
    // Visible $25 off, and no notice (Stripe renders the discount line itself).
    expect(body.discounts).toEqual([{ coupon: COUPON_ID }]);
    expect(body).not.toHaveProperty("custom_text");
    // Full $50 is still the line item — Stripe applies the discount at pay time.
    expect(body.line_items[0].price_data.unit_amount).toBe(5000);

    // Buyer pays the discounted $25 → the completion is earned.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("2500.0000000000");
    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.credited_paid_cents).toBe("2500.0000000000");
    expect(res.body.credited_gifted_cents).toBe("2500.0000000000");
    expect(res.body.credited_cents).toBe("5000.0000000000");
    expect(res.body.balance_cents).toBe("5000.0000000000");
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
      submit: { message: WELCOME_COMPLETION_CHECKOUT_NOTICE },
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
      submit: { message: WELCOME_COMPLETION_CHECKOUT_NOTICE },
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
    delete process.env.WELCOME_DISCOUNT_COUPON_ID;
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
      submit: { message: WELCOME_COMPLETION_CHECKOUT_NOTICE },
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

  // --- AC8: no backfill ---

  it("AC8: an ineligible (pre-existing) org never receives a completion grant", async () => {
    await insertTestAccount({ orgId }); // ineligible, like every prod org at ship time
    await insertTestPromoGrant({ orgId, userId, amountCents: 200, promoCode: "welcome" });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("100000.0000000000");
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("100000.0000000000");

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    const sweep = await runWelcomeCompletionSweep();

    expect(await completionRows(orgId)).toHaveLength(0);
    expect(sweep.granted).toBe(0);
    // Untouched: still the old $2-era welcome row only.
    expect(res.body.credited_gifted_cents).toBe("200.0000000000");
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

    await expect(settleWelcomeCompletion(orgId, "2500.0000000000")).rejects.toThrow(
      WelcomeCompletionPromoCodeMissingError
    );
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
