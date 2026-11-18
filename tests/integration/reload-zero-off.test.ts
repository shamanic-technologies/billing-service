/**
 * RELOAD-ZERO-OFF-1118: a reload amount of $0 switches automatic top-up OFF.
 * Owner 2026-11-18: « Accepte une valeur $0, ca enleve lauto top up ».
 *
 * PATCH /v1/accounts/auto_topup { topup_amount_cents: 0 } = DELETE /v1/accounts/auto_topup:
 * same row written, same refusals. An amount above 0 and below the reload minimum is
 * still refused.
 *
 * Own file: other suites close the shared connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";

const orgId = "00000000-0000-4000-8000-0000000012b1";
const person = "11111111-1111-4111-8111-1111111112b1";

describe("A $0 reload amount switches automatic top-up off", () => {
  const app = createTestApp();

  beforeEach(async () => {
    vi.restoreAllMocks();
    const ss = setupStripeMocks();
    await cleanTestData();
    const usage = vi.fn().mockResolvedValue({ spent_cents: "0.0000000000" });
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(usage as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockImplementation(usage as never);
    ss.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const patch = (body: Record<string, unknown>) =>
    request(app).patch("/v1/accounts/auto_topup").set(getAuthHeaders(orgId, person)).send(body);
  const row = async () => (await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId)))[0];

  it("amount 0 disarms: the account reads auto top-up off afterwards, like DELETE", async () => {
    await insertTestAccount({
      orgId,
      freeCreditOffer: "prepaid_at_cost",
      paymentMode: "prepaid",
      topupAmountCents: 1500,
      topupThresholdCents: 0,
    } as never);
    const res = await patch({ topup_amount_cents: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ has_auto_topup: false, topup_amount_cents: null });
    expect(await row()).toMatchObject({ topupAmountCents: null, topupThresholdCents: null, paymentMode: "prepaid" });

    const read = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId, person));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ has_auto_topup: false, topup_amount_cents: null });
  });

  it("an amount between 1 and the reload minimum is still refused, writing nothing", async () => {
    await insertTestAccount({
      orgId,
      freeCreditOffer: "prepaid_at_cost",
      paymentMode: "prepaid",
      topupAmountCents: 1500,
      topupThresholdCents: 0,
    } as never);
    for (const amount of [1, 999]) {
      const res = await patch({ topup_amount_cents: amount });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "topup_below_minimum", minimum_cents: 1000 });
    }
    expect(await row()).toMatchObject({ topupAmountCents: 1500 });
  });

  it("an org whose offer requires auto top-up still refuses: 409 auto_topup_required, nothing written", async () => {
    await insertTestAccount({
      orgId,
      freeCreditOffer: "agent_api",
      paymentMode: "prepaid",
      topupAmountCents: 2000,
      topupThresholdCents: 0,
    } as never);
    const res = await patch({ topup_amount_cents: 0 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("auto_topup_required");
    expect(await row()).toMatchObject({ topupAmountCents: 2000 });
  });

  it("a postpaid org answers as DELETE does: 409 postpaid_no_auto_topup", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid" } as never);
    const res = await patch({ topup_amount_cents: 0 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("postpaid_no_auto_topup");
  });

  it("a negative amount is still invalid", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" } as never);
    const res = await patch({ topup_amount_cents: -100 });
    expect(res.status).toBe(400);
  });
});
