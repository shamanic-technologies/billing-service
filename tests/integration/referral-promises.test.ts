/**
 * Stacked free-credit promises — the referral offer.
 *
 * An org may carry several outstanding promises at once, each with its own frozen
 * amount and its own frozen bar, and some of them earned because somebody ELSE paid.
 * These cases pin the whole chain: claim → invitee's ladder → invitee earns → the
 * inviter's promise appears at the inviter's own next bar → the inviter earns it on
 * THEIR OWN payments, repeatedly and with no ceiling.
 *
 * Own file, not a `describe` appended to welcome-completion.test.ts: that suite
 * closes the shared postgres.js connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestPromoGrant,
  listPromises,
  removeReferralRewardCode,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";
import {
  localPromoCodes,
  localPromos,
  REFERRAL_REWARD_CODE,
  CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS,
  WELCOME_COMPLETION_CODE,
} from "../../src/db/schema.js";
import {
  claimReferral,
  ReferralAlreadyClaimedError,
  ReferralRewardCodeMissingError,
  SelfReferralError,
  settleReferralPromises,
} from "../../src/lib/free-credit-promises.js";
import { settleFreeCreditPromises } from "../../src/lib/free-credit-settlement.js";
import { runWelcomeCompletionSweep } from "../../src/lib/welcome-completion-sweep.js";

const inviter = "00000000-0000-0000-0000-0000000005a1";
const invitee = "00000000-0000-0000-0000-0000000005a2";
const invitee2 = "00000000-0000-0000-0000-0000000005a3";
const invitee3 = "00000000-0000-0000-0000-0000000005a4";
const userId = "00000000-0000-0000-0000-0000000005a9";

const cents = (n: number) => `${n}.0000000000`;
const NEVER_PRE_LAUNCH = () => Promise.resolve("0.0000000000");

/** A brand-new signup on the CURRENT $400 offer: inserted with org_id only. */
async function newSignup(orgId: string) {
  await insertTestAccount({
    orgId,
    welcomeCompletionEligible: true,
    freeCreditEntitlementCents: 40000,
    freeCreditPaidTriggerCents: 40000,
  });
  await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
}

async function grantRows(orgId: string, code: string) {
  return db
    .select({ amountCents: localPromos.amountCents })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(and(eq(localPromos.orgId, orgId), eq(localPromoCodes.code, code)));
}

/** The inviter's promises caused by one specific converted referral. */
async function inviterPromisesFor(referredOrgId: string) {
  return (await listPromises(inviter)).filter(
    (p) => p.referredOrgId === referredOrgId
  );
}

/** Just the (amount, bar) ladder, which is the whole product rule. */
async function ladder(orgId: string) {
  const rows = await listPromises(orgId);
  return rows.map((r) => [r.amountCents, r.paidTriggerCents]);
}

async function settle(orgId: string, paidCents: number) {
  return settleFreeCreditPromises(orgId, cents(paidCents), NEVER_PRE_LAUNCH);
}

