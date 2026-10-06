/**
 * The $500 referral reward — owned by the REFERRER, earned on the REFERRED org's
 * real payments (owner 2026-10-06: "Nag (Ascend) dont get any free credits. It is
 * Senthil who gets that money because of referral").
 *
 *   Senthil (inviter) refers Nag (invitee).
 *   Nag pays $200            → nothing for anyone.
 *   Nag pays $300 more ($500) → inviter +$500. Invitee gets nothing from it.
 *
 * Own file, not a `describe` appended to welcome-completion.test.ts: that suite
 * closes the shared postgres.js connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
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
  freeCreditPromises,
  localPromoCodes,
  localPromos,
  REFERRAL_REWARD_CODE,
  CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS,
} from "../../src/db/schema.js";
import {
  claimReferral,
  ReferralAlreadyClaimedError,
  ReferralRewardCodeMissingError,
  SelfReferralError,
  settleReferralsEarnedBy,
} from "../../src/lib/free-credit-promises.js";
import { settleFreeCreditPromises } from "../../src/lib/free-credit-settlement.js";
import { runWelcomeCompletionSweep } from "../../src/lib/welcome-completion-sweep.js";

const inviter = "00000000-0000-0000-0000-0000000005a1";
const invitee = "00000000-0000-0000-0000-0000000005a2";
const invitee2 = "00000000-0000-0000-0000-0000000005a3";
const otherInviter = "00000000-0000-0000-0000-0000000005a4";
const userId = "00000000-0000-0000-0000-0000000005a9";

const cents = (n: number) => `${n}.0000000000`;
const REWARD = CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS;

/** A signup holding the usual free credit (a $30 advance-like gift row). */
async function signup(orgId: string) {
  await insertTestAccount({ orgId });
  await insertTestPromoGrant({ orgId, userId, amountCents: 3000, promoCode: "welcome" });
}

async function referralGrants(orgId: string) {
  return db
    .select({ amountCents: localPromos.amountCents })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(and(eq(localPromos.orgId, orgId), eq(localPromoCodes.code, REFERRAL_REWARD_CODE)));
}

const settle = (orgId: string, paidCents: number) =>
  settleFreeCreditPromises(orgId, cents(paidCents));

