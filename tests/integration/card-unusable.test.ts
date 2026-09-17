/**
 * A refusal the bank calls PERMANENT is not a cadence problem, so no interval
 * fixes it.
 *
 * Card-network rules split declines in two and only one half may be retried:
 * a temporary refusal (insufficient funds, a processing error, a plain "no")
 * is retryable within a cap, while lost / stolen / closed / authorization-
 * revoked may never be resubmitted at any interval. Our month-end sweep retries
 * forever by design and read no reason at all, so a stolen card was being
 * re-presented every month for the life of the account.
 *
 * Own file rather than a describe appended to the sweep suite: that one closes
 * the shared postgres.js connection in afterAll (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  cleanTestData,
  insertTestAccount,
  insertTestPromoGrant,
  closeDb,
} from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { _resetCoalescer } from "../../src/lib/reload-coalescer.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as emailClient from "../../src/lib/email-client.js";
import { db } from "../../src/db/index.js";
import { campaignReloadSweepAttempts } from "../../src/db/schema.js";
import { upsertCampaignAuthorizeCost } from "../../src/lib/campaign-costs.js";
import { runCampaignReloadSweep } from "../../src/lib/campaign-reload-sweep.js";
import {
  isPermanentDecline,
  CARD_UNUSABLE_EVENT,
} from "../../src/lib/card-usability.js";

const orgA = "00000000-0000-0000-0000-0000000000e1";
const campaignA = "00000000-0000-0000-0000-0000000000e2";
const userId = "11111111-1111-4111-8111-111111111111";
const billingEmail = "founder@acme.test";
const NOW = new Date(Date.UTC(2026, 8, 17, 7, 0, 0));

/** The prod-shaped trapped org: armed auto-topup, a card, inside the band. */
async function seedTrappedOrg(ss: ReturnType<typeof setupStripeMocks>) {
  await insertTestAccount({
    orgId: orgA,
    topupAmountCents: 4900,
    topupThresholdCents: 500,
  });
  await insertTestPromoGrant({
    orgId: orgA,
    userId,
    amountCents: 3000,
    promoCode: "welcome",
  });
  ss.sumSucceededTopupsForOrg.mockResolvedValue("19515.0000000000");
  await upsertCampaignAuthorizeCost(campaignA, orgA, "11.8000000000");
}

describe("a permanently refused card is never presented again", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail(billingEmail));
    await cleanTestData();
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgA,
      spent_cents: "27509.1310968628", // balance −4994.13 against a −5000 floor
      as_of: NOW.toISOString(),
    } as never);
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(
      "99999999-9999-4999-8999-999999999999" as never
    );
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(undefined as never);
    sendMock = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendMock as never);
    await seedTrappedOrg(ssMocks);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  async function row() {
    const [r] = await db
      .select()
      .from(campaignReloadSweepAttempts)
      .where(eq(campaignReloadSweepAttempts.orgId, orgA))
      .limit(1);
    return r;
  }

  it("classifies only the unambiguous codes, and an unknown one stays retryable", () => {
    for (const code of [
      "lost_card",
      "stolen_card",
      "pickup_card",
      "invalid_account",
      "revocation_of_authorization",
      "STOLEN_CARD", // the value crosses a service boundary as free text
      " stolen_card ",
    ]) {
      expect(isPermanentDecline(code)).toBe(true);
    }
    // Conservative in the direction that keeps collecting: an unknown or absent
    // code is retried, because abandoning a real debt is the worse error.
    for (const code of [
      "generic_decline", // what the prod incident actually returned
      "insufficient_funds",
      "processing_error",
      "try_again_later",
      "card_velocity_exceeded",
      "something_new_stripe_invented",
      "",
      null,
      undefined,
    ]) {
      expect(isPermanentDecline(code)).toBe(false);
    }
  });

  it("stops after ONE attempt and tells the customer to replace the card", async () => {
    ssMocks.reloadOffSession.mockResolvedValue({
      status: "failed",
      reference: "pi_dead",
      failure_reason: "card_declined: stolen_card",
      failure_code: "stolen_card",
    });

    const first = await runCampaignReloadSweep(NOW);
    expect(first.cardUnusable).toBe(1);
    expect(first.failed).toBe(1);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);

    // Not the "add a card" mail — the card IS on file, it is just dead, and a
    // customer looking at it in their settings would read that as wrong.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((sendMock.mock.calls[0]?.[0] as { eventType: string }).eventType).toBe(
      CARD_UNUSABLE_EVENT
    );

    const stored = await row();
    expect(stored?.cardUnusableAt).not.toBeNull();
    expect(stored?.lastDeclineCode).toBe("stolen_card");
  });

  it("is never presented again, at any interval, however long we wait", async () => {
    ssMocks.reloadOffSession.mockResolvedValue({
      status: "failed",
      failure_code: "lost_card",
      failure_reason: "card_declined: lost_card",
    });
    await runCampaignReloadSweep(NOW);

    // Every rung of the retry schedule. A permanent refusal outranks the
    // schedule entirely.
    for (const days of [1, 3, 7, 14, 20]) {
      _resetCoalescer();
      const later = await runCampaignReloadSweep(
        new Date(NOW.getTime() + days * 24 * 3600_000)
      );
      expect(later.cardUnusable).toBe(1);
      expect(later.awaitingRetry).toBe(0);
    }

    // And a year on the org has long since left the walk (its authorize row
    // stopped ageing the moment it wedged), so the card is not presented then
    // either — by a second mechanism, for a different reason.
    _resetCoalescer();
    const ayear = await runCampaignReloadSweep(
      new Date(NOW.getTime() + 365 * 24 * 3600_000)
    );
    expect(ayear.scanned).toBe(0);

    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying a TEMPORARY refusal on the schedule", async () => {
    // The code the production incident actually returned.
    ssMocks.reloadOffSession.mockRejectedValue(new Error("generic_decline"));

    const first = await runCampaignReloadSweep(NOW);
    expect(first.cardUnusable).toBe(0);
    expect(first.failed).toBe(1);

    _resetCoalescer();
    const nextRung = await runCampaignReloadSweep(
      new Date(NOW.getTime() + 24 * 3600_000)
    );
    expect(nextRung.cardUnusable).toBe(0);
    expect(nextRung.failed).toBe(1);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(2);
  });

  it("is released by money arriving, never by time passing", async () => {
    ssMocks.reloadOffSession.mockResolvedValue({
      status: "failed",
      failure_code: "stolen_card",
    });
    await runCampaignReloadSweep(NOW);
    expect((await row())?.cardUnusableAt).not.toBeNull();

    // The customer replaces the card and pays by hand, which moves credited.
    // $3.85, deliberately under the $200 tier breakpoint so the floor is
    // unchanged and the org is still in the band.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("19900.0000000000");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgA,
      spent_cents: "27894.1310968628",
      as_of: NOW.toISOString(),
    } as never);
    ssMocks.reloadOffSession.mockResolvedValue({ status: "succeeded" });
    _resetCoalescer();

    const after = await runCampaignReloadSweep(NOW);

    // Without this release the feature is a deadlock in miniature: nothing
    // would ever charge again, so nothing could succeed, so the mark could
    // never clear — the same shape as the pre-flight trap this all exists to
    // undo.
    expect(after.cardUnusable).toBe(0);
    expect(after.charged).toBe(1);
    expect((await row())?.cardUnusableAt).toBeNull();
    expect((await row())?.lastDeclineCode).toBeNull();
  });
});
