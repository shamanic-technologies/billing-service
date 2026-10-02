/**
 * Our own internal org (lib/platform-org, migration 0057) is never refused by its
 * balance or a declined card, and never charged. A customer org in the exact same
 * state is still refused — every case runs the customer twin as the control.
 *
 * The geometry is prod 2026-10-01 for distribute.you (f0420eb5-…): postpaid with
 * more than $1000 paid (so the -$500 floor rung), balance just past -$500, the $500
 * reload declined `generic_decline`, and apollo-service refused on every authorize.
 *
 * Own file (CLAUDE.md: one describe per file that closes the DB).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  insertTestAccount,
  listEpisodes,
  closeDb,
  SEEDED_PLATFORM_ORG_ID,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import { db } from "../../src/db/index.js";
import { platformOrgs } from "../../src/db/schema.js";
import { isPlatformOrg } from "../../src/lib/platform-org.js";
import { upsertCampaignAuthorizeCost } from "../../src/lib/campaign-costs.js";
import { runCampaignReloadSweep } from "../../src/lib/campaign-reload-sweep.js";
import { flagUncollectableDebt } from "../../src/lib/unpaid-debt.js";
import { resolveSpendBlock } from "../../src/lib/spend-block.js";
import { computeBalance } from "../../src/lib/balance.js";

const platformOrg = "00000000-0000-0000-0000-0000000001a1";
const customerOrg = "00000000-0000-0000-0000-0000000001a2";
const userId = "11111111-1111-4111-8111-111111111111";
const campaignOf = (org: string) => (org === platformOrg ? "00000000-0000-0000-0000-0000000001b1" : "00000000-0000-0000-0000-0000000001b2");

/** $3936.52 paid (≥ $1000 ⇒ -50000 floor), usage puts the balance at -500.15. */
const PAID = "393652.0000000000";
const USAGE = "443667.4952448447";
const REQUIRED = "0.4450000000";

const authorizeBody = {
  items: [{ costName: "apify-bounceverify-email", quantity: 1 }],
  description: "newsletter email verification",
};

describe("platform orgs are never refused by their balance or a declined card", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("billing@distribute.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(PAID);
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.reloadOffSession.mockResolvedValue({ status: "failed", failure_reason: "card_declined: generic_decline" });
    await cleanTestData();

    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue(REQUIRED);
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(async (orgId: string) => ({
      org_id: orgId,
      spent_cents: USAGE,
      as_of: "2026-10-01T13:45:38.000Z",
    }));
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue("99999999-9999-4999-8999-999999999999" as never);
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined as never);
    const emailClient = await import("../../src/lib/email-client.js");
    sendMock = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendMock as never);

    for (const orgId of [platformOrg, customerOrg]) {
      await insertTestAccount({ orgId, topupAmountCents: 5000, topupThresholdCents: 1000 });
      await upsertCampaignAuthorizeCost(campaignOf(orgId), orgId, REQUIRED);
    }
    await db.insert(platformOrgs).values({ orgId: platformOrg, reason: "test", addedBy: "test" });
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function authorize(orgId: string) {
    return request(app)
      .post("/v1/customer_balance/authorize")
      .set({ ...getAuthHeaders(orgId, userId), "x-campaign-id": campaignOf(orgId) })
      .send(authorizeBody);
  }

  it("migration 0057 seeds distribute.you as a platform org, and only it", async () => {
    expect(await isPlatformOrg(SEEDED_PLATFORM_ORG_ID)).toBe(true);
    expect(await isPlatformOrg(customerOrg)).toBe(false);
    expect(await isPlatformOrg("not-a-uuid")).toBe(false);
  });

  it("authorize: platform org sufficient with the TRUE negative balance, no charge, no episode", async () => {
    const res = await authorize(platformOrg);
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(true);
    expect(res.body.balance_cents).toBe("-50015.4952448447");
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    expect(await listEpisodes(platformOrg)).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("authorize: a customer org in the same state is still refused after the card declines", async () => {
    const res = await authorize(customerOrg);
    expect(res.status).toBe(200);
    expect(res.body.sufficient).toBe(false);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(await listEpisodes(customerOrg)).toHaveLength(1);
  });

  it("usage_apply: never reloads a platform org", async () => {
    const res = await request(app)
      .post("/v1/customer_balance/usage_apply")
      .set(getAuthHeaders(platformOrg, userId))
      .send({ spent_total_cents: "1" });
    expect(res.status).toBe(202);
    expect(res.body.topup_triggered).toBe(false);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("affordability pre-flight: platform org affordable, customer refused", async () => {
    const get = (orgId: string) =>
      request(app)
        .get(`/internal/campaigns/${campaignOf(orgId)}/affordability`)
        .set({ "X-API-Key": "test-api-key", "x-org-id": orgId });
    expect((await get(platformOrg)).body.affordable).toBe(true);
    expect((await get(customerOrg)).body.affordable).toBe(false);
  });

  it("spend block, reload sweep, debt flag: platform org never blocked, charged or flagged", async () => {
    expect((await resolveSpendBlock(platformOrg, await computeBalance(platformOrg))).blocked).toBe(false);
    expect((await resolveSpendBlock(customerOrg, await computeBalance(customerOrg))).blocked).toBe(true);

    await runCampaignReloadSweep(new Date("2026-10-01T14:00:00Z"));
    const charged = ssMocks.reloadOffSession.mock.calls.map((c) => c[0]);
    expect(charged).not.toContain(platformOrg);
    expect(charged).toContain(customerOrg);
    expect(await listEpisodes(platformOrg)).toHaveLength(0);

    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    const flag = await flagUncollectableDebt({ orgId: platformOrg });
    expect(flag.state).toBe("platform_org");
    expect(await listEpisodes(platformOrg)).toHaveLength(0);
  });
});
