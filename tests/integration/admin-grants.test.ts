import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  insertTestPromoGrant,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  localPromoCodes,
  localPromos,
  WELCOME_PROMO_CODE,
  ADMIN_GRANT_CODE,
} from "../../src/db/schema.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

describe("Admin credit grants (POST /v1/credits/grant, GET grants)", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const orgB = "00000000-0000-0000-0000-000000000002";
  const staffEmail = "staff@distribute.you";
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-06-23T00:00:00.000Z",
    });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function postHeaders(org = orgId, email: string | null = staffEmail) {
    const h: Record<string, string> = {
      "X-API-Key": "test-api-key",
      "x-org-id": org,
      "Content-Type": "application/json",
    };
    if (email) h["x-email"] = email;
    return h;
  }

  async function getPromosForOrg(targetOrgId: string) {
    return db.select().from(localPromos).where(eq(localPromos.orgId, targetOrgId));
  }

  async function adminGrantPromoCodeId(): Promise<string> {
    const [row] = await db
      .select()
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, ADMIN_GRANT_CODE))
      .limit(1);
    if (!row) throw new Error("admin_grant code missing in test seed");
    return row.id;
  }

  it("grants an arbitrary amount into spendable balance + records note/grantedBy", async () => {
    const res = await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 5000, note: "goodwill credit", idempotencyKey: "key-1" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newBalanceCents).toBe("5000.0000000000");

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
    expect(grants[0].amountCents).toBe("5000.0000000000");
    expect(grants[0].promoCodeId).toBe(await adminGrantPromoCodeId());
    expect(grants[0].description).toBe("goodwill credit");
    expect(grants[0].grantedBy).toBe(staffEmail);
    expect(grants[0].idempotencyKey).toBe("key-1");
    expect(grants[0].userId).toBe(SYSTEM_USER_ID);
  });

  it("STACKS multiple grants with different idempotencyKeys (balance = sum)", async () => {
    await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 5000, idempotencyKey: "key-a" });

    const res = await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 3000, idempotencyKey: "key-b" });

    expect(res.status).toBe(200);
    expect(res.body.newBalanceCents).toBe("8000.0000000000");

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(2);
  });

  it("same idempotencyKey twice = one row (no double-grant)", async () => {
    await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 5000, idempotencyKey: "dup-key" });

    const res = await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 5000, idempotencyKey: "dup-key" });

    expect(res.status).toBe(200);
    expect(res.body.newBalanceCents).toBe("5000.0000000000");

    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
  });

  it("admin_grant stacks alongside a welcome row (no (org,promo) collision)", async () => {
    await insertTestAccount({ orgId });
    await insertTestPromoGrant({
      orgId,
      userId: SYSTEM_USER_ID,
      amountCents: 200,
      promoCode: WELCOME_PROMO_CODE,
    });

    const res = await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 5000, idempotencyKey: "k" });

    expect(res.status).toBe(200);
    // 200 welcome + 5000 admin grant
    expect(res.body.newBalanceCents).toBe("5200.0000000000");
    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(2);
  });

  it("grant lands on top of paid topups and usage", async () => {
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("10000.0000000000");
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "1234.5000000000",
      as_of: "2026-06-23T00:00:00.000Z",
    });

    const res = await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 2500, idempotencyKey: "k" });

    expect(res.status).toBe(200);
    // 10000 paid + 2500 grant − 1234.5 usage = 11265.5
    expect(res.body.newBalanceCents).toBe("11265.5000000000");
  });

  it("GET /v1/credits/grants returns this org's grants in the locked shape", async () => {
    await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 5000, note: "n1", idempotencyKey: "k1" });

    const res = await request(app)
      .get("/v1/credits/grants")
      .set({ "X-API-Key": "test-api-key", "x-org-id": orgId });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.grants)).toBe(true);
    expect(res.body.grants).toHaveLength(1);
    const g = res.body.grants[0];
    expect(Object.keys(g).sort()).toEqual(
      ["amountCents", "createdAt", "grantedBy", "id", "note", "orgId", "reason"].sort()
    );
    expect(g.orgId).toBe(orgId);
    expect(g.amountCents).toBe("5000.0000000000");
    expect(g.reason).toBe(ADMIN_GRANT_CODE);
    expect(g.note).toBe("n1");
    expect(g.grantedBy).toBe(staffEmail);
    expect(typeof g.createdAt).toBe("string");
  });

  it("GET /v1/credits/grants is org-scoped (does not leak another org)", async () => {
    await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders(orgId))
      .send({ amountCents: 5000, idempotencyKey: "k1" });
    await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders(orgB))
      .send({ amountCents: 7000, idempotencyKey: "k2" });

    const res = await request(app)
      .get("/v1/credits/grants")
      .set({ "X-API-Key": "test-api-key", "x-org-id": orgId });

    expect(res.status).toBe(200);
    expect(res.body.grants).toHaveLength(1);
    expect(res.body.grants[0].orgId).toBe(orgId);
  });

  it("GET /internal/credits/grants returns grants across ALL orgs", async () => {
    await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders(orgId))
      .send({ amountCents: 5000, idempotencyKey: "k1" });
    await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders(orgB))
      .send({ amountCents: 7000, idempotencyKey: "k2" });

    const res = await request(app)
      .get("/internal/credits/grants")
      .set({ "X-API-Key": "test-api-key" });

    expect(res.status).toBe(200);
    expect(res.body.grants).toHaveLength(2);
    const orgs = res.body.grants.map((g: { orgId: string }) => g.orgId).sort();
    expect(orgs).toEqual([orgId, orgB].sort());
    // locked shape on the platform-wide ledger too
    expect(Object.keys(res.body.grants[0]).sort()).toEqual(
      ["amountCents", "createdAt", "grantedBy", "id", "note", "orgId", "reason"].sort()
    );
  });

  it("grant without x-email records grantedBy null", async () => {
    const res = await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders(orgId, null))
      .send({ amountCents: 5000, idempotencyKey: "k" });

    expect(res.status).toBe(200);
    const grants = await getPromosForOrg(orgId);
    expect(grants[0].grantedBy).toBeNull();
  });

  it("400 when x-org-id missing", async () => {
    const res = await request(app)
      .post("/v1/credits/grant")
      .set({ "X-API-Key": "test-api-key", "Content-Type": "application/json" })
      .send({ amountCents: 5000, idempotencyKey: "k" });
    expect(res.status).toBe(400);
  });

  it("400 when x-org-id is not a UUID", async () => {
    const res = await request(app)
      .post("/v1/credits/grant")
      .set({ "X-API-Key": "test-api-key", "x-org-id": "nope", "Content-Type": "application/json" })
      .send({ amountCents: 5000, idempotencyKey: "k" });
    expect(res.status).toBe(400);
  });

  it("400 when idempotencyKey missing", async () => {
    const res = await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 5000 });
    expect(res.status).toBe(400);
  });

  it("400 when amountCents not positive", async () => {
    const res = await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 0, idempotencyKey: "k" });
    expect(res.status).toBe(400);
  });

  it("401 without API key", async () => {
    const res = await request(app)
      .post("/v1/credits/grant")
      .set({ "x-org-id": orgId, "Content-Type": "application/json" })
      .send({ amountCents: 5000, idempotencyKey: "k" });
    expect(res.status).toBe(401);
  });

  it("502 when stripe-service unavailable — grant write already committed", async () => {
    ssMocks.fetchOrgCustomer.mockRejectedValue(new Error("stripe-service down"));

    const res = await request(app)
      .post("/v1/credits/grant")
      .set(postHeaders())
      .send({ amountCents: 5000, idempotencyKey: "k" });

    expect(res.status).toBe(502);
    const grants = await getPromosForOrg(orgId);
    expect(grants).toHaveLength(1);
  });
});
