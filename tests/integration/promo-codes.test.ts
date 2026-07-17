import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  localPromoCodes,
  localPromos,
  WELCOME_PROMO_CODE,
} from "../../src/db/schema.js";

// Admin/config endpoints to read + set a promo code's grant amount WITHOUT a
// migration or deploy. The welcome row is the live source of truth read at
// redeem time, so a PATCH here changes what new signups receive.
describe("GET/PATCH /internal/promo-codes/:code", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";

  // service-auth only (x-api-key); no org/user identity required.
  function authHeaders() {
    return {
      "X-API-Key": "test-api-key",
      "Content-Type": "application/json",
    };
  }

  async function welcomeAmountInDb(): Promise<number> {
    const [row] = await db
      .select()
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE))
      .limit(1);
    return row.amountCents;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-06-12T00:00:00.000Z",
    });
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    });
    await cleanTestData();
    // cleanTestData keeps promo-code rows as-is; these tests mutate the welcome
    // amount, so restore the seed value for deterministic, order-independent runs.
    await db
      .update(localPromoCodes)
      .set({ amountCents: 500 })
      .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE));
  });

  afterAll(async () => {
    await db
      .update(localPromoCodes)
      .set({ amountCents: 500 })
      .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE));
    await cleanTestData();
    await closeDb();
  });

  it("GET returns the current welcome amount (500 from seed)", async () => {
    const res = await request(app)
      .get(`/internal/promo-codes/${WELCOME_PROMO_CODE}`)
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: "welcome", amount_cents: 500 });
  });

  it("PATCH sets a new amount, persists it, and GET reflects it", async () => {
    const patch = await request(app)
      .patch(`/internal/promo-codes/${WELCOME_PROMO_CODE}`)
      .set(authHeaders())
      .send({ amountCents: 1500 });

    expect(patch.status).toBe(200);
    expect(patch.body).toEqual({ code: "welcome", amount_cents: 1500 });
    expect(await welcomeAmountInDb()).toBe(1500);

    const get = await request(app)
      .get(`/internal/promo-codes/${WELCOME_PROMO_CODE}`)
      .set(authHeaders());
    expect(get.body).toEqual({ code: "welcome", amount_cents: 1500 });
  });

  it("a new signup redeems the welcome at the PATCHed amount (no migration)", async () => {
    await request(app)
      .patch(`/internal/promo-codes/${WELCOME_PROMO_CODE}`)
      .set(authHeaders())
      .send({ amountCents: 700 });

    // First touch of a virgin org (GET /v1/accounts) auto-creates the account
    // + redeems welcome at the current DB amount.
    const res = await request(app)
      .get("/v1/accounts")
      .set(getAuthHeaders(orgId));
    expect(res.status).toBe(200);

    const grants = await db
      .select()
      .from(localPromos)
      .where(eq(localPromos.orgId, orgId));
    expect(grants).toHaveLength(1);
    expect(grants[0].amountCents).toBe("700.0000000000");
  });

  it("PATCH accepts 0 (free welcome)", async () => {
    const res = await request(app)
      .patch(`/internal/promo-codes/${WELCOME_PROMO_CODE}`)
      .set(authHeaders())
      .send({ amountCents: 0 });
    expect(res.status).toBe(200);
    expect(res.body.amount_cents).toBe(0);
  });

  it("PATCH rejects a negative amount with 400", async () => {
    const res = await request(app)
      .patch(`/internal/promo-codes/${WELCOME_PROMO_CODE}`)
      .set(authHeaders())
      .send({ amountCents: -100 });
    expect(res.status).toBe(400);
    expect(await welcomeAmountInDb()).toBe(500);
  });

  it("PATCH rejects a non-integer amount with 400", async () => {
    const res = await request(app)
      .patch(`/internal/promo-codes/${WELCOME_PROMO_CODE}`)
      .set(authHeaders())
      .send({ amountCents: 12.5 });
    expect(res.status).toBe(400);
  });

  it("GET unknown code → 404", async () => {
    const res = await request(app)
      .get("/internal/promo-codes/does-not-exist")
      .set(authHeaders());
    expect(res.status).toBe(404);
  });

  it("PATCH unknown code → 404 (no row created)", async () => {
    const res = await request(app)
      .patch("/internal/promo-codes/does-not-exist")
      .set(authHeaders())
      .send({ amountCents: 500 });
    expect(res.status).toBe(404);
  });
});
