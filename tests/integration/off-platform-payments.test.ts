import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  insertTestPromoGrant,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { localPromos } from "../../src/db/schema.js";

// Owner 2026-10-11: « revenue is cash the client paid ». A client who pays the owner
// directly is credited by a staff grant; marked as an off-platform payment it counts
// as CASH (not a gift) everywhere billing states cash, with the balance unchanged.
const orgId = "00000000-0000-0000-0000-00000000a11e";
const userId = "00000000-0000-0000-0000-00000000a11f";
const apiKey = { "X-API-Key": "test-api-key" };
const cashPath = (q = "") => `/internal/accounts/by-org/${orgId}/cash${q}`;
const reclassifyPath = (id: string) => `/internal/credits/grants/${id}/off-platform-payment`;

describe("Off-platform payments (staff grant recorded as cash the client paid)", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "1000.0000000000",
      as_of: "2026-10-11T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "1000.0000000000",
    } as never);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.sumPaidTopupsForOrgAsOf.mockResolvedValue("0.0000000000");
    ssMocks.listOrgPayments.mockResolvedValue([]);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** Olive's shape: $5 welcome + a $200 staff grant for a payment received directly. */
  async function oliveFixture() {
    await insertTestAccount({ orgId, createdAt: new Date("2026-09-20T00:00:00Z") });
    await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
    return insertTestPromoGrant({
      orgId,
      userId,
      amountCents: 20000,
      promoCode: "admin_grant",
      description: "Client payment of $200 received by Kevin directly (Olive, prepaid)",
    });
  }

  it("before marking, a staff grant is non-cash credit (the bug: Olive read as never paying)", async () => {
    await oliveFixture();
    const res = await request(app).get(cashPath()).set(apiKey);
    expect(res.status).toBe(200);
    expect(res.body.cash_paid_cents).toBe("0.0000000000");
    expect(res.body.non_cash_credit_cents).toBe("20500.0000000000");
  });

  it("reclassifying the existing grant makes it cash: /cash, cash_by_month at the payment date, balance unchanged", async () => {
    const grant = await oliveFixture();
    const before = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(before.status).toBe(200);

    const mark = await request(app)
      .post(reclassifyPath(grant.id))
      .set(apiKey)
      .send({ paidAt: "2026-09-28", recordedBy: "kevin@distribute.you", note: "Olive paid $200 via Kevin" });
    expect(mark.status).toBe(200);
    expect(mark.body).toMatchObject({
      grantId: grant.id,
      orgId,
      amountCents: "20000.0000000000",
      paidAt: "2026-09-28T00:00:00.000Z",
      recordedBy: "kevin@distribute.you",
      alreadyRecorded: false,
    });

    const cash = await request(app).get(cashPath("?by_month=true")).set(apiKey);
    expect(cash.status).toBe(200);
    expect(cash.body.cash_paid_cents).toBe("20000.0000000000");
    expect(cash.body.credited_cents).toBe("20500.0000000000");
    expect(cash.body.non_cash_credit_cents).toBe("500.0000000000");
    const sept = cash.body.cash_by_month.find((m: { month: string }) => m.month === "2026-09");
    expect(sept.cash_paid_cents).toBe("20000.0000000000");
    const sum = cash.body.cash_by_month.reduce(
      (s: number, m: { cash_paid_cents: string }) => s + Number(m.cash_paid_cents),
      0
    );
    expect(sum).toBe(20000);

    const after = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(after.status).toBe(200);
    // The money did not move: same credited, same balance.
    expect(after.body.credited_cents).toBe(before.body.credited_cents);
    expect(after.body.balance_cents).toBe(before.body.balance_cents);
    expect(after.body.actual_balance_cents).toBe(before.body.actual_balance_cents);
    // It moved from gifted to paid.
    expect(after.body.cash_paid_cents).toBe("20000.0000000000");
    expect(after.body.credited_paid_cents).toBe(
      (Number(before.body.credited_paid_cents) + 20000).toFixed(10)
    );
    expect(after.body.credited_gifted_cents).toBe(
      (Number(before.body.credited_gifted_cents) - 20000).toFixed(10)
    );
    // Invariant kept.
    const parts =
      Number(after.body.credited_paid_cents) +
      Number(after.body.credited_gifted_cents) +
      Number(after.body.credited_advance_cents) +
      Number(after.body.credited_trial_advance_cents);
    expect(parts).toBe(Number(after.body.credited_cents));

    // History kept: the grant row itself is untouched, the ledger names the payment date.
    const [row] = await db.select().from(localPromos).where(eq(localPromos.id, grant.id));
    expect(row.amountCents).toBe(grant.amountCents);
    expect(row.description).toBe(grant.description);
    expect(row.createdAt.getTime()).toBe(grant.createdAt.getTime());
    const ledger = await request(app)
      .get("/v1/credits/grants")
      .set({ ...apiKey, "x-org-id": orgId });
    const item = ledger.body.grants.find((g: { id: string }) => g.id === grant.id);
    expect(item.reason).toBe("admin_grant");
    expect(item.offPlatformPaidAt).toBe("2026-09-28T00:00:00.000Z");
    const welcome = ledger.body.grants.find((g: { reason: string }) => g.reason === "welcome");
    expect(welcome.offPlatformPaidAt).toBeNull();
  });

  it("re-marking: same date is a no-op, another date is 409, never a silent re-date", async () => {
    const grant = await oliveFixture();
    const body = { paidAt: "2026-09-28", recordedBy: "kevin@distribute.you", note: "paid" };
    expect((await request(app).post(reclassifyPath(grant.id)).set(apiKey).send(body)).status).toBe(200);
    const again = await request(app).post(reclassifyPath(grant.id)).set(apiKey).send(body);
    expect(again.status).toBe(200);
    expect(again.body.alreadyRecorded).toBe(true);
    const other = await request(app)
      .post(reclassifyPath(grant.id))
      .set(apiKey)
      .send({ ...body, paidAt: "2026-09-01" });
    expect(other.status).toBe(409);
    const cash = await request(app).get(cashPath()).set(apiKey);
    expect(cash.body.cash_paid_cents).toBe("20000.0000000000");
  });

  it("only an admin_grant can be a payment; unknown grant 404; bad date / missing fields 400", async () => {
    await insertTestAccount({ orgId });
    const welcome = await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
    const body = { paidAt: "2026-09-28", recordedBy: "kevin@distribute.you", note: "paid" };
    expect((await request(app).post(reclassifyPath(welcome.id)).set(apiKey).send(body)).status).toBe(409);
    expect(
      (await request(app).post(reclassifyPath("00000000-0000-0000-0000-0000000000ff")).set(apiKey).send(body)).status
    ).toBe(404);
    expect((await request(app).post(reclassifyPath("nope")).set(apiKey).send(body)).status).toBe(400);
    expect(
      (await request(app).post(reclassifyPath(welcome.id)).set(apiKey).send({ ...body, paidAt: "2999-01-01" })).status
    ).toBe(400);
    expect(
      (await request(app).post(reclassifyPath(welcome.id)).set(apiKey).send({ ...body, paidAt: "Sept 28" })).status
    ).toBe(400);
    expect(
      (await request(app).post(reclassifyPath(welcome.id)).set(apiKey).send({ paidAt: "2026-09-28" })).status
    ).toBe(400);
  });

  it("POST /v1/credits/grant with paidOffPlatformAt records a payment: cash, and the same balance as a gift", async () => {
    await insertTestAccount({ orgId, createdAt: new Date("2026-08-01T00:00:00Z") });
    const headers = {
      ...apiKey,
      "x-org-id": orgId,
      "x-email": "kevin@distribute.you",
      "Content-Type": "application/json",
    };
    const paid = await request(app)
      .post("/v1/credits/grant")
      .set(headers)
      .send({ amountCents: 30000, note: "Bank transfer", idempotencyKey: "pay-1", paidOffPlatformAt: "2026-08-15" });
    expect(paid.status).toBe(200);
    const gift = await request(app)
      .post("/v1/credits/grant")
      .set(headers)
      .send({ amountCents: 1000, note: "Reward", idempotencyKey: "gift-1" });
    expect(gift.status).toBe(200);
    // Balance credited exactly like any grant: 30000 + 1000 − 1000 usage.
    expect(gift.body.newBalanceCents).toBe("30000.0000000000");

    const cash = await request(app).get(cashPath("?by_month=true")).set(apiKey);
    expect(cash.body.cash_paid_cents).toBe("30000.0000000000");
    expect(cash.body.non_cash_credit_cents).toBe("1000.0000000000");
    const aug = cash.body.cash_by_month.find((m: { month: string }) => m.month === "2026-08");
    expect(aug.cash_paid_cents).toBe("30000.0000000000");

    // A retry of the GIFT's key with a payment date never turns the gift into a payment.
    const retry = await request(app)
      .post("/v1/credits/grant")
      .set(headers)
      .send({ amountCents: 1000, note: "Reward", idempotencyKey: "gift-1", paidOffPlatformAt: "2026-08-15" });
    expect(retry.status).toBe(200);
    const cash2 = await request(app).get(cashPath()).set(apiKey);
    expect(cash2.body.cash_paid_cents).toBe("30000.0000000000");

    const bad = await request(app)
      .post("/v1/credits/grant")
      .set(headers)
      .send({ amountCents: 100, idempotencyKey: "pay-2", paidOffPlatformAt: "yesterday" });
    expect(bad.status).toBe(400);
  });

  it("cash adds Stripe payments and off-platform payments", async () => {
    const grant = await oliveFixture();
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    await request(app)
      .post(reclassifyPath(grant.id))
      .set(apiKey)
      .send({ paidAt: "2026-09-28", recordedBy: "kevin@distribute.you", note: "paid" });
    const res = await request(app).get(cashPath()).set(apiKey);
    expect(res.body.cash_paid_cents).toBe("25000.0000000000");
    expect(res.body.credited_cents).toBe("25500.0000000000");
    expect(res.body.non_cash_credit_cents).toBe("500.0000000000");
  });
});