describe("stacked free-credit promises (referral offer)", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // --- AC1: the ladder ---

  it("AC1: a referred new org carries two promises, $400 @ $400 and $500 @ $900", async () => {
    await newSignup(invitee);

    await claimReferral(invitee, inviter);

    expect(await ladder(invitee)).toEqual([
      [40000, 40000],
      [50000, 90000],
    ]);
  });

  it("nothing is granted beyond the $5 welcome until it pays", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    const outcome = await settle(invitee, 0);

    expect(outcome.grantedCents).toBe(cents(0));
    expect(await grantRows(invitee, WELCOME_COMPLETION_CODE)).toHaveLength(0);
    expect(await grantRows(invitee, REFERRAL_REWARD_CODE)).toHaveLength(0);
  });

  it("a third promise stacks to $1,400, with no ceiling", async () => {
    await newSignup(inviter);
    // Two referrals that already converted → two inviter promises.
    await claimReferral(invitee, inviter);
    await claimReferral(invitee2, inviter);
    await settle(invitee, 90000);
    await settle(invitee2, 90000);

    expect(await ladder(inviter)).toEqual([
      [40000, 40000],
      [50000, 90000],
      [50000, 140000],
    ]);

    await claimReferral(invitee3, inviter);
    await settle(invitee3, 90000);
    expect((await ladder(inviter))[3]).toEqual([50000, 190000]);
  });

  it("a grandfathered $25 org referred by someone gets $25 @ $25 and $500 @ $525", async () => {
    await insertTestAccount({ orgId: invitee, welcomeCompletionEligible: true });

    await claimReferral(invitee, inviter);

    expect(await ladder(invitee)).toEqual([
      [2500, 2500],
      [50000, 52500],
    ]);
  });

  // --- AC2: paying crosses the bars one at a time ---

  it("AC2: $400 grants the welcome remainder and nothing else; $900 grants the $500", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    const atTrigger = await settle(invitee, 40000);
    expect(atTrigger.welcome.granted).toBe(true);
    expect(atTrigger.welcome.amountCents).toBe(cents(39500)); // $400 − the $5 welcome
    expect(atTrigger.referrals.granted).toHaveLength(0);
    expect(await grantRows(invitee, REFERRAL_REWARD_CODE)).toHaveLength(0);
    // The inviter has nothing yet — the invitee has not earned its referral.
    expect(await ladder(inviter)).toEqual([]);

    const atReferralBar = await settle(invitee, 90000);
    expect(atReferralBar.referrals.granted).toHaveLength(1);
    expect((await grantRows(invitee, REFERRAL_REWARD_CODE))[0].amountCents).toBe(
      cents(50000)
    );
  });

  it("AC2: the inviter's $500 promise appears at that instant, at the inviter's own next bar", async () => {
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    await settle(invitee, 90000);

    // Inviter's own $400 welcome bar, then the referral $500 stacked above it.
    expect(await ladder(inviter)).toEqual([
      [40000, 40000],
      [50000, 90000],
    ]);
    const [, referral] = await listPromises(inviter);
    expect(referral.referredOrgId).toBe(invitee);
    expect(referral.grantedAt).toBeNull();
  });

  it("the welcome remainder is NOT swallowed by a referral grant that landed first", async () => {
    // A referred org that crosses both bars at once still gets BOTH: the referral is
    // additional money, never a replacement for the welcome offer.
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    const outcome = await settle(invitee, 90000);

    expect(outcome.welcome.granted).toBe(true);
    expect(outcome.referrals.granted).toHaveLength(1);
    // $5 welcome + $395 completion + $500 referral.
    expect(outcome.grantedCents).toBe(cents(89500));
  });

  // --- AC3: the inviter earns it on their OWN payments, never for free ---

  it("AC3: the inviter's $500 lands only once the INVITER's own payments cross the bar", async () => {
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    await settle(invitee, 90000);

    // Inviter has paid nothing: outstanding, not granted.
    await settle(inviter, 0);
    expect(await grantRows(inviter, REFERRAL_REWARD_CODE)).toHaveLength(0);

    // $899.99 is still short of the $900 bar.
    await settle(inviter, 89999);
    expect(await grantRows(inviter, REFERRAL_REWARD_CODE)).toHaveLength(0);

    await settle(inviter, 90000);
    expect((await grantRows(inviter, REFERRAL_REWARD_CODE))[0].amountCents).toBe(
      cents(50000)
    );
  });

  it("AC4: a second and third converting referral give successively higher bars", async () => {
    await newSignup(inviter);
    for (const org of [invitee, invitee2, invitee3]) {
      await newSignup(org);
      await claimReferral(org, inviter);
      await settle(org, 90000);
    }

    expect(await ladder(inviter)).toEqual([
      [40000, 40000],
      [50000, 90000],
      [50000, 140000],
      [50000, 190000],
    ]);

    // Crossing $1,400 earns exactly two of the three (the $1,900 rung is still out).
    await settle(inviter, 140000);
    expect(await grantRows(inviter, REFERRAL_REWARD_CODE)).toHaveLength(2);
  });

  // --- Exactly-once ---

  it("a re-claimed invite opens no second promise", async () => {
    await newSignup(invitee);

    const first = await claimReferral(invitee, inviter);
    const second = await claimReferral(invitee, inviter);

    expect(first.alreadyClaimed).toBe(false);
    expect(second.alreadyClaimed).toBe(true);
    expect(second.promise.id).toBe(first.promise.id);
    expect(await listPromises(invitee)).toHaveLength(2); // welcome + one referral
  });

  it("a claim by a DIFFERENT inviter is rejected, never silently stacked", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    await expect(claimReferral(invitee, invitee2)).rejects.toThrow(
      ReferralAlreadyClaimedError
    );
    expect(await listPromises(invitee)).toHaveLength(2);
  });

  it("an org cannot refer itself", async () => {
    await newSignup(invitee);
    await expect(claimReferral(invitee, invitee)).rejects.toThrow(SelfReferralError);
  });

  it("replaying the same payment grants a referral exactly once", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    await settle(invitee, 90000);
    await settle(invitee, 90000);
    await settle(invitee, 90000);

    expect(await grantRows(invitee, REFERRAL_REWARD_CODE)).toHaveLength(1);
    expect(await inviterPromisesFor(invitee)).toHaveLength(1);
  });

  it("concurrent settles grant a referral exactly once and open ONE inviter promise", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    const outcomes = await Promise.all([
      settleReferralPromises(invitee, cents(90000)),
      settleReferralPromises(invitee, cents(90000)),
      settleReferralPromises(invitee, cents(90000)),
    ]);

    expect(outcomes.flatMap((o) => o.granted)).toHaveLength(1);
    expect(await grantRows(invitee, REFERRAL_REWARD_CODE)).toHaveLength(1);
    expect(await inviterPromisesFor(invitee)).toHaveLength(1);
  });

  it("two converted referrals from the same inviter open two DISTINCT promises", async () => {
    await newSignup(inviter);
    await claimReferral(invitee, inviter);
    await claimReferral(invitee2, inviter);

    await settle(invitee, 90000);
    await settle(invitee2, 90000);

    const referred = (await listPromises(inviter))
      .filter((p) => p.referredOrgId)
      .map((p) => p.referredOrgId);
    expect(referred.sort()).toEqual([invitee, invitee2].sort());
  });

  // --- An outstanding promise is a promise, not money ---

  it("an outstanding promise is absent from credited, gifted and balance", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue(cents(1000));

    const res = await request(app).get("/v1/accounts").set(getAuthHeaders(invitee));

    expect(res.status).toBe(200);
    // $10 paid + the $5 welcome row. The $400 and $500 promises are nowhere.
    expect(res.body.credited_gifted_cents).toBe(cents(500));
    expect(res.body.credited_cents).toBe(cents(1500));
    expect(res.body.balance_cents).toBe(cents(1500));
  });

  // --- The dashboard read ---

  it("serves every outstanding promise with worth, bar, progress and the referred org", async () => {
    await newSignup(inviter);
    await claimReferral(invitee, inviter);
    await settle(invitee, 90000);
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue(cents(45000));

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(inviter));

    expect(res.status).toBe(200);
    expect(res.body.paid_topups_cents).toBe(cents(45000));
    // The $400 welcome promise was earned at $400 and granted by this very read, so
    // only the $500 referral is still outstanding.
    expect(res.body.promises).toHaveLength(1);
    const [promise] = res.body.promises;
    expect(promise.kind).toBe("referral");
    expect(promise.amount_cents).toBe(cents(50000));
    expect(promise.paid_trigger_cents).toBe(cents(90000));
    expect(promise.paid_so_far_cents).toBe(cents(45000));
    expect(promise.remaining_to_unlock_cents).toBe(cents(45000));
    expect(promise.progress_pct).toBe(50);
    // Which org caused it — the dashboard resolves the brand from this id.
    expect(promise.referred_org_id).toBe(invitee);
  });

  it("the welcome promise is reported at what would ACTUALLY land, net of the $5 already gifted", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue(cents(10000));

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(invitee));

    expect(res.body.promises.map((p: { amount_cents: string }) => p.amount_cents)).toEqual([
      cents(39500),
      cents(50000),
    ]);
    expect(res.body.promises[0].progress_pct).toBe(25);
  });

  // --- The headline total ---

  it("answers the TOTAL still outstanding, reconciling with the promise rows beside it", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue(cents(10000));

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(invitee));

    expect(res.status).toBe(200);
    // $395 welcome remainder + $500 referral: the sidebar headline.
    expect(res.body.outstanding_total_cents).toBe(cents(89500));
    // Same figure the rows add up to — the two can never disagree.
    const summed = res.body.promises.reduce(
      (acc: number, p: { amount_cents: string }) => acc + Number(p.amount_cents),
      0
    );
    expect(Number(res.body.outstanding_total_cents)).toBe(summed);
  });

  it("an org with nothing outstanding gets a canonical zero, not null and not an absent field", async () => {
    // Ineligible for the welcome completion and never referred: no promise at all.
    await insertTestAccount({ orgId: invitee });
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue(cents(10000));

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(invitee));

    expect(res.status).toBe(200);
    expect(res.body.promises).toEqual([]);
    expect(res.body.outstanding_total_cents).toBe(cents(0));
  });

  it("a promise the org has already earned leaves the total at zero once it lands", async () => {
    await newSignup(inviter);
    await claimReferral(invitee, inviter);
    await settle(invitee, 90000);
    // The inviter has paid past BOTH bars, so this read grants everything.
    ssMocks.sumSucceededTopupsForCustomer.mockResolvedValue(cents(200000));

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(inviter));

    expect(res.status).toBe(200);
    expect(res.body.promises).toEqual([]);
    expect(res.body.outstanding_total_cents).toBe(cents(0));
  });

  // --- The unconditional server-side driver ---

  it("the sweep settles a referral for an org with no request traffic at all", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(90000));

    const sweep = await runWelcomeCompletionSweep();

    expect(sweep.candidates).toBe(1);
    // Welcome completion + the referral.
    expect(sweep.granted).toBe(2);
    expect(await grantRows(invitee, REFERRAL_REWARD_CODE)).toHaveLength(1);
    // ...and the inviter's promise exists even though the inviter never called us.
    expect(await inviterPromisesFor(invitee)).toHaveLength(1);
  });

  it("the sweep re-opens an inviter promise that never got created", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    await settle(invitee, 90000);
    // Simulate a crash between the invitee's grant committing and the inviter's
    // promise being opened.
    await db.delete((await import("../../src/db/schema.js")).freeCreditPromises).where(
      eq((await import("../../src/db/schema.js")).freeCreditPromises.orgId, inviter)
    );
    expect(await listPromises(inviter)).toHaveLength(0);

    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(90000));
    await runWelcomeCompletionSweep();

    expect(await inviterPromisesFor(invitee)).toHaveLength(1);
  });

  // --- Fail loud ---

  it("a claim fails loud when the referral ledger key is missing", async () => {
    await newSignup(invitee);
    await removeReferralRewardCode();

    await expect(claimReferral(invitee, inviter)).rejects.toThrow(
      ReferralRewardCodeMissingError
    );
  });

  it("the claim endpoint surfaces the missing ledger key as a 500, and a bad body as a 400", async () => {
    await newSignup(invitee);
    await removeReferralRewardCode();

    const missing = await request(app)
      .post("/internal/referrals/claim")
      .set(getAuthHeaders(invitee))
      .send({ orgId: invitee, referrerOrgId: inviter });
    expect(missing.status).toBe(500);

    const bad = await request(app)
      .post("/internal/referrals/claim")
      .set(getAuthHeaders(invitee))
      .send({ orgId: "not-a-uuid", referrerOrgId: inviter });
    expect(bad.status).toBe(400);
  });

  it("the claim endpoint returns the frozen promise, and 409 on a different inviter", async () => {
    await newSignup(invitee);

    const first = await request(app)
      .post("/internal/referrals/claim")
      .set(getAuthHeaders(invitee))
      .send({ orgId: invitee, referrerOrgId: inviter });

    expect(first.status).toBe(200);
    expect(first.body.alreadyClaimed).toBe(false);
    expect(first.body.promise).toMatchObject({
      orgId: invitee,
      kind: "referral",
      amountCents: CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS,
      paidTriggerCents: 90000,
      referrerOrgId: inviter,
      referredOrgId: null,
      grantedAt: null,
    });

    const conflict = await request(app)
      .post("/internal/referrals/claim")
      .set(getAuthHeaders(invitee))
      .send({ orgId: invitee, referrerOrgId: invitee2 });
    expect(conflict.status).toBe(409);
  });

  // --- Freezing / grandfathering ---

  it("re-pricing the referral offer leaves promises already created untouched", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    // Re-price to $900 the way PATCH /internal/promo-codes/:code does.
    await db
      .update(localPromoCodes)
      .set({ amountCents: 90000 })
      .where(eq(localPromoCodes.code, REFERRAL_REWARD_CODE));

    await newSignup(invitee2);
    await claimReferral(invitee2, inviter);

    // The old promise keeps $500 @ $900; the new one freezes $900 @ $1,300.
    expect((await ladder(invitee))[1]).toEqual([50000, 90000]);
    expect((await ladder(invitee2))[1]).toEqual([90000, 130000]);
  });

  it("the INVITER's promise copies the invitee's frozen amount, not the current price", async () => {
    await newSignup(inviter);
    await newSignup(invitee);
    await claimReferral(invitee, inviter);

    await db
      .update(localPromoCodes)
      .set({ amountCents: 90000 })
      .where(eq(localPromoCodes.code, REFERRAL_REWARD_CODE));

    await settle(invitee, 90000);

    expect((await ladder(inviter))[1]).toEqual([50000, 90000]);
  });

  // --- An org that was never referred is unchanged ---

  it("an org that was never referred carries only its welcome promise and grants as before", async () => {
    await newSignup(invitee);

    const outcome = await settle(invitee, 40000);

    expect(await ladder(invitee)).toEqual([[40000, 40000]]);
    expect(outcome.welcome.amountCents).toBe(cents(39500));
    expect(outcome.referrals.granted).toHaveLength(0);
    expect(outcome.grantedCents).toBe(cents(39500));
  });
});
