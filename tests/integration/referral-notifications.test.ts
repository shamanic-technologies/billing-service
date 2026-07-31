/**
 * Telling the two sides of a referral, exactly once, without ever touching the
 * money.
 *
 * The money side is covered by referral-promises.test.ts. These cases pin the
 * two guarantees that are easy to break and expensive when broken: the hourly
 * sweep re-examines every promise on every tick, so a missing marker means a
 * customer is mailed about the same event forever; and a notification that can
 * throw is a notification that can roll back a grant.
 *
 * Own file rather than a describe appended to the referral suite: that one closes
 * the shared postgres.js connection in afterAll (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestPromoGrant,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as emailClient from "../../src/lib/email-client.js";
import * as brandClient from "../../src/lib/brand-service-client.js";
import * as stripeClient from "../../src/lib/stripe-service-client.js";
import { db } from "../../src/db/index.js";
import { freeCreditPromises } from "../../src/db/schema.js";
import {
  claimReferral,
  settleReferralPromises,
} from "../../src/lib/free-credit-promises.js";
import {
  REFERRAL_REWARD_OPENED_EVENT,
  REFERRAL_CREDITS_GRANTED_EVENT,
} from "../../src/lib/referral-notifications.js";

const userId = "11111111-1111-4111-8111-111111111111";
const inviter = "aaaaaaaa-1111-4aaa-8aaa-111111111111";
const invitee = "bbbbbbbb-1111-4bbb-8bbb-111111111111";

function cents(n: number): string {
  return (n * 100).toFixed(10);
}

async function newSignup(orgId: string) {
  await insertTestAccount({
    orgId,
    welcomeCompletionEligible: true,
    freeCreditEntitlementCents: 40000,
    freeCreditPaidTriggerCents: 40000,
  });
  await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
}

function eventsSent(sendMock: ReturnType<typeof vi.fn>): string[] {
  return sendMock.mock.calls.map((c) => (c[0] as { eventType: string }).eventType);
}

describe("referral notifications", () => {
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      totalCostInUsdCents: "0",
    } as never);
    // Every send hangs off a REAL run: the email service creates its own run as a
    // child of x-run-id, so runs-service rejects a parent that does not exist.
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(
      "dddddddd-1111-4ddd-8ddd-111111111111" as never
    );
    vi.spyOn(runsClient, "completePlatformRun").mockResolvedValue(
      undefined as never
    );
    vi.spyOn(brandClient, "resolveOrgDisplayIdentity").mockResolvedValue({
      brandId: "cccccccc-1111-4ccc-8ccc-111111111111",
      name: "Acme",
      domain: "acme.com",
    } as never);
    // Every org in these cases has a billing customer; the recipient is its email.
    vi.spyOn(stripeClient, "fetchOrgCustomer").mockImplementation(
      (async (orgId: string) => ({ id: `cus_${orgId.slice(0, 8)}`, email: `${orgId.slice(0, 8)}@test.dev` })) as never,
    );
    sendMock = vi.fn();
    vi.spyOn(emailClient, "sendEmail").mockImplementation(sendMock as never);
  });

  afterAll(closeDb);

  it("tells the referrer when someone they invited converts", async () => {
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    // The invitee crosses its own $900 bar: its referral lands, and that is what
    // opens the inviter's.
    await settleReferralPromises(invitee, cents(900));

    expect(eventsSent(sendMock)).toContain(REFERRAL_REWARD_OPENED_EVENT);
    const opened = sendMock.mock.calls
      .map((c) => c[0] as { eventType: string; orgId: string; metadata: Record<string, string> })
      .find((p) => p.eventType === REFERRAL_REWARD_OPENED_EVENT)!;
    // Addressed to the INVITER, about the org that converted.
    expect(opened.orgId).toBe(inviter);
    expect(opened.metadata.referredOrg).toBe("Acme");
    expect(opened.metadata.amount).toBe("$500");
    // The inviter's own bar stacks above their $400 welcome: $400 + $500.
    expect(opened.metadata.unlockAt).toBe("$900");
  });

  it("tells the invitee when their own referral credits land", async () => {
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    await settleReferralPromises(invitee, cents(900));

    const granted = sendMock.mock.calls
      .map(
        (c) => c[0] as { eventType: string; orgId: string; metadata: Record<string, string> }
      )
      .filter((p) => p.eventType === REFERRAL_CREDITS_GRANTED_EVENT);
    const toInvitee = granted.find((p) => p.orgId === invitee)!;
    expect(toInvitee).toBeDefined();
    expect(toInvitee.metadata.amount).toBe("$500");
    // The invitee earned it through their OWN signup, so the sentence explaining
    // why names nobody — there is no third party in their half of the chain.
    expect(toInvitee.metadata.reason).toBe(
      "These are the referral credits for joining through an invite link."
    );
  });

  it("names the converted referral in the message the INVITER gets when it lands", async () => {
    // The brief's rule: when a reward exists because a specific referral
    // converted, say who. It matters most here, because a referrer already past
    // their bar never receives the opened message at all.
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    await settleReferralPromises(invitee, cents(900));

    // Now the inviter's own payments cross their $900 bar.
    await settleReferralPromises(inviter, cents(900));

    const toInviter = sendMock.mock.calls
      .map(
        (c) => c[0] as { eventType: string; orgId: string; metadata: Record<string, string> }
      )
      .find((p) => p.eventType === REFERRAL_CREDITS_GRANTED_EVENT && p.orgId === inviter)!;
    expect(toInviter).toBeDefined();
    expect(toInviter.metadata.reason).toBe(
      "This is your referral reward for Acme joining through your invite link."
    );
  });

  it("sends ONLY the granted message when the reward is already earned as it opens", async () => {
    // A referrer whose own payments are already past the new bar earns the reward
    // on the very next settle. "$500 is on its way" then "$500 arrived" minutes
    // later teaches nothing with the second, so the opened one is dropped.
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    // The inviter has long since paid past their own $900 bar.
    vi.spyOn(stripeClient, "sumSucceededTopupsForOrg").mockResolvedValue(
      cents(5000) as never
    );

    await settleReferralPromises(invitee, cents(900));
    expect(eventsSent(sendMock)).not.toContain(REFERRAL_REWARD_OPENED_EVENT);

    await settleReferralPromises(inviter, cents(5000));
    const toInviter = eventsSent(sendMock).filter(
      (e) => e === REFERRAL_CREDITS_GRANTED_EVENT
    );
    // One to the invitee, one to the inviter. No opened message anywhere.
    expect(toInviter).toHaveLength(2);
    expect(eventsSent(sendMock)).not.toContain(REFERRAL_REWARD_OPENED_EVENT);
  });

  it("does NOT mail anyone when a promise is merely created at signup", async () => {
    // Nothing has been earned, and the invitee is mid-onboarding being told the
    // same thing on screen.
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends once, however many times the sweep re-examines the promise", async () => {
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    await settleReferralPromises(invitee, cents(900));
    const afterFirst = eventsSent(sendMock).length;

    // The sweep runs hourly over the same rows, forever.
    await settleReferralPromises(invitee, cents(900));
    await settleReferralPromises(invitee, cents(900));

    expect(eventsSent(sendMock)).toHaveLength(afterFirst);
  });

  it("stamps its own marker, so granting and telling stay separate questions", async () => {
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    await settleReferralPromises(invitee, cents(900));

    const rows = await db
      .select()
      .from(freeCreditPromises)
      .where(eq(freeCreditPromises.orgId, inviter));
    const referral = rows.find((r) => r.referredOrgId === invitee)!;
    expect(referral.openedNotifiedAt).not.toBeNull();
    // Opened, not granted: the inviter has not paid anything yet.
    expect(referral.grantedAt).toBeNull();
    expect(referral.grantedNotifiedAt).toBeNull();
  });

  it("skips the send, and does NOT burn the marker, when no recipient resolves", async () => {
    // Claiming before resolving would lose the notification forever: the marker
    // would be stamped and no later sweep would ever retry it.
    vi.spyOn(stripeClient, "fetchOrgCustomer").mockRejectedValue(new Error("no customer") as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    await settleReferralPromises(invitee, cents(900));

    expect(sendMock).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(freeCreditPromises)
      .where(eq(freeCreditPromises.orgId, inviter));
    const referral = rows.find((r) => r.referredOrgId === invitee)!;
    expect(referral.openedNotifiedAt).toBeNull();
  });

  it("commits the grant even when the notification throws", async () => {
    // The money is the point and the mail is not. A send that blows up must
    // leave the credits exactly where they landed.
    vi.spyOn(emailClient, "sendEmail").mockImplementation(() => {
      throw new Error("email service exploded");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    const result = await settleReferralPromises(invitee, cents(900));

    expect(result.granted).toHaveLength(1);
    expect(result.inviterPromisesOpened).toBe(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("hangs every send off a real platform run, never a minted UUID", async () => {
    // transactional-email-service creates its send as a run CHILD of x-run-id, so
    // runs-service 400s on a parent that does not exist and the mail is dropped
    // with {sent:false} — silently, because the send is fire-and-forget. Verified
    // against prod: a random uuid gives sent:false, a real platform run sent:true.
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    await settleReferralPromises(invitee, cents(900));

    expect(runsClient.createPlatformRun).toHaveBeenCalled();
    for (const call of sendMock.mock.calls) {
      expect((call[0] as { runId: string }).runId).toBe(
        "dddddddd-1111-4ddd-8ddd-111111111111"
      );
    }
    // And the run it opened is closed again, so notifications do not pile up
    // `running` platform runs forever.
    expect(runsClient.completePlatformRun).toHaveBeenCalled();
  });

  it("skips the send, and does NOT burn the marker, when no run can be opened", async () => {
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(null as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    await settleReferralPromises(invitee, cents(900));

    expect(sendMock).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(freeCreditPromises)
      .where(eq(freeCreditPromises.orgId, inviter));
    const referral = rows.find((r) => r.referredOrgId === invitee)!;
    expect(referral.openedNotifiedAt).toBeNull();
  });

  it("still sends when the referred org cannot be named", async () => {
    // The identity lookup is fail-soft. A referrer whose invitee has no brand
    // should still be told they earned something.
    vi.spyOn(brandClient, "resolveOrgDisplayIdentity").mockResolvedValue(null as never);

    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    await settleReferralPromises(invitee, cents(900));

    const opened = sendMock.mock.calls
      .map((c) => c[0] as { eventType: string; metadata: Record<string, string | null> })
      .find((p) => p.eventType === REFERRAL_REWARD_OPENED_EVENT)!;
    expect(opened).toBeDefined();
    // A phrase that names nobody, never a UUID and never a blank hole mid-sentence.
    expect(opened.metadata.referredOrg).toBe("A new customer");
  });
});
