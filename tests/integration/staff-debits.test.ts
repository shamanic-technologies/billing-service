import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { localPromos, staffDebits } from "../../src/db/schema.js";

describe("Staff debits (POST /v1/credits/debit, GET /v1/credits/debits)", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const orgB = "00000000-0000-0000-0000-000000000002";
  const userId = "00000000-0000-0000-0000-000000000099";
  const staffEmail = "staff@distribute.you";

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async (org: string) => ({
      org_id: org,
      spent_cents: "1000.0000000000",
      as_of: "2026-09-27T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "800.0000000000",
    });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function headers(org = orgId, email: string | null = staffEmail) {
    const h: Record<string, string> = {
      "X-API-Key": "test-api-key",
      "x-org-id": org,
      "Content-Type": "application/json",
    };
    if (email) h["x-email"] = email;
    return h;
  }

  async function grant(amountCents: number, key: string) {
    const res = await request(app)
      .post("/v1/credits/grant")
      .set(headers())
      .send({ amountCents, note: "grant", idempotencyKey: key });
    expect(res.status).toBe(200);
    return res.body.newBalanceCents as string;
  }

  it("grant then debit: balance moves by exactly the debited amount, note stored", async () => {
    // usage 1000, grant 80000 → balance 79000
    expect(await grant(80000, "g-1")).toBe("79000.0000000000");

    const res = await request(app)
      .post("/v1/credits/debit")
      .set(headers())
      .send({
        amountCents: 14319,
        note: "Spend on Living Vital under the agency org before the handover",
        idempotencyKey: "d-1",
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.alreadyDebited).toBe(false);
    expect(res.body.newBalanceCents).toBe("64681.0000000000");
    expect(res.body.debit).toMatchObject({
      orgId,
      amountCents: "14319.0000000000",
      note: "Spend on Living Vital under the agency org before the handover",
      debitedBy: staffEmail,
      idempotencyKey: "d-1",
    });

    const list = await request(app).get("/v1/credits/debits").set(headers());
    expect(list.status).toBe(200);
    expect(list.body.debits).toHaveLength(1);
    expect(list.body.debits[0].note).toBe(
      "Spend on Living Vital under the agency org before the handover"
    );

    const all = await request(app).get("/internal/credits/debits").set({ "X-API-Key": "test-api-key" });
    expect(all.status).toBe(200);
    expect(all.body.debits).toHaveLength(1);
  });

  it("a retry with the same key debits once", async () => {
    await grant(80000, "g-1");
    const body = { amountCents: 14319, note: "handover", idempotencyKey: "d-1" };
    const first = await request(app).post("/v1/credits/debit").set(headers()).send(body);
    const second = await request(app).post("/v1/credits/debit").set(headers()).send(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.alreadyDebited).toBe(true);
    expect(second.body.debit.id).toBe(first.body.debit.id);
    expect(second.body.newBalanceCents).toBe(first.body.newBalanceCents);
    expect(await db.select().from(staffDebits)).toHaveLength(1);
  });

  it("same key with a different amount is refused (409), nothing new debited", async () => {
    await request(app)
      .post("/v1/credits/debit")
      .set(headers())
      .send({ amountCents: 100, note: "x", idempotencyKey: "d-1" });
    const res = await request(app)
      .post("/v1/credits/debit")
      .set(headers())
      .send({ amountCents: 200, note: "x", idempotencyKey: "d-1" });
    expect(res.status).toBe(409);
    expect(await db.select().from(staffDebits)).toHaveLength(1);
  });

  it("requires a note, a positive integer amount, a key, x-email and a valid org", async () => {
    const ok = { amountCents: 100, note: "why", idempotencyKey: "k" };
    const cases: Array<[Record<string, string>, unknown]> = [
      [headers(), { ...ok, note: "   " }],
      [headers(), { amountCents: 100, idempotencyKey: "k" }],
      [headers(), { ...ok, amountCents: 0 }],
      [headers(), { ...ok, amountCents: -5 }],
      [headers(), { ...ok, amountCents: 1.5 }],
      [headers(), { amountCents: 100, note: "why" }],
      [headers(orgId, null), ok],
      [headers("not-a-uuid"), ok],
    ];
    for (const [h, body] of cases) {
      const res = await request(app).post("/v1/credits/debit").set(h).send(body as object);
      expect(res.status).toBe(400);
    }
    expect(await db.select().from(staffDebits)).toHaveLength(0);
  });

  it("GET /v1/accounts shows the debit as its own line, not as usage, and both balances drop", async () => {
    await insertTestAccount({ orgId });
    const before = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, userId));
    expect(before.status).toBe(200);
    expect(before.body.debited_cents).toBe("0");

    await request(app)
      .post("/v1/credits/debit")
      .set(headers())
      .send({ amountCents: 14319, note: "handover", idempotencyKey: "d-1" });

    const after = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, userId));
    expect(after.status).toBe(200);
    expect(after.body.debited_cents).toBe("14319.0000000000");
    // Not campaign usage.
    expect(after.body.usage_cents).toBe(before.body.usage_cents);
    expect(after.body.credited_cents).toBe(before.body.credited_cents);
    // Both balances lower by exactly the debit.
    expect(Number(before.body.balance_cents) - Number(after.body.balance_cents)).toBe(14319);
    expect(Number(before.body.actual_balance_cents) - Number(after.body.actual_balance_cents)).toBe(14319);
  });

  it("is not a gift: writes no local_promos row, and another org is untouched", async () => {
    await request(app)
      .post("/v1/credits/debit")
      .set(headers())
      .send({ amountCents: 500, note: "x", idempotencyKey: "d-1" });
    expect(await db.select().from(localPromos)).toHaveLength(0);

    const other = await request(app).get("/v1/credits/debits").set(headers(orgB));
    expect(other.body.debits).toEqual([]);
  });
});
