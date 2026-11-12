/**
 * campaign-service PUSHES its side's changes (MON-PAGE-SPEED-2-1112): a campaign of a
 * brand started, paused, stopped, so billing's stored spendable-budget answer for that
 * brand must never be served again. POST /internal/spendable-budget-snapshots/invalidate
 * stamps it; the next runway read asks campaign-service once and stores the new answer.
 *
 * Own file (CLAUDE.md: one describe per file that closes the DB).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { campaignSpendableSnapshots } from "../../src/db/schema.js";
import * as campaignClient from "../../src/lib/campaign-service-client.js";
import type { SpendableBudget } from "../../src/lib/campaign-service-client.js";
import { snapshotSpendableBudgetReader } from "../../src/lib/spendable-budget-snapshots.js";
import { requireApiKey } from "../../src/middleware/auth.js";
import runwayRoutes from "../../src/routes/runway.js";

const orgId = "00000000-0000-4000-8000-0000000099a1";
const brandId = "00000000-0000-4000-8000-0000000099b1";
const otherBrand = "00000000-0000-4000-8000-0000000099b2";

const app = express();
app.use(express.json());
app.use(requireApiKey);
app.use(runwayRoutes);
const KEY = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };

function answer(running: number, brand = brandId): SpendableBudget {
  return {
    orgId,
    brandId: brand,
    grain: "campaign",
    configuredDailyBudgetCents: 3000,
    runningDailyBudgetCents: running,
    campaigns: [],
    rows: [],
  };
}

async function storedRow(brand = brandId) {
  const [row] = await db
    .select()
    .from(campaignSpendableSnapshots)
    .where(and(eq(campaignSpendableSnapshots.orgId, orgId), eq(campaignSpendableSnapshots.brandId, brand)));
  return row ?? null;
}

describe("spendable-budget snapshot invalidation (campaign-service push)", () => {
  let live: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    live = vi.spyOn(campaignClient, "fetchSpendableBudget").mockImplementation(async (_o, b) => answer(1000, b));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    await closeDb();
  });

  it("an invalidated answer is never served: the next read asks once and stores the new one", async () => {
    await snapshotSpendableBudgetReader()(orgId, brandId);
    live.mockImplementation(async (_o, b) => answer(0, b)); // the campaign was paused

    const res = await request(app)
      .post("/internal/spendable-budget-snapshots/invalidate")
      .set(KEY)
      .send({ brands: [{ orgId, brandId }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invalidated: 1 });

    expect(await snapshotSpendableBudgetReader()(orgId, brandId)).toEqual(answer(0));
    expect(live).toHaveBeenCalledTimes(2);
    // Stored again, and served from the store on the read after.
    expect(await snapshotSpendableBudgetReader()(orgId, brandId)).toEqual(answer(0));
    expect(live).toHaveBeenCalledTimes(2);
  });

  it("only the named brand is invalidated", async () => {
    await snapshotSpendableBudgetReader()(orgId, brandId);
    await snapshotSpendableBudgetReader()(orgId, otherBrand);
    await request(app)
      .post("/internal/spendable-budget-snapshots/invalidate")
      .set(KEY)
      .send({ brands: [{ orgId, brandId }] })
      .expect(200);
    expect((await storedRow(brandId))?.invalidatedAt).not.toBeNull();
    expect((await storedRow(otherBrand))?.invalidatedAt).toBeNull();
  });

  it("a read in flight across an invalidation stores an answer that is never served", async () => {
    let release!: (v: SpendableBudget) => void;
    live.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const inFlight = snapshotSpendableBudgetReader()(orgId, brandId);
    await new Promise((r) => setTimeout(r, 30));
    // Nothing stored yet: the invalidation of a missing row is a no-op, so store a row first
    // to model the real race (a stale row being refreshed while campaign-service changes).
    await db.insert(campaignSpendableSnapshots).values({
      orgId,
      brandId,
      body: answer(1000),
      billingFingerprint: "",
      fetchedAt: new Date(Date.now() - 60_000),
    });
    await request(app)
      .post("/internal/spendable-budget-snapshots/invalidate")
      .set(KEY)
      .send({ brands: [{ orgId, brandId }] })
      .expect(200);
    release(answer(1000)); // the pre-change answer lands after the invalidation
    await inFlight;

    live.mockImplementation(async (_o, b) => answer(0, b));
    expect(await snapshotSpendableBudgetReader()(orgId, brandId)).toEqual(answer(0));
  });

  it("a pair with no stored answer is a no-op; a bad body is a 400", async () => {
    const ok = await request(app)
      .post("/internal/spendable-budget-snapshots/invalidate")
      .set(KEY)
      .send({ brands: [{ orgId, brandId }] });
    expect(ok.body).toEqual({ invalidated: 0 });

    for (const body of [{}, { brands: [] }, { brands: [{ orgId: "00000000-0000-0000-0000-000000000001", brandId }] }, { brands: [{ orgId, brandId: "x" }] }]) {
      const res = await request(app).post("/internal/spendable-budget-snapshots/invalidate").set(KEY).send(body);
      expect(res.status).toBe(400);
    }
  });

  it("needs the service key", async () => {
    await request(app)
      .post("/internal/spendable-budget-snapshots/invalidate")
      .send({ brands: [{ orgId, brandId }] })
      .expect(401);
  });
});
