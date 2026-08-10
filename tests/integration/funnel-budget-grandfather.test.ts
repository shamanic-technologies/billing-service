import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { brandDailyBudgets } from "../../src/db/schema.js";
import { attributeBrandBudgetToSingleFunnel } from "../../src/lib/single-funnel-attribution.js";

const orgId = "00000000-0000-0000-0000-00000000fc01";
const userId = "00000000-0000-0000-0000-00000000fc99";
const runId = "00000000-0000-0000-0000-00000000fcbb";
const brandId = "00000000-0000-0000-0000-0000000fcb01";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const internalHeaders = { ...apiKeyHeaders, "x-org-id": orgId };

const funnelReadPath = `/internal/brands/${brandId}/funnel-budgets`;
const funnelSetPath = `/v1/brands/${brandId}/funnel-budgets`;
const funnelOnePath = (key: string) =>
  `/v1/brands/${brandId}/funnel-budgets/${key}`;

type FunnelRow = { funnelKey: string; dailyBudgetCents: string };

/**
 * The live production state this exists for: a brand funding its
 * reply-to-meeting funnel at $8/day against a $24/day minimum, because the
 * ceiling predates the minimum and the attribution sweep carried it over
 * verbatim.
 */
async function seedGrandfathered(cents: string): Promise<void> {
  await db.insert(brandDailyBudgets).values({
    orgId,
    brandId,
    dailyBudgetCents: cents,
    updatedAt: new Date(),
  });
  await attributeBrandBudgetToSingleFunnel(orgId, brandId, "reply_meeting");
}

async function storedCeilings(): Promise<Array<[string, string]>> {
  const read = await request(app).get(funnelReadPath).set(internalHeaders);
  return read.body.funnels.map((f: FunnelRow) => [
    f.funnelKey,
    f.dailyBudgetCents,
  ]);
}

const app = createTestApp();

describe("a sub-minimum ceiling that predates the minimum can be kept or raised", () => {
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // --- The one-funnel write (brand Settings) ---

  it("raises an $8/day reply-to-meeting ceiling to $10/day", async () => {
    await seedGrandfathered("800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 1000 });

    expect(res.status).toBe(200);
    expect(await storedCeilings()).toEqual([
      ["reply_meeting", "1000.0000000000"],
    ]);
  });

  it("accepts re-stating the same $8/day", async () => {
    await seedGrandfathered("800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 800 });

    expect(res.status).toBe(200);
    expect(await storedCeilings()).toEqual([
      ["reply_meeting", "800.0000000000"],
    ]);
  });

  it("accepts raising it past the minimum", async () => {
    await seedGrandfathered("800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 3000 });

    expect(res.status).toBe(200);
  });

  it("accepts setting it to zero — defunding is always allowed", async () => {
    await seedGrandfathered("800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 0 });

    expect(res.status).toBe(200);
    expect(await storedCeilings()).toEqual([["reply_meeting", "0.0000000000"]]);
  });

  it("REFUSES lowering it to $5/day, and says what the customer can do", async () => {
    await seedGrandfathered("800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 500 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Sales Meeting (reply)");
    expect(res.body.error).toContain("keep it at $8/day");
    expect(res.body.error).toContain("raise it");
    expect(res.body.error).toContain("set it to 0");

    // Nothing moved.
    expect(await storedCeilings()).toEqual([
      ["reply_meeting", "800.0000000000"],
    ]);
  });

  it("the grandfather is spent once the ceiling reaches the minimum", async () => {
    await seedGrandfathered("800.0000000000");

    const raise = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 2400 });
    expect(raise.status).toBe(200);

    const back = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 1000 });
    expect(back.status).toBe(400);
    expect(back.body.error).toContain("needs at least $24/day");

    expect(await storedCeilings()).toEqual([
      ["reply_meeting", "2400.0000000000"],
    ]);
  });

  it("a funnel with NO stored ceiling is refused as before", async () => {
    await seedGrandfathered("800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("visit_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Sales Meeting (visit)");
    expect(res.body.error).toContain("needs at least $24/day");
  });

  // --- The whole-set write (signup checkout) ---

  it("the whole-set write judges each funnel against ITS OWN stored ceiling", async () => {
    await seedGrandfathered("800.0000000000");

    // reply_meeting is grandfathered at $8 and raised to $10 — accepted.
    // visit_meeting has no stored ceiling, so $10 on it is refused, and one
    // grandfathered funnel does not license the other.
    const refused = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "reply_meeting", dailyBudgetCents: 1000 },
          { funnelKey: "visit_meeting", dailyBudgetCents: 1000 },
        ],
      });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("Sales Meeting (visit)");
    // Nothing half-applied.
    expect(await storedCeilings()).toEqual([
      ["reply_meeting", "800.0000000000"],
    ]);

    const accepted = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "reply_meeting", dailyBudgetCents: 1000 },
          { funnelKey: "visit_meeting", dailyBudgetCents: 2400 },
        ],
      });

    expect(accepted.status).toBe(200);
    expect(await storedCeilings()).toEqual([
      ["reply_meeting", "1000.0000000000"],
      ["visit_meeting", "2400.0000000000"],
    ]);
    expect(accepted.body.dailyBudgetCents).toBe("3400.0000000000");
  });

  it("the whole-set write refuses LOWERING a grandfathered ceiling", async () => {
    await seedGrandfathered("800.0000000000");

    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [{ funnelKey: "reply_meeting", dailyBudgetCents: 500 }],
      });

    expect(res.status).toBe(400);
    expect(await storedCeilings()).toEqual([
      ["reply_meeting", "800.0000000000"],
    ]);
  });

  it("the canonical spelling of the funnel is grandfathered too", async () => {
    await seedGrandfathered("800.0000000000");

    const res = await request(app)
      .patch(funnelOnePath("sales_meetings_from_conversation"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 1000 });

    expect(res.status).toBe(200);
    expect(await storedCeilings()).toEqual([
      ["reply_meeting", "1000.0000000000"],
    ]);
  });

  // --- Reads are unchanged ---

  it("the brand-level total still answers the sum of the ceilings", async () => {
    await seedGrandfathered("800.0000000000");

    const read = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(read.body.dailyBudgetCents).toBe("800.0000000000");

    await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 1000 });

    const after = await request(app).get(funnelReadPath).set(internalHeaders);
    expect(after.body.dailyBudgetCents).toBe("1000.0000000000");
  });
});
