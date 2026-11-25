/**
 * The solo-founder plan's PAY LINK (lib/solo-pay-link, routes/solo_pay_link):
 *   - one signed link per org, no API key, no login; forged / other org / expired = 404;
 *   - opening it (GET, what link previews do) never moves money;
 *   - its one POST button starts the trial (card page first when no card) or adds $100;
 *   - a stale page (second click) never charges twice.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail, mockCardHold } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { soloPlans } from "../../src/db/schema.js";
import { enrolSoloPlan, getSoloPlan } from "../../src/lib/solo-plan.js";
import { payLinkPath, signPayToken, verifyPayToken } from "../../src/lib/solo-pay-link.js";

const orgId = "a0000000-0000-4000-8000-0000000502a1";
const otherOrgId = "a0000000-0000-4000-8000-0000000502b1";
const userId = "a0000000-0000-4000-8000-0000000502a9";
const DAY = 86400_000;

function card(prepaid: boolean) {
  return {
    object: "saved_payment_method",
    org_id: orgId,
    acquirer: "stripe",
    saved: true,
    method: { id: "pm_pay", type: "card", saved_for: "merchant", funding: prepaid ? "prepaid" : "debit", prepaid },
  };
}
const NO_CARD = { object: "saved_payment_method", org_id: orgId, acquirer: "stripe", saved: false, method: null, reason: "none" };

describe("solo-founder pay link", () => {
  const app = createTestApp();
  let ss: ReturnType<typeof setupStripeMocks>;
  let usage = "0.0000000000";
  let paid = "0.0000000000";

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    process.env.SOLO_PLAN_PUBLIC_BASE_URL = "https://api.distribute.you";
    usage = "0.0000000000";
    paid = "0.0000000000";
    ss = setupStripeMocks();
    ss.fetchOrgCustomer.mockResolvedValue(customerWithEmail("kevin.lourd+paylink@gmail.com"));
    ss.sumSucceededTopupsForOrg.mockImplementation(async () => paid);
    ss.hasChargeablePmForOrg.mockResolvedValue(true);
    ss.getOrgCardCountryByOrg.mockResolvedValue("US");
    ss.getSavedPaymentMethod.mockResolvedValue(NO_CARD);
    ss.placeCardHold.mockImplementation(async (_o: string, body: { amount: number; metadata?: Record<string, string> }) =>
      mockCardHold({ id: "hold_pay_1", amount: body.amount, metadata: body.metadata ?? null })
    );
    const runs = await import("../../src/lib/runs-client.js");
    vi.spyOn(runs, "fetchRunsOrgUsageTotal").mockImplementation(async () => ({ org_id: orgId, spent_cents: usage, as_of: "x" }));
    vi.spyOn(runs, "fetchRunsOrgActualUsageTotal").mockImplementation(async () => ({ org_id: orgId, spent_cents: usage, as_of: "x" }));
    vi.spyOn(runs, "createPlatformRun").mockResolvedValue("00000000-0000-4000-8000-00000000a002");
    vi.spyOn(runs, "completePlatformRun").mockResolvedValue(undefined);
    const email = await import("../../src/lib/email-client.js");
    vi.spyOn(email, "sendEmail").mockImplementation(vi.fn());
  });

  afterAll(async () => {
    delete process.env.SOLO_PLAN_PUBLIC_BASE_URL;
    await cleanTestData();
    await closeDb();
  });

  function noMoneyMoved() {
    expect(ss.placeCardHold).not.toHaveBeenCalled();
    expect(ss.reloadOffSession).not.toHaveBeenCalled();
    expect(ss.captureCardHold).not.toHaveBeenCalled();
  }

  it("a token pays for its own org only, and expires", async () => {
    const token = signPayToken(orgId);
    expect(verifyPayToken(token)).toBe(orgId);
    // Swap the org inside the token: the signature no longer matches.
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(`${otherOrgId}.${Math.floor(Date.now() / 1000) + 3600}`).toString("base64url")}.${sig}`;
    expect(verifyPayToken(forged)).toBeNull();
    expect(verifyPayToken("garbage")).toBeNull();
    const old = signPayToken(orgId, new Date(Date.now() - 31 * DAY));
    expect(verifyPayToken(old)).toBeNull();
    for (const t of [forged, old, "garbage"]) {
      const res = await request(app).get(`/public/solo-plan/pay/${t}`);
      expect(res.status).toBe(404);
      expect(res.text).toContain("This link has expired");
    }
  });

  it("opening the link never charges; one click goes to the card page, then starts the trial", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" });
    await enrolSoloPlan(orgId, userId);
    const path = payLinkPath(orgId);

    // No API key, no login. Previews fetch it: nothing moves.
    const view = await request(app).get(path);
    expect(view.status).toBe(200);
    expect(view.text).toContain("Start your 3-day trial");
    expect(view.text).toContain("Start my trial");
    noMoneyMoved();
    expect(ss.getCardSetup).not.toHaveBeenCalled();

    // Click with no card -> the hosted card page, returning to a fresh pay link.
    let click = await request(app).post(path).type("form").send({ expect: "free:9900:" });
    expect(click.status).toBe(303);
    expect(click.headers.location).toBe("https://billing.stripe.com/p/session/abc");
    expect(ss.getCardSetup.mock.calls[0][1]).toMatch(/^https:\/\/api\.distribute\.you\/public\/solo-plan\/pay\//);
    noMoneyMoved();

    // Card saved -> the same button holds $99 and starts the trial.
    ss.getSavedPaymentMethod.mockResolvedValue(card(false));
    click = await request(app).post(path).type("form").send({ expect: "free:9900:" });
    expect(click.status).toBe(303);
    expect(click.headers.location).toBe(`${path.split("/").pop()}?done=trial`);
    expect(ss.placeCardHold).toHaveBeenCalledWith(orgId, expect.objectContaining({ amount: 9900, session: "on_session" }), expect.any(String));
    expect((await getSoloPlan(orgId))!.status).toBe("trialing");
    const after = await request(app).get(`${path}?done=trial`);
    expect(after.text).toContain("Your trial has started");
    expect(after.text).toContain("Pay $99 now");
  });

  it("an active plan: the page states $199 minus unspent, one click charges it once", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" });
    await enrolSoloPlan(orgId, userId);
    const start = new Date(Date.now() - 11 * DAY);
    await db
      .update(soloPlans)
      .set({ status: "active", currentPeriodStart: start, currentPeriodEnd: new Date(start.getTime() + 30 * DAY), renewalAnchorAt: start })
      .where(eq(soloPlans.orgId, orgId));
    ss.getSavedPaymentMethod.mockResolvedValue(card(false));
    paid = "9900.0000000000";
    usage = "4000.0000000000"; // $59 unspent

    const path = payLinkPath(orgId);
    const view = await request(app).get(path);
    expect(view.text).toContain("Grow to $199 a month");
    expect(view.text).toContain("You pay $140 today. Your $59 of unused credit comes off the price.");
    noMoneyMoved();

    const expectValue = `active:9900:${start.toISOString()}`;
    const click = await request(app).post(path).type("form").send({ expect: expectValue });
    expect(click.status).toBe(303);
    expect(click.headers.location).toBe(`${path.split("/").pop()}?done=layer`);
    expect(ss.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ss.reloadOffSession).toHaveBeenCalledWith(orgId, 14000, expect.any(String), expect.objectContaining({ reason: "solo_plan" }));
    expect((await getSoloPlan(orgId))!.monthlyAmountCents).toBe(19900);

    // Back button / second click with the page's old state: shown again, never charged twice.
    const again = await request(app).post(path).type("form").send({ expect: expectValue });
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe(path.split("/").pop());
    expect(ss.reloadOffSession).toHaveBeenCalledTimes(1);
  });

  it("a prepaid card is sent back to the card page, no hold", async () => {
    await insertTestAccount({ orgId, freeCreditOffer: "prepaid_at_cost", paymentMode: "prepaid" });
    ss.getSavedPaymentMethod.mockResolvedValue(card(true));
    const click = await request(app).post(payLinkPath(orgId)).type("form").send({ expect: "none" });
    expect(click.status).toBe(303);
    expect(click.headers.location).toBe("https://billing.stripe.com/p/session/abc");
    noMoneyMoved();
  });

  it("a link for an existing (legacy) account changes nothing", async () => {
    await insertTestAccount({ orgId });
    const click = await request(app).post(payLinkPath(orgId)).type("form").send({ expect: "none" });
    expect(click.status).toBe(409);
    expect(click.text).toContain("keeps its current offer");
    expect(await getSoloPlan(orgId)).toBeNull();
    noMoneyMoved();
  });
});
