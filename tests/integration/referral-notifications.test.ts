/**
 * Telling the REFERRER about a referral, exactly once, without ever touching the
 * money. The referred org is never told it gets anything: it gets nothing.
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
  settleReferralsEarnedBy,
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

  type Sent = { eventType: string; orgId: string; runId: string; metadata: Record<string, string> };
  const sent = (): Sent[] => sendMock.mock.calls.map((c) => c[0] as Sent);

  it("tells the referrer at signup: $500 once the new org has paid $500", async () => {
    await newSignup(inviter);
    await newSignup(invitee);

    await claimReferral(invitee, inviter);

    const opened = sent().filter((p) => p.eventType === REFERRAL_REWARD_OPENED_EVENT);
    expect(opened).toHaveLength(1);
    expect(opened[0].orgId).toBe(inviter);
    expect(opened[0].metadata).toEqual({
      amount: "$500",
      unlockAt: "$500",
      referredOrg: "Acme",
    });
  });

  it("tells the referrer when the credits land, naming who paid; nothing to the referee", async () => {
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    await settleReferralsEarnedBy(invitee, cents(500));

    const granted = sent().filter((p) => p.eventType === REFERRAL_CREDITS_GRANTED_EVENT);
    expect(granted).toHaveLength(1);
    expect(granted[0].orgId).toBe(inviter);
    expect(granted[0].metadata.amount).toBe("$500");
    expect(granted[0].metadata.reason).toBe(
      "This is your referral reward: Acme joined through your invite link and has now paid us."
    );
    expect(sent().some((p) => p.orgId === invitee)).toBe(false);
  });

  it("sends ONLY the granted message when the referee already paid the bar at claim", async () => {
    vi.spyOn(stripeClient, "sumSucceededTopupsForOrg").mockResolvedValue(cents(500) as never);

    await claimReferral(invitee, inviter);
    expect(sent()).toHaveLength(0);

    await settleReferralsEarnedBy(invitee, cents(500));
    expect(sent().map((p) => p.eventType)).toEqual([REFERRAL_CREDITS_GRANTED_EVENT]);
  });

  it("sends once, however many times the sweep re-examines the promise", async () => {
    await claimReferral(invitee, inviter);
    await claimReferral(invitee, inviter);
    await settleReferralsEarnedBy(invitee, cents(500));
    const afterFirst = sent().length;

    await settleReferralsEarnedBy(invitee, cents(500));
    await settleReferralsEarnedBy(invitee, cents(900));

    expect(afterFirst).toBe(2);
    expect(sent()).toHaveLength(afterFirst);
  });

  it("stamps its own marker, so granting and telling stay separate questions", async () => {
    await claimReferral(invitee, inviter);

    const [referral] = await db
      .select()
      .from(freeCreditPromises)
      .where(eq(freeCreditPromises.orgId, inviter));
    expect(referral.openedNotifiedAt).not.toBeNull();
    expect(referral.grantedAt).toBeNull();
    expect(referral.grantedNotifiedAt).toBeNull();
  });

  it("skips the send, and does NOT burn the marker, when no recipient resolves", async () => {
    vi.spyOn(stripeClient, "fetchOrgCustomer").mockRejectedValue(new Error("no customer") as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await claimReferral(invitee, inviter);

    expect(sendMock).not.toHaveBeenCalled();
    const [referral] = await db
      .select()
      .from(freeCreditPromises)
      .where(eq(freeCreditPromises.orgId, inviter));
    expect(referral.openedNotifiedAt).toBeNull();
  });

  it("commits the claim and the grant even when the notification throws", async () => {
    vi.spyOn(emailClient, "sendEmail").mockImplementation(() => {
      throw new Error("email service exploded");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const claim = await claimReferral(invitee, inviter);
    const result = await settleReferralsEarnedBy(invitee, cents(500));

    expect(claim.promise.orgId).toBe(inviter);
    expect(result.granted).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("hangs every send off a real platform run, and closes it", async () => {
    await claimReferral(invitee, inviter);
    await settleReferralsEarnedBy(invitee, cents(500));

    expect(sent().length).toBeGreaterThan(0);
    for (const p of sent()) expect(p.runId).toBe("dddddddd-1111-4ddd-8ddd-111111111111");
    expect(runsClient.completePlatformRun).toHaveBeenCalled();
  });

  it("skips the send, and does NOT burn the marker, when no run can be opened", async () => {
    vi.spyOn(runsClient, "createPlatformRun").mockResolvedValue(null as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await claimReferral(invitee, inviter);

    expect(sendMock).not.toHaveBeenCalled();
    const [referral] = await db
      .select()
      .from(freeCreditPromises)
      .where(eq(freeCreditPromises.orgId, inviter));
    expect(referral.openedNotifiedAt).toBeNull();
  });

  it("still sends when the referred org cannot be named", async () => {
    vi.spyOn(brandClient, "resolveOrgDisplayIdentity").mockResolvedValue(null as never);

    await claimReferral(invitee, inviter);

    const opened = sent().find((p) => p.eventType === REFERRAL_REWARD_OPENED_EVENT)!;
    expect(opened.metadata.referredOrg).toBe("a new customer");
  });
});
