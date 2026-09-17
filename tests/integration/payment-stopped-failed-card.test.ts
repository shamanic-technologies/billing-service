/**
 * "When had this org's payment stopped?" must include A CARD THE BANK IS
 * REFUSING, not only credit that ran out.
 *
 * The read served one half while documenting both: it looked at credit
 * depletion episodes and nothing else. An org can have a card refused this
 * morning, be blocked from every run by the affordability pre-flight, and still
 * carry NO episode at all — because its balance is still inside its
 * credit-line floor, where `isDepleted` is false. Prod 2026-09-17, org
 * 81b34252-…: exactly that, and features-service therefore counted its MRR as
 * live revenue.
 *
 * These pin the second source: an OPEN failed reload streak is a period, a
 * streak that is over is not, and nothing else about the response moves.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestEpisode,
  insertTestSweepAttempt,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-0000000000c1";
const otherOrgId = "00000000-0000-0000-0000-0000000000c2";
const userId = "00000000-0000-0000-0000-0000000000c9";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };

function periodsPath(id: string) {
  return `/internal/accounts/by-org/${id}/payment-stopped-periods`;
}

// What the org has EVER been credited. The streak froze its own copy of this
// at the moment the card refused; the two being equal is what says the world
// has not moved since.
const CREDITED = "22515.0000000000";

describe("payment-stopped periods: a card the bank is refusing", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(CREDITED);
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("reports the open failed streak as a period, even with no episode ever", async () => {
    await insertTestSweepAttempt({
      orgId,
      creditedCentsAtAttempt: CREDITED,
      lastOutcome: "failed",
      firstFailedAt: new Date("2026-09-17T06:47:44.000Z"),
    });

    const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.periods).toEqual([
      { startedAt: "2026-09-17T06:47:44.000Z", endedAt: null },
    ]);
    // The period starts at the REAL first refusal, not at "now" — the consumer
    // replays past UTC days, so a streak that began yesterday must make
    // yesterday report stopped.
    expect(res.body.recordBeginsAt).toBe("2026-09-17T06:47:44.000Z");
  });

  it("a card the bank called permanently unusable is still a period", async () => {
    await insertTestSweepAttempt({
      orgId,
      creditedCentsAtAttempt: CREDITED,
      lastOutcome: "failed",
      attemptCount: 1,
      firstFailedAt: new Date("2026-09-10T00:00:00.000Z"),
      cardUnusableAt: new Date("2026-09-10T00:00:00.000Z"),
    });

    const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

    expect(res.body.periods).toEqual([
      { startedAt: "2026-09-10T00:00:00.000Z", endedAt: null },
    ]);
  });

  it("a last reload that SUCCEEDED is not a period", async () => {
    await insertTestSweepAttempt({
      orgId,
      creditedCentsAtAttempt: CREDITED,
      lastOutcome: "succeeded",
      firstFailedAt: null,
    });

    const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgId, recordBeginsAt: null, periods: [] });
  });

  it("a recharge ends the streak, even though nothing rewrites the row", async () => {
    // The row still says `failed` — a recharge does not touch it, because the
    // org simply stops being blocked and the sweep skips it. `credited` having
    // MOVED is the signal, the same one the sweep and the card verdict use.
    await insertTestSweepAttempt({
      orgId,
      creditedCentsAtAttempt: "10000.0000000000",
      lastOutcome: "failed",
      firstFailedAt: new Date("2026-09-17T06:47:44.000Z"),
    });

    const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.periods).toEqual([]);
  });

  it("an org with no streak row costs no stripe read and answers exactly as before", async () => {
    await insertTestEpisode({
      orgId,
      userId,
      startedAt: new Date("2026-07-01T10:00:00.000Z"),
      recoveredAt: new Date("2026-07-04T08:00:00.000Z"),
    });

    const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

    expect(res.status).toBe(200);
    expect(res.body.periods).toEqual([
      { startedAt: "2026-07-01T10:00:00.000Z", endedAt: "2026-07-04T08:00:00.000Z" },
    ]);
    expect(ssMocks.sumSucceededTopupsForOrg).not.toHaveBeenCalled();
  });

  it("an open episode and an open streak are ONE period, from the earlier start", async () => {
    await insertTestEpisode({
      orgId,
      userId,
      startedAt: new Date("2026-09-18T00:00:00.000Z"),
      recoveredAt: null,
    });
    await insertTestSweepAttempt({
      orgId,
      creditedCentsAtAttempt: CREDITED,
      lastOutcome: "failed",
      firstFailedAt: new Date("2026-09-17T06:47:44.000Z"),
    });

    const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

    expect(res.body.periods).toEqual([
      { startedAt: "2026-09-17T06:47:44.000Z", endedAt: null },
    ]);
  });

  it("a closed episode that the open streak overlaps is swallowed by it", async () => {
    await insertTestEpisode({
      orgId,
      userId,
      startedAt: new Date("2026-09-18T00:00:00.000Z"),
      recoveredAt: new Date("2026-09-19T00:00:00.000Z"),
    });
    await insertTestSweepAttempt({
      orgId,
      creditedCentsAtAttempt: CREDITED,
      lastOutcome: "failed",
      firstFailedAt: new Date("2026-09-17T06:47:44.000Z"),
    });

    const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

    expect(res.body.periods).toEqual([
      { startedAt: "2026-09-17T06:47:44.000Z", endedAt: null },
    ]);
  });

  it("recordBeginsAt is the earliest instant EITHER source recorded, fleet-wide", async () => {
    await insertTestEpisode({
      orgId: otherOrgId,
      userId,
      startedAt: new Date("2026-06-12T13:06:55.000Z"),
      recoveredAt: new Date("2026-06-13T00:00:00.000Z"),
    });
    await insertTestSweepAttempt({
      orgId,
      creditedCentsAtAttempt: CREDITED,
      lastOutcome: "failed",
      firstFailedAt: new Date("2026-09-17T06:47:44.000Z"),
    });

    const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

    // The episodes are far older, so they still set it — and it can only ever
    // move earlier, never later.
    expect(res.body.recordBeginsAt).toBe("2026-06-12T13:06:55.000Z");
  });

  it("the streak belongs to the org in the path, not to any other", async () => {
    await insertTestSweepAttempt({
      orgId: otherOrgId,
      creditedCentsAtAttempt: CREDITED,
      lastOutcome: "failed",
      firstFailedAt: new Date("2026-09-17T06:47:44.000Z"),
    });

    const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

    expect(res.body.periods).toEqual([]);
  });
});
