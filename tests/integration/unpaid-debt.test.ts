/**
 * An unpaid debt we cannot collect is VISIBLE, never silently skipped.
 *
 * Before this, an org with a negative balance and no chargeable card was counted
 * `skipped` by the month-end sweep and disappeared: no email, no staff signal,
 * campaigns still running and the debt still growing. These cases pin the three
 * guarantees that are cheap to break — it is never `skipped`, the customer and
 * staff are told exactly ONCE per episode, and the flag clears when a card comes
 * back so the org leaves the staff surface (and a LATER loss notifies afresh).
 *
 * Own file rather than a describe appended to month-end-sweep.test.ts: that one
 * closes the shared postgres.js connection in afterAll (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  listEpisodes,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as emailClient from "../../src/lib/email-client.js";
import { runMonthEndSweep, SWEEP_HOUR_UTC } from "../../src/lib/month-end-sweep.js";
import {
  flagUncollectableDebt,
  runUnpaidDebtScan,
  UNPAID_DEBT_CARD_REQUIRED_EVENT,
  UNPAID_DEBT_STAFF_EVENT,
} from "../../src/lib/unpaid-debt.js";

const app = createTestApp();
const orgId = "00000000-0000-0000-0000-0000000000e1";
const billingEmail = "founder@acme.test";
const LAST_DAY = new Date(Date.UTC(2026, 0, 31, SWEEP_HOUR_UTC, 0, 0));

function eventsSent(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((c) => (c[0] as { eventType: string }).eventType);
}

describe("unpaid debt (negative balance, no chargeable card)", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let sendEmail: ReturnType<typeof vi.fn>;
  let usageCents: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail(billingEmail));
    await cleanTestData();

    usageCents = "0.0000000000";
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockImplementation(
      async (org: string) => ({
        org_id: org,
        spent_cents: usageCents,
        as_of: "2026-01-31T00:00:00.000Z",
      })
    );
    // Every send hangs off a REAL platform run — a minted uuid is silently
    // dropped by transactional-email-service (see CLAUDE.md).
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(
      "99999999-9999-4999-8999-999999999999"
    );
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined);
    sendEmail = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendEmail);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  /** −$50 with no card the acquirer will charge. */
  function owingFiftyWithNoCard() {
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
    usageCents = "6000.0000000000";
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
  }

  it("AC4: the month-end sweep flags the debt instead of counting it `skipped`", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 5000,
      topupThresholdCents: 5000,
    });
    owingFiftyWithNoCard();

    const result = await runMonthEndSweep(LAST_DAY);

    expect(result.eligible).toBe(1);
    expect(result.unpaidDebt).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.charged).toBe(0);

    const [episode] = await listEpisodes(orgId);
    expect(episode).toBeDefined();
    expect(episode.cardRequiredNotifiedAt).not.toBeNull();
    expect(episode.uncollectableDebtCents).toBe("5000.0000000000");

    // The customer is told a card is required, with the amount; staff are told
    // there is money we cannot collect.
    expect(eventsSent(sendEmail).sort()).toEqual(
      [UNPAID_DEBT_CARD_REQUIRED_EVENT, UNPAID_DEBT_STAFF_EVENT].sort()
    );
    const customerSend = sendEmail.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === UNPAID_DEBT_CARD_REQUIRED_EVENT
    )![0] as { recipientEmail?: string; metadata: Record<string, string> };
    expect(customerSend.recipientEmail).toBe(billingEmail);
    expect(customerSend.metadata.amountOwed).toBe("$50.00");
  });

  it("AC4b: a second tick refreshes the amount and re-emails NOBODY", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 5000,
      topupThresholdCents: 5000,
    });
    owingFiftyWithNoCard();

    await runMonthEndSweep(LAST_DAY);
    sendEmail.mockClear();

    // The debt grew between ticks: the amount tracks it, the notification does not repeat.
    usageCents = "7000.0000000000";
    const second = await runMonthEndSweep(LAST_DAY);

    expect(second.unpaidDebt).toBe(1);
    expect(second.skipped).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    const [episode] = await listEpisodes(orgId);
    expect(episode.uncollectableDebtCents).toBe("6000.0000000000");
  });

  it("an org that owes NOTHING and has no card is still an ordinary skip", async () => {
    await insertTestAccount({
      orgId,
      topupAmountCents: 5000,
      topupThresholdCents: 5000,
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);

    const result = await runMonthEndSweep(LAST_DAY);

    expect(result.skipped).toBe(1);
    expect(result.unpaidDebt).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await listEpisodes(orgId)).toHaveLength(0);
  });

  it("a debt on an off_session-blocked card is counted, not skipped, and not re-notified here", async () => {
    // The existing `-blocked` dunning copy already nudges these customers to
    // recharge manually — a second mechanism must not mail them again.
    await insertTestAccount({
      orgId,
      topupAmountCents: 5000,
      topupThresholdCents: 5000,
    });
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("1000.0000000000");
    usageCents = "6000.0000000000";
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("IN");

    const result = await runMonthEndSweep(LAST_DAY);

    expect(result.blockedCountryDebt).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.unpaidDebt).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("POST /internal/payment-methods/lost flags the debt the moment the card goes", async () => {
    await insertTestAccount({ orgId });
    owingFiftyWithNoCard();

    const res = await request(app)
      .post("/internal/payment-methods/lost")
      .set(getAuthHeaders(orgId))
      .send({ orgId });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("flagged");
    expect(res.body.owed_cents).toBe("5000.0000000000");
    expect(eventsSent(sendEmail)).toHaveLength(2);

    // Redelivered webhook: same state re-read, nothing sent.
    sendEmail.mockClear();
    const again = await request(app)
      .post("/internal/payment-methods/lost")
      .set(getAuthHeaders(orgId))
      .send({ orgId });
    expect(again.body.state).toBe("already_flagged");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("POST /internal/payment-methods/lost is a no-op for an org that owes nothing", async () => {
    await insertTestAccount({ orgId });
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);

    const res = await request(app)
      .post("/internal/payment-methods/lost")
      .set(getAuthHeaders(orgId))
      .send({ orgId });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("no_debt");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await listEpisodes(orgId)).toHaveLength(0);
  });

  it("rejects a non-UUID orgId rather than guessing", async () => {
    const res = await request(app)
      .post("/internal/payment-methods/lost")
      .set(getAuthHeaders(orgId))
      .send({ orgId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("GET /internal/unpaid-debts is the staff surface, and an org leaves it when a card returns", async () => {
    await insertTestAccount({ orgId });
    owingFiftyWithNoCard();
    await flagUncollectableDebt({ orgId });

    const listed = await request(app)
      .get("/internal/unpaid-debts")
      .set(getAuthHeaders(orgId));
    expect(listed.status).toBe(200);
    expect(listed.body.unpaid_debts).toHaveLength(1);
    expect(listed.body.unpaid_debts[0].org_id).toBe(orgId);
    expect(listed.body.unpaid_debts[0].owed_cents).toBe("5000.0000000000");

    // AC: adding a card back makes the debt collectable again. The EPISODE stays
    // open (recovery is still keyed on credited rising, the existing path) but
    // the uncollectable flag goes, so staff stop seeing it and a LATER card loss
    // notifies afresh.
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    const outcome = await flagUncollectableDebt({ orgId });
    expect(outcome.state).toBe("collectable");

    const after = await request(app)
      .get("/internal/unpaid-debts")
      .set(getAuthHeaders(orgId));
    expect(after.body.unpaid_debts).toHaveLength(0);
    const [episode] = await listEpisodes(orgId);
    expect(episode.recoveredAt).toBeNull();
    expect(episode.cardRequiredNotifiedAt).toBeNull();

    // Losing the card again tells the customer again — one notification per loss.
    sendEmail.mockClear();
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(false);
    const relost = await flagUncollectableDebt({ orgId });
    expect(relost.state).toBe("flagged");
    expect(eventsSent(sendEmail)).toHaveLength(2);
  });

  it("the hourly scan catches an org that lost its card with nobody calling us", async () => {
    await insertTestAccount({ orgId });
    owingFiftyWithNoCard();

    const result = await runUnpaidDebtScan();

    expect(result.scanned).toBe(1);
    expect(result.flagged).toBe(1);
    const [episode] = await listEpisodes(orgId);
    expect(episode.cardRequiredNotifiedAt).not.toBeNull();
  });

  it("a platform run we cannot open DEFERS the notification rather than burning it", async () => {
    await insertTestAccount({ orgId });
    owingFiftyWithNoCard();
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(null);

    const outcome = await flagUncollectableDebt({ orgId });

    expect(outcome.state).toBe("deferred");
    expect(sendEmail).not.toHaveBeenCalled();
    const [episode] = await listEpisodes(orgId);
    expect(episode.cardRequiredNotifiedAt).toBeNull();
  });
});
