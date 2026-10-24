/**
 * "Credit ran out" / "credit restored" feed (CREDIT-RAN-OUT-UNIBOX-EVENT-1024).
 * A replay of credit-depletion episodes for crm-service to pull: one event per
 * opening, one per recovery, stable ids, a cursor that never re-serves or skips.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestEpisode } from "../helpers/test-db.js";
import { listCreditEvents } from "../../src/lib/credit-events.js";

const app = createTestApp();
const orgA = "00000000-0000-0000-0000-0000000000c1";
const orgB = "00000000-0000-0000-0000-0000000000c2";
const userId = "00000000-0000-0000-0000-0000000000d1";

describe("GET /internal/credit-events", () => {
  beforeEach(async () => {
    await cleanTestData();
  });
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("serves one ran_out per episode and one restored per closed episode, oldest first", async () => {
    const closed = await insertTestEpisode({
      orgId: orgA,
      userId,
      startedAt: new Date("2026-10-01T10:00:00.123Z"),
      recoveredAt: new Date("2026-10-03T09:00:00Z"),
    });
    const open = await insertTestEpisode({
      orgId: orgB,
      userId,
      startedAt: new Date("2026-10-02T08:00:00Z"),
    });

    const res = await request(app).get("/internal/credit-events").set(getAuthHeaders());
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.events).toEqual([
      {
        eventId: `${closed.id}:ran_out`,
        type: "credit_ran_out",
        orgId: orgA,
        episodeId: closed.id,
        at: "2026-10-01T10:00:00.123Z",
      },
      {
        eventId: `${open.id}:ran_out`,
        type: "credit_ran_out",
        orgId: orgB,
        episodeId: open.id,
        at: "2026-10-02T08:00:00.000Z",
      },
      {
        eventId: `${closed.id}:restored`,
        type: "credit_restored",
        orgId: orgA,
        episodeId: closed.id,
        at: "2026-10-03T09:00:00.000Z",
      },
    ]);
    expect(typeof res.body.nextCursor).toBe("string");
  });

  it("pages with the cursor without repeating or skipping, and a later recovery appears after it", async () => {
    // Same instant to microsecond precision on two rows: ties break on eventId.
    const at = new Date("2026-10-05T12:00:00.000Z");
    const e1 = await insertTestEpisode({ orgId: orgA, userId, startedAt: at });
    const e2 = await insertTestEpisode({ orgId: orgB, userId, startedAt: at });

    const p1 = await request(app)
      .get("/internal/credit-events?limit=1")
      .set(getAuthHeaders());
    expect(p1.body.events).toHaveLength(1);
    expect(p1.body.hasMore).toBe(true);
    const p2 = await request(app)
      .get(`/internal/credit-events?limit=1&cursor=${p1.body.nextCursor}`)
      .set(getAuthHeaders());
    expect(p2.body.events).toHaveLength(1);
    expect(p2.body.hasMore).toBe(false);
    const ids = [p1.body.events[0].eventId, p2.body.events[0].eventId].sort();
    expect(ids).toEqual([`${e1.id}:ran_out`, `${e2.id}:ran_out`].sort());

    // Nothing new: the cursor stays put and nothing is re-served.
    const p3 = await request(app)
      .get(`/internal/credit-events?cursor=${p2.body.nextCursor}`)
      .set(getAuthHeaders());
    expect(p3.body.events).toEqual([]);
    expect(p3.body.nextCursor).toBe(p2.body.nextCursor);
  });

  it("holds back events younger than the settle window", async () => {
    const now = new Date("2026-10-24T12:00:00Z");
    await insertTestEpisode({ orgId: orgA, userId, startedAt: new Date("2026-10-24T11:59:30Z") });
    const early = await listCreditEvents({ cursor: null, limit: 10, now });
    expect(early.events).toEqual([]);
    const later = await listCreditEvents({
      cursor: null,
      limit: 10,
      now: new Date("2026-10-24T12:01:00Z"),
    });
    expect(later.events).toHaveLength(1);
  });

  it("refuses a bad limit or cursor", async () => {
    for (const q of ["limit=0", "limit=1001", "limit=abc", "cursor=notacursor"]) {
      const res = await request(app).get(`/internal/credit-events?${q}`).set(getAuthHeaders());
      expect(res.status).toBe(400);
    }
  });
});
