import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestPromoGrant,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  WELCOME_COMPLETION_LAUNCH_AT_MS,
  WELCOME_COMPLETION_LAUNCH_AT_UNIX,
} from "../../src/db/schema.js";
import { runWelcomeCompletionSweep } from "../../src/lib/welcome-completion-sweep.js";

/**
 * "What had this org paid, as of the launch instant" is asked of stripe-service and
 * answered there — one bounded read (`GET /internal/payment_summary/by-org/{orgId}
 * ?as_of=`), never a client-side filter over the org's PaymentIntents.
 *
 * The four callers that can settle a free-credit promise — the account read, the
 * checkout route, the promises read, and the hourly sweep — must all reach that same
 * read with that same instant. Two of them disagreeing about a money verdict is the
 * incoherence this shape removes, so the check lives in one place and every caller
 * gets it by construction.
 */
const orgId = "00000000-0000-0000-0000-0000000000e1";
const userId = "00000000-0000-0000-0000-0000000000e2";
const BEFORE_LAUNCH = new Date(WELCOME_COMPLETION_LAUNCH_AT_MS - 86_400_000);

/** A pre-existing org that has since crossed its $25 trigger. */
async function preLaunchOrgOverTrigger(ssMocks: ReturnType<typeof setupStripeMocks>) {
  await insertTestAccount({
    orgId,
    welcomeCompletionEligible: true,
    createdAt: BEFORE_LAUNCH,
  });
  await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
  ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue("20000.0000000000");
  ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("20000.0000000000");
}

async function isEligible(org: string): Promise<boolean> {
  const [row] = await db
    .select({ eligible: billingAccounts.welcomeCompletionEligible })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, org));
  return row.eligible;
}

describe("the as-of-launch figure comes from stripe-service, once, for every caller", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    await cleanTestData();
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("the account read asks stripe-service for the launch instant", async () => {
    await preLaunchOrgOverTrigger(ssMocks);
    ssMocks.sumPaidTopupsForOrgAsOf.mockResolvedValue("0.0000000000");

    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(ssMocks.sumPaidTopupsForOrgAsOf).toHaveBeenCalledWith(
      orgId,
      WELCOME_COMPLETION_LAUNCH_AT_UNIX
    );
  });

  it("the checkout route asks the same question with the same instant", async () => {
    await preLaunchOrgOverTrigger(ssMocks);
    ssMocks.sumPaidTopupsForOrgAsOf.mockResolvedValue("0.0000000000");

    await request(app)
      .post("/v1/checkout-sessions")
      .set(getAuthHeaders(orgId))
      .send({
        topup_amount_cents: 5000,
        success_url: "https://app.test/ok",
        cancel_url: "https://app.test/no",
      });

    expect(ssMocks.sumPaidTopupsForOrgAsOf).toHaveBeenCalledWith(
      orgId,
      WELCOME_COMPLETION_LAUNCH_AT_UNIX
    );
  });

  it("the free-credit-promises read asks the same question with the same instant", async () => {
    await preLaunchOrgOverTrigger(ssMocks);
    ssMocks.sumPaidTopupsForOrgAsOf.mockResolvedValue("0.0000000000");

    await request(app).get("/v1/free-credit-promises").set(getAuthHeaders(orgId));

    expect(ssMocks.sumPaidTopupsForOrgAsOf).toHaveBeenCalledWith(
      orgId,
      WELCOME_COMPLETION_LAUNCH_AT_UNIX
    );
  });

  it("the hourly sweep asks the same question with the same instant", async () => {
    await preLaunchOrgOverTrigger(ssMocks);
    ssMocks.sumPaidTopupsForOrgAsOf.mockResolvedValue("0.0000000000");

    await runWelcomeCompletionSweep();

    expect(ssMocks.sumPaidTopupsForOrgAsOf).toHaveBeenCalledWith(
      orgId,
      WELCOME_COMPLETION_LAUNCH_AT_UNIX
    );
  });

  it("all four callers reach the same verdict for the same org and the same instant", async () => {
    // Over the trigger as of launch → excluded, and it stays excluded whichever
    // surface resolves it first.
    await preLaunchOrgOverTrigger(ssMocks);
    ssMocks.sumPaidTopupsForOrgAsOf.mockResolvedValue("20000.0000000000");

    await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    await request(app).get("/v1/free-credit-promises").set(getAuthHeaders(orgId));
    await runWelcomeCompletionSweep();

    expect(await isEligible(orgId)).toBe(false);
    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));
    expect(res.body.credited_gifted_cents).toBe("500.0000000000");
  });

  it("a stripe-service failure on this path surfaces, and grants nothing", async () => {
    await preLaunchOrgOverTrigger(ssMocks);
    ssMocks.sumPaidTopupsForOrgAsOf.mockRejectedValue(
      new Error("stripe-service GET /internal/payment_summary/by-org failed: 502")
    );

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(orgId));

    expect(res.status).toBe(502);
    // No verdict was frozen and no credit was granted on a figure we never got.
    expect(await isEligible(orgId)).toBe(true);
  });
});
