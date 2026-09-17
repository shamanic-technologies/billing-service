/**
 * The trap: a campaign refused by the read-only affordability pre-flight can
 * never reach the authorize that would have reloaded the card.
 *
 * Every case here is anchored on the prod state measured 2026-09-17 for org
 * 81b34252-… — balance −4994.13 cents against a −5000 floor with an 11.80-cent
 * stored estimate, refused 48 times in 24 hours while its card was valid and its
 * own authorize route answered `sufficient: true`.
 *
 * Own file rather than a describe appended to month-end-sweep.test.ts: that one
 * closes the shared postgres.js connection in afterAll (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanTestData,
  insertTestAccount,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as emailClient from "../../src/lib/email-client.js";
import { upsertCampaignAuthorizeCost } from "../../src/lib/campaign-costs.js";
import {
  runCampaignReloadSweep,
  campaignReloadIdempotencyKey,
  MAX_ATTEMPTS_PER_STREAK,
} from "../../src/lib/campaign-reload-sweep.js";

const orgA = "00000000-0000-0000-0000-0000000000a1";
const orgB = "00000000-0000-0000-0000-0000000000b1";
const campaignA = "00000000-0000-0000-0000-0000000000c1";
const campaignA2 = "00000000-0000-0000-0000-0000000000c2";
const campaignB = "00000000-0000-0000-0000-0000000000c3";
const billingEmail = "info@ppeprosolutions.test";

const NOW = new Date(Date.UTC(2026, 8, 17, 7, 0, 0));
const HOUR_BUCKET = Math.floor(NOW.getTime() / 3_600_000);

/** The prod figures: $195.15 paid (base tier, −5000 floor), balance −4994.13. */
const PROD_PAID = "19515.0000000000";
const PROD_USAGE = "27509.1310968628"; // credited 22515 − usage → −4994.1310968628
const PROD_CREDITED_PROMO = 3000; // the welcome grant, so credited = 22515
const PROD_ESTIMATE = "11.8000000000";

