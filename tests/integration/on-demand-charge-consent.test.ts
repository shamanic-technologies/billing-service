/**
 * The on-demand charge (`POST /internal/accounts/by-org/:orgId/charge`) stores the
 * payment consent the same way the top-up checkout session does (owner
 * 2026-11-25: card-first onboarding pays the first credit here, so its consent
 * must be on file for the dispute evidence). Optional: a charge without it is
 * byte-identical to before.
 *
 * Own file (one describe per file — see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { insertTestAccount, cleanTestData, closeDb } from "../helpers/test-db.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";
import { paymentConsents } from "../../src/db/schema.js";

const app = createTestApp();
const orgId = "00000000-0000-4000-8000-0000000000e7";
const userId = "00000000-0000-4000-8000-0000000000e9";
const PATH = `/internal/accounts/by-org/${orgId}/charge`;
const headers = { ...getAuthHeaders(orgId, userId), "x-email": "founder@consent.test" };

const STATEMENTS = ["I accept the Terms & Conditions.", "I understand payments are final."];
const CONSENT = {
  statements: STATEMENTS,
  terms_version: "2026-11-25",
  accepted_at: "2026-11-25T09:00:00.000Z",
  user_agent: "Mozilla/5.0 test",
};

describe("on-demand charge: payment consent", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    await insertTestAccount({ orgId });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("US");
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async (org: string) => ({
      org_id: org,
      spent_cents: "0.0000000000",
      as_of: "2026-11-25T00:00:00.000Z",
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async (org: string) => ({
      org_id: org,
      spent_cents: "0.0000000000",
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a charge carrying consent stores it; the payment-consents read returns it", async () => {
    const res = await request(app).post(PATH).set(headers).send({ amountCents: 5000, consent: CONSENT });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, charged: true, amountCents: 5000, reference: "pi_mock" });

    const read = await request(app)
      .get(`/internal/accounts/by-org/${orgId}/payment-consents`)
      .set({ "X-API-Key": "test-api-key" });
    expect(read.status).toBe(200);
    expect(read.body.consents).toHaveLength(1);
    expect(read.body.consents[0]).toMatchObject({
      org_id: orgId,
      user_id: userId,
      email: "founder@consent.test",
      context: "on_demand_charge",
      statements: STATEMENTS,
      terms_version: "2026-11-25",
      accepted_at: "2026-11-25T09:00:00.000Z",
      user_agent: "Mozilla/5.0 test",
    });
  });

  it("a charge without consent behaves as before and stores nothing", async () => {
    const res = await request(app).post(PATH).set(headers).send({ amountCents: 5000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, charged: true, amountCents: 5000, reference: "pi_mock" });
    expect(await db.select().from(paymentConsents)).toHaveLength(0);
  });

  it("a declined charge keeps its consent on file and its refusal unchanged (402 charge_declined)", async () => {
    ssMocks.reloadOffSession.mockResolvedValue({ status: "failed", failure_reason: "charge.status=failed" });
    const res = await request(app).post(PATH).set(headers).send({ amountCents: 5000, consent: CONSENT });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("charge_declined");
    const rows = await db.select().from(paymentConsents);
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toBe("on_demand_charge");
  });

  it("a malformed consent is a 400 and charges nothing", async () => {
    const res = await request(app)
      .post(PATH)
      .set(headers)
      .send({ amountCents: 5000, consent: { statements: [] } });
    expect(res.status).toBe(400);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    expect(await db.select().from(paymentConsents)).toHaveLength(0);
  });
});
