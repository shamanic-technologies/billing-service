/**
 * A wedged org is owned by the dunning engine — whatever side of its credit-line
 * floor the balance happens to sit on.
 *
 * THE TRAP. The affordability pre-flight refuses the next run when
 * `balance − lastRequired < floor`; the depletion episode opened when
 * `balance <= floor`. The gap is exactly `lastRequired` wide, and inside it every
 * run is refused, so the balance never moves, so it never crosses the floor, so
 * no episode ever opened. Worse, the refusal happens in the PRE-FLIGHT, so
 * campaign-service never dispatches and `authorize` — where every episode-opening
 * call site lives — is unreachable.
 *
 * Every geometry here is the prod state measured 2026-09-17 for org 81b34252-…:
 * balance −4994.1310968628 against a −5000 floor with an 11.80-cent estimate,
 * i.e. 5.87 cents of headroom for a run needing 11.80. 83 refusals over 41 hours
 * and ZERO depletion episodes, ever.
 *
 * Own file rather than a describe appended to campaign-reload-sweep.test.ts:
 * that one closes the shared postgres.js connection in afterAll (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanTestData,
  insertTestAccount,
  insertTestPromoGrant,
  insertTestEpisode,
  listEpisodes,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as emailClient from "../../src/lib/email-client.js";
import { upsertCampaignAuthorizeCost } from "../../src/lib/campaign-costs.js";
import { runCampaignReloadSweep } from "../../src/lib/campaign-reload-sweep.js";
import { runDunningTick } from "../../src/lib/dunning.js";

const orgA = "00000000-0000-0000-0000-0000000000e1";
const orgB = "00000000-0000-0000-0000-0000000000e2";
const campaignA = "00000000-0000-0000-0000-0000000000f1";
const userId = "11111111-1111-4111-8111-111111111111";
const billingEmail = "info@ppeprosolutions.test";

const NOW = new Date(Date.UTC(2026, 8, 17, 7, 0, 0));
const DAY_MS = 24 * 60 * 60 * 1000;

/** The prod figures: $195.15 paid (base tier ⇒ −5000 floor), balance −4994.13. */
const PROD_PAID = "19515.0000000000";
const PROD_USAGE = "27509.1310968628";
const PROD_PROMO = 3000;
const PROD_ESTIMATE = "11.8000000000";

