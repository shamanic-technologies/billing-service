import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { flagUncollectableDebt } from "../../src/lib/unpaid-debt.js";
import { TRIAL_SEED_TARGET_CENTS } from "../../src/db/schema.js";

/**
 * An org that holds credit and has NO Stripe customer can spend that credit.
 *
 * A visitor walks the whole onboarding before signing up, against an org billing
 * seeds with a trial credit. Nothing creates a Stripe customer before signup —
 * there is no email, no identity and no card — so every balance composition read
 * stripe-service's 404 as a failure and answered 502. Measured in prod
 * 2026-09-19: 81 authorize failures across three anonymous orgs, every site
 * extraction and ICP draft dead, and the seed unspendable.
 *
 * The org is STRICTLY PREPAID: no card, no paid top-ups, no credit line, no
 * auto-reload. It spends its seed down to zero and is refused after that, which
 * is the cap. Nothing about an org that DOES have a customer changes.
 */
describe("an org with credit and no Stripe customer", () => {
  const app = createTestApp();
  const anonOrg = "00000000-0000-0000-0000-0000000000f1";
  const userId = "00000000-0000-0000-0000-0000000000f9";
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setRequired: (cents: string) => void;
  let setUsage: (cents: string) => void;

  const serviceHeaders = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    // stripe-service's DEFINITE "this org has no customer" (its 404).
    ssMocks.fetchOrgCustomerOrNull.mockResolvedValue(null);
    ssMocks.getCustomerByOrgOrNull.mockResolvedValue(null);
    await cleanTestData();

    const costsClient = await import("../../src/lib/costs-client.js");
    let required = "10.0000000000";
    setRequired = (cents: string) => {
      required = cents;
    };
    vi.spyOn(costsClient, "resolveRequiredCents").mockImplementation(async () => required);

    const runsClient = await import("../../src/lib/runs-client.js");
    let usage = "0.0000000000";
    setUsage = (cents: string) => {
      usage = cents;
    };
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: anonOrg,
      spent_cents: usage,
      as_of: "2026-09-19T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** Seed the org through the real route, exactly as the consumer does. */
  async function seed() {
    const res = await request(app)
      .post(`/internal/accounts/by-org/${anonOrg}/trial-seed`)
      .set(serviceHeaders)
      .send({});
    expect(res.status).toBe(200);
    return res.body.seededCents as number;
  }

  const authorizeBody = {
    items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }],
    description: "anonymous onboarding site extraction",
  };

  it("authorizes a spend that fits in the seed", async () => {
    const seeded = await seed();
    expect(seeded).toBe(TRIAL_SEED_TARGET_CENTS);
    setRequired("10.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(anonOrg, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(res.body.balance_cents).toBe(`${seeded}.0000000000`);
    // No customer → none of the three Stripe reads is even issued. They cannot
    // answer anything but 404: no payment and no payment method can exist
    // without a customer.
    expect(ssMocks.sumSucceededTopupsForOrg).not.toHaveBeenCalled();
    expect(ssMocks.hasChargeablePmForOrg).not.toHaveBeenCalled();
    expect(ssMocks.getOrgCardCountryByOrg).not.toHaveBeenCalled();
  });

  it("refuses the ordinary way once the seed no longer covers the spend", async () => {
    const seeded = await seed();
    setUsage(`${seeded}.0000000000`); // seed fully consumed → balance 0
    setRequired("10.0000000000");

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(anonOrg, userId))
      .send(authorizeBody);

    // The normal insufficient-credit outcome — NOT a 502, and no reload: a
    // customer-less org has no card, so it gets no credit line (floor "0").
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(res.body.balance_cents).toBe("0.0000000000");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("is refused at the floor rather than running up a credit line", async () => {
    const seeded = await seed();
    setUsage("0.0000000000");
    // A single spend larger than everything the org holds.
    setRequired(`${seeded + 1}.0000000000`);

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(anonOrg, userId))
      .send(authorizeBody);

    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
  });

  it("serves the seed on the user-less balance read", async () => {
    const seeded = await seed();
    setUsage("1.0000000000");

    const res = await request(app)
      .get(`/internal/accounts/by-org/${anonOrg}/balance`)
      .set({ "X-API-Key": "test-api-key" });

    expect(res.status).toBe(200);
    expect(res.body.balance_cents).toBe(`${seeded - 1}.0000000000`);
    expect(res.body.depleted).toBe(false);
    expect(res.body.has_auto_topup).toBe(false);
  });

  it("serves the account read with the seed as gifted credit and no card", async () => {
    const seeded = await seed();

    const res = await request(app)
      .get("/v1/accounts")
      .set(getAuthHeaders(anonOrg, userId));

    expect(res.status).toBe(200);
    expect(res.body.credited_paid_cents).toBe("0.0000000000");
    expect(res.body.credited_gifted_cents).toBe(`${seeded}.0000000000`);
    expect(res.body.credited_cents).toBe(`${seeded}.0000000000`);
    expect(res.body.has_payment_method).toBe(false);
    expect(res.body.has_auto_topup).toBe(false);
    expect(res.body.card_country).toBeNull();
  });

  it("refuses auto-topup with a 400 naming the missing card, never a 502", async () => {
    await seed();

    const res = await request(app)
      .patch("/v1/accounts/auto_topup")
      .set(getAuthHeaders(anonOrg, userId))
      .send({ topup_amount_cents: 5000, topup_threshold_cents: 5000 });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/payment method/i);
  });

  it("never flags an uncollectable debt, and tells nobody", async () => {
    await seed();
    const emailClient = await import("../../src/lib/email-client.js");
    const sendEmail = vi.spyOn(emailClient, "sendEmail").mockResolvedValue(undefined);
    setUsage("100000.0000000000"); // far past anything the seed covers

    const outcome = await flagUncollectableDebt({ orgId: anonOrg });

    // No billing relationship to collect against and no address to write to.
    expect(outcome.state).toBe("no_customer");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("still fails LOUD when stripe-service cannot be asked at all", async () => {
    await seed();
    // NOT a 404. "We could not ask" must never read as "there is no customer" —
    // that would answer no card / no payments / no credit line during an outage.
    ssMocks.fetchOrgCustomerOrNull.mockRejectedValue(
      new Error("stripe-service GET /internal/customers/by-org/x failed: 503 upstream")
    );

    const res = await request(app)
      .post("/v1/customer_balance/authorize")
      .set(getAuthHeaders(anonOrg, userId))
      .send(authorizeBody);

    expect(res.status).toBe(502);
  });
});