describe("referral reward: the referrer earns it on the referee's payments", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  /** What each org has really paid, as stripe-service would answer. */
  let paid: Record<string, number>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    paid = {};
    ssMocks.sumSucceededTopupsForOrg.mockImplementation(async (orgId: string) =>
      cents(paid[orgId] ?? 0)
    );
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

  it("a claim opens ONE promise, held by the referrer, $500 at $500 of the referee's payments", async () => {
    await signup(inviter);
    await signup(invitee);

    const { promise, alreadyClaimed } = await claimReferral(invitee, inviter);

    expect(alreadyClaimed).toBe(false);
    expect(promise).toMatchObject({
      orgId: inviter,
      kind: "referral",
      amountCents: REWARD,
      paidTriggerCents: REWARD,
      referredOrgId: invitee,
      referrerOrgId: null,
      grantedAt: null,
    });
    // The referee holds no referral promise of its own.
    expect((await listPromises(invitee)).filter((p) => p.kind === "referral")).toEqual([]);
  });

  it("AC1: referee pays $500 cumulative → referrer granted $500 once; referee gets no referral credit", async () => {
    await signup(inviter);
    await signup(invitee);
    await claimReferral(invitee, inviter);

    // $200, then $300 more.
    await settle(invitee, 20000);
    expect(await referralGrants(inviter)).toHaveLength(0);

    const outcome = await settle(invitee, 50000);

    expect(await referralGrants(inviter)).toEqual([{ amountCents: cents(REWARD) }]);
    expect(await referralGrants(invitee)).toHaveLength(0);
    // Nothing lands on the referee's own credit from this settle.
    expect(outcome.grantedCents).toBe(cents(0));
    expect(outcome.referrals.granted.map((p) => p.orgId)).toEqual([inviter]);
  });

  it("the referrer's balance rises with NO payment of their own; the referee's does not", async () => {
    await signup(inviter);
    await signup(invitee);
    await claimReferral(invitee, inviter);
    paid[invitee] = 50000;

    // The referee's own account read is what settles it.
    const refereeRes = await request(app).get("/v1/accounts").set(getAuthHeaders(invitee));
    expect(refereeRes.status).toBe(200);
    expect(refereeRes.body.credited_gifted_cents).toBe(cents(3000));

    const inviterRes = await request(app).get("/v1/accounts").set(getAuthHeaders(inviter));
    expect(inviterRes.status).toBe(200);
    expect(inviterRes.body.credited_paid_cents).toBe(cents(0));
    expect(inviterRes.body.credited_gifted_cents).toBe(cents(3000 + REWARD));
  });

  it("AC2: referee pays $499 → nothing granted", async () => {
    await signup(inviter);
    await signup(invitee);
    await claimReferral(invitee, inviter);

    await settle(invitee, 49999);

    expect(await referralGrants(inviter)).toHaveLength(0);
    expect(await referralGrants(invitee)).toHaveLength(0);
  });

  it("AC2: the referee's free credit never counts toward the $500", async () => {
    await signup(inviter);
    await signup(invitee);
    // $600 of free credit on the referee, $0 paid.
    await insertTestPromoGrant({ orgId: invitee, userId, amountCents: 60000, promoCode: "invite_reward" });
    await claimReferral(invitee, inviter);

    await request(app).get("/v1/accounts").set(getAuthHeaders(invitee));
    await runWelcomeCompletionSweep();

    expect(await referralGrants(inviter)).toHaveLength(0);
  });

  it("the referrer's own payments never earn it", async () => {
    await signup(inviter);
    await signup(invitee);
    await claimReferral(invitee, inviter);
    paid[inviter] = 1_000_000;

    await settle(inviter, 1_000_000);
    await request(app).get("/v1/free-credit-promises").set(getAuthHeaders(inviter));

    expect(await referralGrants(inviter)).toHaveLength(0);
  });

  it("AC3: replayed settles grant once", async () => {
    await signup(inviter);
    await signup(invitee);
    await claimReferral(invitee, inviter);

    await settle(invitee, 50000);
    await settle(invitee, 50000);
    await settle(invitee, 90000);

    expect(await referralGrants(inviter)).toHaveLength(1);
  });

  it("AC3: concurrent settles (referee side AND referrer side) grant once", async () => {
    await signup(inviter);
    await signup(invitee);
    await claimReferral(invitee, inviter);
    paid[invitee] = 50000;

    const results = await Promise.all([
      settleReferralsEarnedBy(invitee, cents(50000)),
      settleReferralsEarnedBy(invitee, cents(50000)),
      settleReferralsEarnedBy(invitee, cents(50000)),
      request(app).get("/v1/free-credit-promises").set(getAuthHeaders(inviter)),
    ]);

    const grantedByEarned = results
      .slice(0, 3)
      .flatMap((r) => (r as { granted: unknown[] }).granted);
    expect(grantedByEarned.length).toBeLessThanOrEqual(1);
    expect(await referralGrants(inviter)).toHaveLength(1);
  });

  it("each referral is its own $500 at $500 — nothing stacks", async () => {
    await signup(inviter);
    await claimReferral(invitee, inviter);
    await claimReferral(invitee2, inviter);

    const rows = (await listPromises(inviter)).filter((p) => p.kind === "referral");
    expect(rows.map((r) => [r.amountCents, r.paidTriggerCents, r.referredOrgId]).sort()).toEqual(
      [
        [REWARD, REWARD, invitee],
        [REWARD, REWARD, invitee2],
      ].sort()
    );

    await settle(invitee, 50000);
    expect(await referralGrants(inviter)).toHaveLength(1);
    await settle(invitee2, 50000);
    expect(await referralGrants(inviter)).toHaveLength(2);
  });

  it("a re-claimed invite is a no-op; a DIFFERENT referrer is rejected", async () => {
    const first = await claimReferral(invitee, inviter);
    const again = await claimReferral(invitee, inviter);
    expect(again.alreadyClaimed).toBe(true);
    expect(again.promise.id).toBe(first.promise.id);

    await expect(claimReferral(invitee, otherInviter)).rejects.toThrow(
      ReferralAlreadyClaimedError
    );
    expect(await listPromises(otherInviter)).toHaveLength(0);
  });

  it("concurrent claims for the same referee open one promise", async () => {
    const outcomes = await Promise.all([
      claimReferral(invitee, inviter),
      claimReferral(invitee, inviter),
      claimReferral(invitee, inviter),
    ]);
    expect(new Set(outcomes.map((o) => o.promise.id)).size).toBe(1);
    expect(await listPromises(inviter)).toHaveLength(1);
  });

  it("an org cannot refer itself", async () => {
    await expect(claimReferral(invitee, invitee)).rejects.toThrow(SelfReferralError);
  });

  it("the sweep grants it for a referee with no request traffic at all", async () => {
    await signup(inviter);
    await signup(invitee);
    await claimReferral(invitee, inviter);
    paid[invitee] = 50000;

    await runWelcomeCompletionSweep();

    expect(await referralGrants(inviter)).toHaveLength(1);
  });

  it("the referrer's dashboard shows the pending $500 with the REFEREE's progress", async () => {
    await signup(inviter);
    await signup(invitee);
    await claimReferral(invitee, inviter);
    paid[invitee] = 20000;
    paid[inviter] = 7000;

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(inviter));

    expect(res.status).toBe(200);
    expect(res.body.paid_topups_cents).toBe(cents(7000));
    const referral = res.body.promises.find((p: { kind: string }) => p.kind === "referral");
    expect(referral).toMatchObject({
      amount_cents: cents(REWARD),
      paid_trigger_cents: cents(REWARD),
      paid_so_far_cents: cents(20000),
      remaining_to_unlock_cents: cents(30000),
      progress_pct: 40,
      referred_org_id: invitee,
    });
    expect(res.body.outstanding_total_cents).toBe(cents(REWARD));
  });

  it("the referrer's dashboard read lands an already-earned reward", async () => {
    await signup(inviter);
    await claimReferral(invitee, inviter);
    paid[invitee] = 50000;

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(inviter));

    expect(res.status).toBe(200);
    expect(res.body.promises.filter((p: { kind: string }) => p.kind === "referral")).toEqual([]);
    expect(await referralGrants(inviter)).toHaveLength(1);
  });

  it("the referee's dashboard lists no referral promise", async () => {
    await signup(invitee);
    await claimReferral(invitee, inviter);

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(invitee));

    expect(res.status).toBe(200);
    expect(res.body.promises.filter((p: { kind: string }) => p.kind === "referral")).toEqual([]);
  });

  it("re-pricing the offer leaves a promise already opened untouched", async () => {
    await claimReferral(invitee, inviter);
    await db
      .update(localPromoCodes)
      .set({ amountCents: 90000 })
      .where(eq(localPromoCodes.code, REFERRAL_REWARD_CODE));
    await claimReferral(invitee2, inviter);

    const byReferred = Object.fromEntries(
      (await listPromises(inviter)).map((p) => [p.referredOrgId, [p.amountCents, p.paidTriggerCents]])
    );
    expect(byReferred[invitee]).toEqual([REWARD, REWARD]);
    expect(byReferred[invitee2]).toEqual([90000, 90000]);
  });

  it("migration 0071 moves an invitee-held promise onto its referrer, idempotently", async () => {
    // The pre-0071 prod shape: AscendQE holds $500 @ $500 naming NOVEMIQ as referrer.
    await db.insert(freeCreditPromises).values({
      orgId: invitee,
      kind: "referral",
      amountCents: REWARD,
      paidTriggerCents: REWARD + 3000,
      referrerOrgId: inviter,
    });
    const fs = await import("node:fs");
    const sqlText = fs.readFileSync("drizzle/0071_referral_reward_to_referrer.sql", "utf8");
    await db.execute(sql.raw(sqlText));
    await db.execute(sql.raw(sqlText));

    expect(await listPromises(invitee)).toHaveLength(0);
    const [moved] = await listPromises(inviter);
    expect(moved).toMatchObject({
      orgId: inviter,
      referredOrgId: invitee,
      referrerOrgId: null,
      amountCents: REWARD,
      paidTriggerCents: REWARD,
      grantedAt: null,
    });

    await settle(invitee, 50000);
    expect(await referralGrants(inviter)).toHaveLength(1);
    expect(await referralGrants(invitee)).toHaveLength(0);
  });

  it("a claim fails loud when the referral ledger key is missing (500 on the route)", async () => {
    await removeReferralRewardCode();
    await expect(claimReferral(invitee, inviter)).rejects.toThrow(
      ReferralRewardCodeMissingError
    );
    const res = await request(app)
      .post("/internal/referrals/claim")
      .set(getAuthHeaders(invitee))
      .send({ orgId: invitee, referrerOrgId: inviter });
    expect(res.status).toBe(500);
  });

  it("the claim route returns the referrer's promise, 409 on a different referrer, 400 on a bad body", async () => {
    const first = await request(app)
      .post("/internal/referrals/claim")
      .set(getAuthHeaders(invitee))
      .send({ orgId: invitee, referrerOrgId: inviter });
    expect(first.status).toBe(200);
    expect(first.body.promise).toMatchObject({
      orgId: inviter,
      kind: "referral",
      amountCents: REWARD,
      paidTriggerCents: REWARD,
      referredOrgId: invitee,
      grantedAt: null,
    });

    const conflict = await request(app)
      .post("/internal/referrals/claim")
      .set(getAuthHeaders(invitee))
      .send({ orgId: invitee, referrerOrgId: otherInviter });
    expect(conflict.status).toBe(409);

    const bad = await request(app)
      .post("/internal/referrals/claim")
      .set(getAuthHeaders(invitee))
      .send({ orgId: "not-a-uuid", referrerOrgId: inviter });
    expect(bad.status).toBe(400);
  });
});
