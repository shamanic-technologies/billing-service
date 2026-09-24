/**
 * The card session REPORTS what the outstanding-balance collection did, so the
 * dashboard can tell the customer before redirecting them: charged, declined
 * (with the acquirer's own customer-readable reason), failed, or not attempted.
 *
 * Prod 2026-09-22, org a81327ee-…: a $10.66 settle was declined ("Your card
 * does not support this type of purchase.") and the dashboard redirected to the
 * card page with no word of it, because the response said nothing. The session
 * is still handed over in every case — reporting is additive, never a veto.
 *
 * Own file: portal.test.ts closes the shared DB connection in afterAll.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";

const app = createTestApp();
const orgId = "00000000-0000-0000-0000-0000000000e7";
const ROUTES = ["/v1/portal-sessions", "/v1/accounts/card_setup"] as const;

describe("card session reports the settle outcome", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let usageCents: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    ssMocks = setupStripeMocks();
    await cleanTestData();
    usageCents = "0.0000000000";
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      async (org: string) => ({
        org_id: org,
        spent_cents: usageCents,
        as_of: "2026-01-31T00:00:00.000Z",
      })
    );
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** −$10.66: paid $10, used $20.66. */
  function owing() {
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
    usageCents = "2066.0000000000";
  }

  async function open(route: (typeof ROUTES)[number]) {
    return request(app)
      .post(route)
      .set(getAuthHeaders(orgId))
      .send({ return_url: "https://example.com/return" });
  }

  for (const route of ROUTES) {
    it(`${route}: a DECLINED settle returns the session AND the decline with a readable reason`, async () => {
      await insertTestAccount({ orgId });
      owing();
      ssMocks.reloadOffSession.mockResolvedValue({
        status: "failed",
        reference: "ch_x",
        failure_reason:
          "card_declined: transaction_not_allowed: Your card does not support this type of purchase.",
        failure_code: "transaction_not_allowed",
        failure_message: "Your card does not support this type of purchase.",
      });

      const res = await open(route);

      expect(res.status).toBe(200);
      expect(res.body.url).toBe("https://billing.stripe.com/p/session/abc");
      expect(res.body.settle_result).toBe("declined");
      expect(res.body.settle_decline_message).toBe(
        "Your card does not support this type of purchase."
      );
      expect(res.body.settled_cents).toBe(0);
      expect(res.body.settle_skip_reason).toBe("charge_failed");
      // Never the raw processor payload.
      expect(JSON.stringify(res.body)).not.toContain("transaction_not_allowed");
      expect(JSON.stringify(res.body)).not.toContain("ch_x");
    });

    it(`${route}: a successful settle states it was charged and how much`, async () => {
      await insertTestAccount({ orgId });
      owing();

      const res = await open(route);

      expect(res.status).toBe(200);
      expect(res.body.url).toBe("https://billing.stripe.com/p/session/abc");
      expect(res.body.settle_result).toBe("charged");
      expect(res.body.settled_cents).toBe(1066);
      expect(res.body.settle_skip_reason).toBeUndefined();
      expect(res.body.settle_decline_message).toBeNull();
    });

    it(`${route}: nothing owed states not_attempted with the skip reason`, async () => {
      await insertTestAccount({ orgId });

      const res = await open(route);

      expect(res.status).toBe(200);
      expect(res.body.settle_result).toBe("not_attempted");
      expect(res.body.settle_skip_reason).toBe("nothing_owed");
      expect(res.body.settled_cents).toBe(0);
      expect(res.body.settle_decline_message).toBeNull();
      expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    });

    it(`${route}: a stripe-service error is 'failed', never called a decline`, async () => {
      await insertTestAccount({ orgId });
      owing();
      ssMocks.reloadOffSession.mockRejectedValue(
        new Error("stripe-service POST /internal/charges: 502 upstream")
      );

      const res = await open(route);

      expect(res.status).toBe(200);
      expect(res.body.settle_result).toBe("failed");
      expect(res.body.settle_decline_message).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain("upstream");
    });

    it(`${route}: a decline without an acquirer sentence is still 'declined', message null`, async () => {
      await insertTestAccount({ orgId });
      owing();
      ssMocks.reloadOffSession.mockResolvedValue({
        status: "failed",
        failure_reason: "charge.status=failed",
      });

      const res = await open(route);

      expect(res.status).toBe(200);
      expect(res.body.settle_result).toBe("declined");
      expect(res.body.settle_decline_message).toBeNull();
    });
  }
});