describe("blocked-campaign reload sweep", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (orgId: string, cents: string) => void;
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail(billingEmail));
    await cleanTestData();

    const usageByOrg = new Map<string, string>();
    setUsage = (orgId: string, cents: string) => usageByOrg.set(orgId, cents);
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      async (orgId: string) => ({
        org_id: orgId,
        spent_cents: usageByOrg.get(orgId) ?? "0.0000000000",
        as_of: NOW.toISOString(),
      })
    );
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(
      "99999999-9999-4999-8999-999999999999" as never
    );
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined as never);
    sendMock = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendMock as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** The prod org: auto-topup armed, a real card, balance inside the trap band. */
  async function seedTrappedOrg(estimate = PROD_ESTIMATE) {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 4900,
      topupThresholdCents: 500,
    });
    const { insertTestPromoGrant } = await import("../helpers/test-db.js");
    await insertTestPromoGrant({
      orgId: orgA,
      userId: "11111111-1111-4111-8111-111111111111",
      amountCents: PROD_CREDITED_PROMO,
      promoCode: "welcome",
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(PROD_PAID);
    setUsage(orgA, PROD_USAGE);
    await upsertCampaignAuthorizeCost(campaignA, orgA, estimate);
  }

  it("charges the reload authorize would have fired, sized to (floor + estimate)", async () => {
    await seedTrappedOrg();

    const res = await runCampaignReloadSweep(NOW);

    expect(res.scanned).toBe(1);
    expect(res.blocked).toBe(1);
    expect(res.charged).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.notReloadCapable).toBe(0);
    // Base tier ($50 line) → one $50 multiple lifts −4994.13 to the −4988.20
    // target (floor −5000 + the 11.80 estimate), leaving the run its headroom.
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0]?.[1]).toBe(5000);
    expect(ssMocks.reloadOffSession.mock.calls[0]?.[2]).toBe(
      campaignReloadIdempotencyKey(orgA, HOUR_BUCKET, 5000)
    );
    // Nothing is mailed on the happy path — the customer's campaign simply runs.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("leaves an org with headroom for its next run alone", async () => {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 4900,
      topupThresholdCents: 500,
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(PROD_PAID);
    // balance −4000 against a −5000 floor: 1000 cents of headroom for a 11.80c run.
    setUsage(orgA, "23515.0000000000");
    await upsertCampaignAuthorizeCost(campaignA, orgA, PROD_ESTIMATE);

    const res = await runCampaignReloadSweep(NOW);

    expect(res.blocked).toBe(0);
    expect(res.charged).toBe(0);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("re-reads the balance, so a charged org is skipped on the next tick", async () => {
    await seedTrappedOrg();

    await runCampaignReloadSweep(NOW);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);

    // The charge mirrors immediately (stripe-service mirrors on the same
    // request), so the next tick reads +5.87 and has nothing to do.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("24515.0000000000");
    const second = await runCampaignReloadSweep(NOW);

    expect(second.blocked).toBe(0);
    expect(second.charged).toBe(0);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
  });

  it("charges ONCE per org, decided on the HUNGRIEST campaign", async () => {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 4900,
      topupThresholdCents: 500,
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(PROD_PAID);
    // balance −4990 against a −5000 floor: 10 cents of headroom.
    setUsage(orgA, "27505.0000000000");
    // A 5-cent campaign still fits; a 20-cent one does not. Deciding on the
    // cheapest would leave the hungry campaign refused forever.
    await upsertCampaignAuthorizeCost(campaignA, orgA, "5.0000000000");
    await upsertCampaignAuthorizeCost(campaignA2, orgA, "20.0000000000");

    const res = await runCampaignReloadSweep(NOW);

    expect(res.scanned).toBe(1);
    expect(res.blocked).toBe(1);
    expect(res.charged).toBe(1);
    // ONE charge for the org, never one per campaign.
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0]?.[1]).toBe(5000);
  });

  it("never charges an org with no credit line — dunning owns those", async () => {
    // No auto-topup config → strictly prepaid, floor "0". This is the shape of
    // the five other orgs blocked in prod, each already carrying an OPEN
    // depletion episode with its T0 sent.
    await insertTestAccount({ orgId: orgB });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    setUsage(orgB, "0.0000000000"); // balance 0, estimate 92.28 → blocked at floor 0
    await upsertCampaignAuthorizeCost(campaignB, orgB, "92.2800000000");

    const res = await runCampaignReloadSweep(NOW);

    expect(res.blocked).toBe(1);
    expect(res.notReloadCapable).toBe(1);
    expect(res.charged).toBe(0);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
    // No CARD is charged, and no reload-failure mail is sent — but the org IS
    // handed to the dunning engine, which is what this sweep is for: it can
    // never reach `authorize`, so this is the only place its episode can open.
    // See tests/integration/wedged-org-dunning.test.ts.
    expect(res.episodesOpened).toBe(1);
    const eventTypes = sendMock.mock.calls.map((c) => c[0].eventType);
    expect(eventTypes).toEqual(["credit-depleted"]);
  });

  it("never charges an org whose card cannot be charged off_session", async () => {
    await seedTrappedOrg();
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");

    const res = await runCampaignReloadSweep(NOW);

    expect(res.blocked).toBe(1);
    expect(res.notReloadCapable).toBe(1);
    expect(ssMocks.reloadOffSession).not.toHaveBeenCalled();
  });

  it("tells the customer when the card declines — once per failure streak", async () => {
    await seedTrappedOrg();
    // A declined off_session charge reaches us as a THROW (stripe-service 402).
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    const first = await runCampaignReloadSweep(NOW);

    expect(first.failed).toBe(1);
    expect(first.charged).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sent = sendMock.mock.calls[0]?.[0] as {
      eventType: string;
      orgId: string;
      recipientEmail?: string;
      runId: string;
    };
    expect(sent.eventType).toBe("credits-reload-failed");
    expect(sent.orgId).toBe(orgA);
    expect(sent.recipientEmail).toBe(billingEmail);
    // A real run, never a minted uuid — the email service records the mail as a
    // CHILD of it and silently drops a send whose parent does not exist.
    expect(runsClient.createPlatformRun).toHaveBeenCalled();

    // Second tick, same hour: the next rung is not due, so nothing is charged
    // and the customer is not told again.
    const second = await runCampaignReloadSweep(NOW);
    expect(second.awaitingRetry).toBe(1);
    expect(second.failed).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent when a run cannot be opened, so the next tick retries", async () => {
    await seedTrappedOrg();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(null as never);

    const res = await runCampaignReloadSweep(NOW);

    expect(res.failed).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("presents a refused card once, then not again until the next rung is due", async () => {
    await seedTrappedOrg();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    const first = await runCampaignReloadSweep(NOW);
    expect(first.failed).toBe(1);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);

    // The coalescer's cooldown CAPS at one hour — exactly this sweep's interval
    // — so it could never have stopped the next tick. Reset it, to prove the
    // stand-down is the schedule and not the cooldown.
    _resetCoalescer();
    const anHourLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    const second = await runCampaignReloadSweep(anHourLater);

    expect(second.awaitingRetry).toBe(1);
    expect(second.failed).toBe(0);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    // And the customer is not told a second time about the same streak.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("retries on the schedule — +1d, +3d, +7d, +14d — then stands down", async () => {
    await seedTrappedOrg();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    const at = (days: number) => new Date(NOW.getTime() + days * 24 * 3600_000);
    await runCampaignReloadSweep(NOW); // attempt 1, immediate

    // Each rung is measured from the FIRST refusal, so a missed tick or a
    // restart cannot shift it. Just before is too early; just after fires.
    for (const [i, day] of [1, 3, 7, 14].entries()) {
      _resetCoalescer();
      const early = await runCampaignReloadSweep(
        new Date(at(day).getTime() - 60_000)
      );
      expect(early.awaitingRetry).toBe(1);
      expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(i + 1);

      _resetCoalescer();
      const due = await runCampaignReloadSweep(at(day));
      expect(due.failed).toBe(1);
      expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(i + 2);
    }

    // Five refusals over a fortnight is an answer. The month-end sweep still
    // settles what is owed; this sweep is done.
    _resetCoalescer();
    const after = await runCampaignReloadSweep(at(60));
    expect(after.exhausted).toBe(1);
    expect(after.awaitingRetry).toBe(0);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_STREAK);
    // One mail for the whole streak, not one per rung.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("tells the customer once per streak even across a restart", async () => {
    await seedTrappedOrg();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    await runCampaignReloadSweep(NOW);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // A deploy wipes lib/reload-coalescer's in-memory failure counter, which is
    // what used to gate this mail — and we deploy several times a day, so
    // "once per streak" silently meant "once per deploy". The marker is a
    // COLUMN precisely so a restart cannot re-open the mail.
    _resetCoalescer();
    const nextRung = await runCampaignReloadSweep(
      new Date(NOW.getTime() + 24 * 3600_000)
    );

    expect(nextRung.failed).toBe(1);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("re-arms the whole streak the moment a recharge moves credited", async () => {
    await seedTrappedOrg();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    await runCampaignReloadSweep(NOW);
    _resetCoalescer();
    expect((await runCampaignReloadSweep(NOW)).awaitingRetry).toBe(1);

    // The customer pays by hand. $3.85, deliberately keeping cumulative paid
    // under the $200 tier breakpoint so the floor is unchanged and the org is
    // still in the band — this case is about the streak resetting, nothing else.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("19900.0000000000");
    setUsage(orgA, "27894.1310968628");
    ssMocks.reloadOffSession.mockResolvedValue({ status: "succeeded" });
    _resetCoalescer();

    const third = await runCampaignReloadSweep(NOW);

    // credited moving means the WORLD changed, so the charge happens NOW rather
    // than at the next rung — elapsed time is a different question.
    expect(third.awaitingRetry).toBe(0);
    expect(third.charged).toBe(1);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(2);
  });

  it("a fresh streak after a success is told afresh", async () => {
    await seedTrappedOrg();

    const first = await runCampaignReloadSweep(NOW);
    expect(first.charged).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();

    // A succeeded attempt ends the streak, so its notification marker goes with
    // it — a LATER refusal is news again.
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));
    _resetCoalescer();
    const later = await runCampaignReloadSweep(
      new Date(NOW.getTime() + 30 * 24 * 3600_000)
    );

    expect(later.awaitingRetry).toBe(0);
    expect(later.failed).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("isolates a per-org failure — one unreachable org never blocks the rest", async () => {
    await seedTrappedOrg();
    await insertTestAccount({ orgId: orgB, topupAmountCents: 4900 });
    await upsertCampaignAuthorizeCost(campaignB, orgB, PROD_ESTIMATE);
    ssMocks.fetchOrgCustomer.mockImplementation(async (orgId: string) => {
      if (orgId === orgB) throw new Error("stripe-service unreachable");
      return customerWithEmail(billingEmail);
    });

    const res = await runCampaignReloadSweep(NOW);

    expect(res.scanned).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.charged).toBe(1);
  });
});