describe("a wedged org is owned by the dunning engine", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let setUsage: (orgId: string, cents: string) => void;
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
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
  async function seedWedgedOrg(usage = PROD_USAGE) {
    await insertTestAccount({
      orgId: orgA,
      topupAmountCents: 4900,
      topupThresholdCents: 500,
    });
    await insertTestPromoGrant({
      orgId: orgA,
      userId,
      amountCents: PROD_PROMO,
      promoCode: "welcome",
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(PROD_PAID);
    setUsage(orgA, usage);
    await upsertCampaignAuthorizeCost(campaignA, orgA, PROD_ESTIMATE);
  }

  const t0s = () =>
    sendMock.mock.calls.filter((c) => c[0].eventType === "credit-depleted");

  it("opens an episode for the subject org on the first tick after the deploy", async () => {
    await seedWedgedOrg();
    // The card is gone, so nothing here can unblock it — the shape the bug left
    // invisible for 41 hours.
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);

    const res = await runCampaignReloadSweep(NOW);

    expect(res.blocked).toBe(1);
    expect(res.episodesOpened).toBe(1);
    const episodes = await listEpisodes(orgA);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].recoveredAt).toBeNull();
    // The recovery baseline is the credited at open — 19515 paid + the 3000 promo.
    expect(episodes[0].creditedCentsAtOpen).toBe("22515.0000000000");
    expect(t0s()).toHaveLength(1);
    expect(t0s()[0][0].recipientEmail).toBe(billingEmail);
  });

  it("opens exactly one episode however many times the sweep re-examines it", async () => {
    await seedWedgedOrg();
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);

    await runCampaignReloadSweep(NOW);
    const second = await runCampaignReloadSweep(new Date(NOW.getTime() + 3600_000));

    expect(second.episodesOpened).toBe(0);
    expect(await listEpisodes(orgA)).toHaveLength(1);
    expect(t0s()).toHaveLength(1);
  });

  it("opens one for a PREPAID org too — positive balance, still cannot spend", async () => {
    // No auto-topup config ⇒ floor "0". 92 of 112 prod accounts look like this,
    // so they attempt no reload, produce no failed streak, and were invisible on
    // every surface. Balance +5 cents against a 92.28-cent run.
    await insertTestAccount({ orgId: orgB });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5.0000000000");
    setUsage(orgB, "0.0000000000");
    await upsertCampaignAuthorizeCost(
      "00000000-0000-0000-0000-0000000000f2",
      orgB,
      "92.2800000000"
    );

    const res = await runCampaignReloadSweep(NOW);

    expect(res.blocked).toBe(1);
    expect(res.notReloadCapable).toBe(1);
    expect(res.charged).toBe(0);
    expect(res.episodesOpened).toBe(1);
    expect(await listEpisodes(orgB)).toHaveLength(1);
  });

  it("tells a customer whose card declined ONCE — the episode opens silently", async () => {
    await seedWedgedOrg();
    ssMocks.reloadOffSession.mockRejectedValue(new Error("card_declined"));

    const res = await runCampaignReloadSweep(NOW);

    expect(res.failed).toBe(1);
    expect(res.episodesOpened).toBe(1);
    // "We could not charge your card" is the message. Following it seconds later
    // with "you are out of credit" tells one story twice.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].eventType).toBe("credits-reload-failed");
    // The stage is genuinely spent — the customer WAS told about this failure.
    const [ep] = await listEpisodes(orgA);
    expect(ep.t0SentAt).not.toBeNull();
  });

  it("never opens one for an org it successfully charged", async () => {
    await seedWedgedOrg();

    const res = await runCampaignReloadSweep(NOW);

    expect(res.charged).toBe(1);
    expect(res.episodesOpened).toBe(0);
    expect(await listEpisodes(orgA)).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("never opens one for an org with headroom for its next run", async () => {
    // balance −4000 against the −5000 floor: 1000 cents of room for an 11.80c
    // run. A postpaid org running negative WITHIN its line is not in dunning.
    await seedWedgedOrg("26515.0000000000");

    const res = await runCampaignReloadSweep(NOW);

    expect(res.blocked).toBe(0);
    expect(res.episodesOpened).toBe(0);
    expect(await listEpisodes(orgA)).toHaveLength(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("leaves an already-open episode exactly as it is", async () => {
    await seedWedgedOrg();
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    const startedAt = new Date(NOW.getTime() - 57 * DAY_MS);
    await insertTestEpisode({
      orgId: orgA,
      userId,
      startedAt,
      t0SentAt: startedAt,
      creditedCentsAtOpen: "1.0000000000",
    });

    const res = await runCampaignReloadSweep(NOW);

    expect(res.episodesOpened).toBe(0);
    const [ep] = await listEpisodes(orgA);
    expect(await listEpisodes(orgA)).toHaveLength(1);
    expect(ep.startedAt.toISOString()).toBe(startedAt.toISOString());
    expect(ep.creditedCentsAtOpen).toBe("1.0000000000");
    expect(t0s()).toHaveLength(0);
  });

  describe("the dunning tick agrees with the gate that opened the episode", () => {
    it("sends the +3d follow-up to an org still stuck in the gap band", async () => {
      await seedWedgedOrg();
      ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
      await insertTestEpisode({
        orgId: orgA,
        userId,
        startedAt: new Date(Date.now() - 4 * DAY_MS),
        t0SentAt: new Date(Date.now() - 4 * DAY_MS),
        creditedCentsAtOpen: "22515.0000000000",
      });

      const res = await runDunningTick();

      expect(res.followup3dSent).toBe(1);
      expect(res.recovered).toBe(0);
    });

    it("sends NOTHING to a postpaid org running negative within its line", async () => {
      // THE HAZARD. The tick used to gate its follow-ups on `balance <= 0`, not
      // on the credit-line floor, so every postpaid org running normally
      // negative read as depleted. Harmless only while the OPEN gate was
      // narrower than this one; widening the open gate without reconciling this
      // would have mailed "you are out of credit" to orgs paying us perfectly.
      await seedWedgedOrg("26515.0000000000"); // balance −4000, floor −5000
      await insertTestEpisode({
        orgId: orgA,
        userId,
        startedAt: new Date(Date.now() - 11 * DAY_MS),
        t0SentAt: new Date(Date.now() - 11 * DAY_MS),
        creditedCentsAtOpen: "22515.0000000000",
      });

      const res = await runDunningTick();

      expect(res.followup3dSent).toBe(0);
      expect(res.followup10dSent).toBe(0);
      expect(res.recovered).toBe(0); // still open — it recovers on a recharge
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("still closes on a real recharge, and on nothing else", async () => {
      await seedWedgedOrg();
      ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
      await insertTestEpisode({
        orgId: orgA,
        userId,
        startedAt: new Date(Date.now() - 4 * DAY_MS),
        t0SentAt: new Date(Date.now() - 4 * DAY_MS),
        // Credited was lower when the episode opened, so credited has RISEN.
        creditedCentsAtOpen: "20000.0000000000",
      });

      const res = await runDunningTick();

      expect(res.recovered).toBe(1);
      expect(res.followup3dSent).toBe(0);
      const [ep] = await listEpisodes(orgA);
      expect(ep.recoveredAt).not.toBeNull();
    });
  });
});
