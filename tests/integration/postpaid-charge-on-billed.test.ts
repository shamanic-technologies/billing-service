/**
 * POSTPAID-CHARGE-ON-BILLED-1029. Owner 2026-10-29, verbatim: « Tout sur le
 * facturé : prélèvement quand le facturé atteint $50 ou le 31, montant = facturé.
 * Les provisions ne sont jamais encaissées, juste affichées à côté. »
 *
 * A postpaid org's credit line is crossed and charged on BILLED (actual) usage
 * only. Provisioned holds (worst-case reservations for follow-up emails already
 * scheduled) never trigger a charge, are never charged, and never wedge a
 * campaign. Prepaid keeps the spendable balance.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import { upsertCampaignAuthorizeCost } from "../../src/lib/campaign-costs.js";
import { runCampaignReloadSweep } from "../../src/lib/campaign-reload-sweep.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as emailClient from "../../src/lib/email-client.js";

const orgId = "00000000-0000-0000-0000-000000001029";
const campaignId = "00000000-0000-0000-0000-0000000010d9";
const NOW = new Date(Date.UTC(2026, 9, 15, 7, 0, 0));

describe("postpaid: charge only what is billed", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  // credited is 0 (nothing paid yet), so balance = −usage.
  let billed = "0.0000000000"; // actual usage
  let holds = "0.0000000000"; // provisioned holds

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    await cleanTestData();
    billed = "0.0000000000";
    holds = "0.0000000000";

    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("client@billed.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("FR");

    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: (Number(billed) + Number(holds)).toFixed(10),
      as_of: NOW.toISOString(),
    }));
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({
      org_id: orgId,
      spent_cents: billed,
      as_of: NOW.toISOString(),
    }));
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(
      "99999999-9999-4999-8999-999999999999" as never
    );
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined as never);
    vi.spyOn(emailClient, "sendEmail").mockImplementation((() => undefined) as never);
    const costs = await import("../../src/lib/costs-client.js");
    vi.spyOn(costs, "resolveRequiredCents").mockResolvedValue("10.0000000000");
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const insertPostpaid = () =>
    insertTestAccount({ orgId, paymentMode: "postpaid", topupAmountCents: 5000, topupThresholdCents: 0 });

  const authorize = () =>
    request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId), "x-campaign-id": campaignId })
      .send({ items: [{ costName: "x", quantity: 1 }] });

  const affordability = () =>
    request(app)
      .get(`/internal/campaigns/${campaignId}/affordability`)
      .set({ "X-API-Key": "test-api-key", "x-org-id": orgId });

  async function stampEstimate() {
    await upsertCampaignAuthorizeCost(campaignId, orgId, "10.0000000000");
    await db.execute(
      sql`UPDATE campaign_authorize_costs SET updated_at = ${NOW.toISOString()}::timestamptz WHERE org_id = ${orgId}`
    );
  }

  it("billed $45 + provisioned $10 on a $50 line: no charge, campaigns keep running", async () => {
    await insertPostpaid();
    billed = "4500.0000000000";
    holds = "1000.0000000000"; // spendable −$55, past the line; billed −$45, inside it

    const res = await authorize();
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    // The wire shape is unchanged: balance_cents is still the spendable balance.
    expect(res.body.balance_cents).toBe("-5500.0000000000");

    const pre = await affordability();
    expect(pre.status).toBe(200);
    expect(pre.body.affordable).toBe(true);

    await stampEstimate();
    const sweep = await runCampaignReloadSweep(NOW);
    expect(sweep.blocked).toBe(0);

    const usageApply = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId))
      .send({ spent_total_cents: "5500" });
    expect(usageApply.status).toBe(202);
    expect(usageApply.body.topup_triggered).toBe(false);

    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("billed crosses $50: one charge of the billed amount owed, holds not charged", async () => {
    await insertPostpaid();
    billed = "5020.0000000000";
    holds = "1000.0000000000";

    const res = await authorize();
    expect(res.status).toBe(200);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    // $50.20 billed: never the $60.20 with holds, never a $50 step.
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(5020);
  });

  it("the run that would cross the line charges what is billed so far", async () => {
    await insertPostpaid();
    billed = "4995.0000000000"; // −$49.95 − the $0.10 run crosses −$50
    holds = "800.0000000000";

    await authorize();
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(4995);
  });

  it("usage_apply charges the billed amount owed once billed crosses the line", async () => {
    await insertPostpaid();
    billed = "5100.0000000000";
    holds = "2000.0000000000";

    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(orgId))
      .send({ spent_total_cents: "7100" });
    expect(res.status).toBe(202);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(5100);
  });

  it("the blocked-campaign sweep charges the billed amount owed, never holds", async () => {
    await insertPostpaid();
    billed = "5050.0000000000";
    holds = "1500.0000000000";
    await stampEstimate();

    const pre = await affordability();
    expect(pre.body.affordable).toBe(false);

    const sweep = await runCampaignReloadSweep(NOW);
    expect(sweep.blocked).toBe(1);
    expect(sweep.charged).toBe(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(5050);
  });

  it("prepaid is unchanged: holds still count against its balance", async () => {
    await insertTestAccount({ orgId, paymentMode: "prepaid", topupAmountCents: 5000, topupThresholdCents: 500 });
    billed = "0.0000000000";
    holds = "100.0000000000"; // spendable −$1, billed $0

    const res = await authorize();
    expect(res.status).toBe(200);
    // Prepaid reloads on the spendable balance, exactly as before.
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
  });
});
