/**
 * The two past-day reads a run-rate consumer needs from billing:
 *
 *   GET /internal/brands/:brandId/daily-budget/by-day
 *   GET /internal/accounts/by-org/:orgId/payment-stopped-periods
 *
 * The invariant both exist to protect: a day billing never observed must be
 * legible as NOT RECORDED, never as a zero, never as a guess, and never as
 * "payment was on".
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestBrandBudgetChange,
  insertTestEpisode,
} from "../helpers/test-db.js";

const orgId = "00000000-0000-0000-0000-0000000000d1";
const otherOrgId = "00000000-0000-0000-0000-0000000000d2";
const userId = "00000000-0000-0000-0000-0000000000e1";
const brandId = "00000000-0000-0000-0000-0000000000f1";
const otherBrandId = "00000000-0000-0000-0000-0000000000f2";

const apiKeyHeaders = { "X-API-Key": "test-api-key" };
const orgHeaders = { ...apiKeyHeaders, "x-org-id": orgId };

function byDayPath(id: string, from: string, to: string) {
  return `/internal/brands/${id}/daily-budget/by-day?from=${from}&to=${to}`;
}

function periodsPath(id: string) {
  return `/internal/accounts/by-org/${id}/payment-stopped-periods`;
}

function day(date: string): Record<string, unknown> {
  return { date };
}

describe("past-day billing facts (budget in force, payment stopped)", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("GET /internal/brands/:brandId/daily-budget/by-day", () => {
    it("replays the change log: each day carries the amount it finished on", async () => {
      await insertTestBrandBudgetChange({
        orgId,
        brandId,
        dailyBudgetCents: "5000.0000000000",
        changedAt: new Date("2026-08-10T09:00:00.000Z"),
      });
      await insertTestBrandBudgetChange({
        orgId,
        brandId,
        dailyBudgetCents: "8000.0000000000",
        changedAt: new Date("2026-08-12T15:30:00.000Z"),
      });

      const res = await request(app)
        .get(byDayPath(brandId, "2026-08-09", "2026-08-13"))
        .set(orgHeaders);

      expect(res.status).toBe(200);
      expect(res.body.brandId).toBe(brandId);
      expect(res.body.orgId).toBe(orgId);
      expect(res.body.grain).toBe("brand");
      expect(res.body.recordBeginsAt).toBe("2026-08-10T09:00:00.000Z");
      expect(res.body.days).toEqual([
        {
          ...day("2026-08-09"),
          state: "not_recorded",
          dailyBudgetCents: null,
          inForceSince: null,
        },
        {
          ...day("2026-08-10"),
          state: "recorded",
          dailyBudgetCents: "5000.0000000000",
          inForceSince: "2026-08-10T09:00:00.000Z",
        },
        {
          ...day("2026-08-11"),
          state: "recorded",
          dailyBudgetCents: "5000.0000000000",
          inForceSince: "2026-08-10T09:00:00.000Z",
        },
        {
          ...day("2026-08-12"),
          state: "recorded",
          dailyBudgetCents: "8000.0000000000",
          inForceSince: "2026-08-12T15:30:00.000Z",
        },
        {
          ...day("2026-08-13"),
          state: "recorded",
          dailyBudgetCents: "8000.0000000000",
          inForceSince: "2026-08-12T15:30:00.000Z",
        },
      ]);
    });

    it("a day the customer defunded reads a RECORDED 0, not 'not recorded'", async () => {
      await insertTestBrandBudgetChange({
        orgId,
        brandId,
        dailyBudgetCents: "3000.0000000000",
        changedAt: new Date("2026-08-01T00:00:00.000Z"),
      });
      await insertTestBrandBudgetChange({
        orgId,
        brandId,
        dailyBudgetCents: "0.0000000000",
        changedAt: new Date("2026-08-05T11:00:00.000Z"),
      });

      const res = await request(app)
        .get(byDayPath(brandId, "2026-07-31", "2026-08-05"))
        .set(orgHeaders);

      expect(res.status).toBe(200);
      const days = res.body.days as Array<Record<string, unknown>>;
      // Before the record: unknown.
      expect(days[0]).toMatchObject({
        date: "2026-07-31",
        state: "not_recorded",
        dailyBudgetCents: null,
      });
      // Deliberately defunded: a real, recorded zero. Distinguishable from the
      // day above by `state`, not by reading the number as a sentinel.
      expect(days[5]).toMatchObject({
        date: "2026-08-05",
        state: "recorded",
        dailyBudgetCents: "0.0000000000",
      });
    });

    it("the last change of a day wins (the value the day finished on)", async () => {
      await insertTestBrandBudgetChange({
        orgId,
        brandId,
        dailyBudgetCents: "1000.0000000000",
        changedAt: new Date("2026-08-20T02:00:00.000Z"),
      });
      await insertTestBrandBudgetChange({
        orgId,
        brandId,
        dailyBudgetCents: "9000.0000000000",
        changedAt: new Date("2026-08-20T22:59:59.000Z"),
      });

      const res = await request(app)
        .get(byDayPath(brandId, "2026-08-20", "2026-08-20"))
        .set(orgHeaders);

      expect(res.status).toBe(200);
      expect(res.body.days).toEqual([
        {
          date: "2026-08-20",
          state: "recorded",
          dailyBudgetCents: "9000.0000000000",
          inForceSince: "2026-08-20T22:59:59.000Z",
        },
      ]);
    });

    it("a change at the very start of the next UTC day does NOT reach back", async () => {
      await insertTestBrandBudgetChange({
        orgId,
        brandId,
        dailyBudgetCents: "4200.0000000000",
        changedAt: new Date("2026-08-22T00:00:00.000Z"),
      });

      const res = await request(app)
        .get(byDayPath(brandId, "2026-08-21", "2026-08-22"))
        .set(orgHeaders);

      expect(res.status).toBe(200);
      expect(res.body.days[0]).toMatchObject({
        date: "2026-08-21",
        state: "not_recorded",
      });
      expect(res.body.days[1]).toMatchObject({
        date: "2026-08-22",
        state: "recorded",
        dailyBudgetCents: "4200.0000000000",
      });
    });

    it("no change ever recorded: every day not_recorded, recordBeginsAt null", async () => {
      const res = await request(app)
        .get(byDayPath(brandId, "2026-08-01", "2026-08-03"))
        .set(orgHeaders);

      expect(res.status).toBe(200);
      expect(res.body.recordBeginsAt).toBeNull();
      expect(res.body.days).toHaveLength(3);
      for (const d of res.body.days) {
        expect(d.state).toBe("not_recorded");
        expect(d.dailyBudgetCents).toBeNull();
      }
    });

    it("a range entirely before the record still reports where the record begins", async () => {
      await insertTestBrandBudgetChange({
        orgId,
        brandId,
        dailyBudgetCents: "5000.0000000000",
        changedAt: new Date("2026-08-10T09:00:00.000Z"),
      });

      const res = await request(app)
        .get(byDayPath(brandId, "2026-07-01", "2026-07-02"))
        .set(orgHeaders);

      expect(res.status).toBe(200);
      expect(res.body.recordBeginsAt).toBe("2026-08-10T09:00:00.000Z");
      expect(res.body.days.every((d: { state: string }) => d.state === "not_recorded")).toBe(true);
    });

    it("scoped to (org, brand): another org's writes for the same brand are invisible", async () => {
      await insertTestBrandBudgetChange({
        orgId: otherOrgId,
        brandId,
        dailyBudgetCents: "7777.0000000000",
        changedAt: new Date("2026-08-02T00:00:00.000Z"),
      });
      await insertTestBrandBudgetChange({
        orgId,
        brandId: otherBrandId,
        dailyBudgetCents: "6666.0000000000",
        changedAt: new Date("2026-08-02T00:00:00.000Z"),
      });

      const res = await request(app)
        .get(byDayPath(brandId, "2026-08-02", "2026-08-02"))
        .set(orgHeaders);

      expect(res.status).toBe(200);
      expect(res.body.recordBeginsAt).toBeNull();
      expect(res.body.days[0].state).toBe("not_recorded");
    });

    it("today is answerable and carries the amount in force right now", async () => {
      const today = new Date().toISOString().slice(0, 10);
      await insertTestBrandBudgetChange({
        orgId,
        brandId,
        dailyBudgetCents: "1234.0000000000",
        changedAt: new Date(Date.now() - 60_000),
      });

      const res = await request(app)
        .get(byDayPath(brandId, today, today))
        .set(orgHeaders);

      expect(res.status).toBe(200);
      expect(res.body.days[0]).toMatchObject({
        date: today,
        state: "recorded",
        dailyBudgetCents: "1234.0000000000",
      });
    });

    it("refuses a future day rather than projecting today's value forward", async () => {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

      const res = await request(app)
        .get(byDayPath(brandId, tomorrow, tomorrow))
        .set(orgHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/future/i);
    });

    it("400s on a malformed date, an impossible date, an inverted range and an over-long one", async () => {
      const bad = [
        ["2026-8-1", "2026-08-02"],
        ["2026-02-31", "2026-03-01"],
        ["2026-08-10", "2026-08-01"],
        ["2024-01-01", "2026-01-01"],
      ];
      for (const [from, to] of bad) {
        const res = await request(app).get(byDayPath(brandId, from, to)).set(orgHeaders);
        expect(res.status).toBe(400);
      }
    });

    it("400s without the dates, without x-org-id, and on a non-UUID brandId", async () => {
      const noDates = await request(app)
        .get(`/internal/brands/${brandId}/daily-budget/by-day`)
        .set(orgHeaders);
      expect(noDates.status).toBe(400);

      const noOrg = await request(app)
        .get(byDayPath(brandId, "2026-08-01", "2026-08-01"))
        .set(apiKeyHeaders);
      expect(noOrg.status).toBe(400);

      const badBrand = await request(app)
        .get(byDayPath("not-a-uuid", "2026-08-01", "2026-08-01"))
        .set(orgHeaders);
      expect(badBrand.status).toBe(400);
    });
  });

  describe("GET /internal/accounts/by-org/:orgId/payment-stopped-periods", () => {
    it("returns each stretch, oldest first, open one last", async () => {
      await insertTestEpisode({
        orgId,
        userId,
        startedAt: new Date("2026-07-01T10:00:00.000Z"),
        recoveredAt: new Date("2026-07-04T08:00:00.000Z"),
      });
      await insertTestEpisode({
        orgId,
        userId,
        startedAt: new Date("2026-08-20T12:00:00.000Z"),
        recoveredAt: null,
      });

      const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

      expect(res.status).toBe(200);
      expect(res.body.orgId).toBe(orgId);
      expect(res.body.periods).toEqual([
        {
          startedAt: "2026-07-01T10:00:00.000Z",
          endedAt: "2026-07-04T08:00:00.000Z",
        },
        { startedAt: "2026-08-20T12:00:00.000Z", endedAt: null },
      ]);
    });

    it("recordBeginsAt is the earliest episode fleet-wide, so a clean org still learns where the record starts", async () => {
      await insertTestEpisode({
        orgId: otherOrgId,
        userId,
        startedAt: new Date("2026-06-12T13:06:55.000Z"),
        recoveredAt: new Date("2026-06-13T00:00:00.000Z"),
      });

      const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

      expect(res.status).toBe(200);
      // This org was never stopped...
      expect(res.body.periods).toEqual([]);
      // ...but the consumer can still tell "payment on" from "not recorded",
      // because it knows the record only begins here.
      expect(res.body.recordBeginsAt).toBe("2026-06-12T13:06:55.000Z");
    });

    it("no episode has ever been recorded: recordBeginsAt null, nothing is known for any day", async () => {
      const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ orgId, recordBeginsAt: null, periods: [] });
    });

    it("scoped to the org in the path; needs no org/user headers", async () => {
      await insertTestEpisode({
        orgId: otherOrgId,
        userId,
        startedAt: new Date("2026-07-01T10:00:00.000Z"),
        recoveredAt: null,
      });

      const res = await request(app).get(periodsPath(orgId)).set(apiKeyHeaders);

      expect(res.status).toBe(200);
      expect(res.body.periods).toEqual([]);
    });

    it("400s on a non-UUID orgId", async () => {
      const res = await request(app).get(periodsPath("nope")).set(apiKeyHeaders);
      expect(res.status).toBe(400);
    });
  });
});
