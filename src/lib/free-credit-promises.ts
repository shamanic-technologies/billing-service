/**
 * Free-credit promises.
 *
 * ## What a promise is
 *
 * An amount of free credit an org will receive once some cumulative SUCCEEDED
 * payments (net of refunds and lost disputes) reach a bar. Both figures are FROZEN
 * when the promise is created and never move, so re-pricing an offer later reaches
 * only promises created after the re-price.
 *
 * Two kinds exist:
 *
 *   - `welcome`  — the signup offer. One per org, amount and bar copied from the
 *                  figures frozen on its billing account and earned on the org's OWN
 *                  payments. Granted by lib/welcome-completion.ts; this module only
 *                  materialises the row so the dashboard lists it.
 *   - `referral` — the invite offer ($500 today), held by the REFERRER and earned on
 *                  the REFERRED org's payments. See below.
 *
 * ## The referral rule (owner, 2026-10-06)
 *
 * "Nag (Ascend) dont get any free credits. It is Senthil who gets that money because
 * of referral" — and to the referrer: "the $500 are free credits on your account,
 * once I receive $500 in revenue from the referee".
 *
 *   Senthil (NOVEMIQ) refers Nag (AscendQE).
 *   Nag pays $200            → nothing for anyone.
 *   Nag pays $300 more ($500) → NOVEMIQ gets +$500 free credits. Senthil pays nothing.
 *   AscendQE gets nothing from the referral, ever (its own welcome / match offer is
 *   unrelated and unchanged).
 *
 * So:
 *
 *   - At invite claim (POST /internal/referrals/claim) ONE row is written, held by the
 *     REFERRER: `org_id` = referrer, `referred_org_id` = the new org, bar = the
 *     amount. The referred org holds NO referral promise and is never credited.
 *   - The bar is measured on the REFERRED org's cumulative real payments
 *     (`sumSucceededTopupsForOrg(referred)`): money Stripe says it received, net of
 *     refunds. Free credit the referee holds (welcome, trial seed, the onboarding
 *     advance, any grant) is a ledger row, never a payment, so it can never count.
 *   - Nothing stacks: every referral is its own $500 at $500 of that referee's
 *     payments, whatever else the referrer carries.
 *   - An org is referred ONCE: a partial unique index on `referred_org_id` (0071).
 *
 * The grant is decided when the REFERRED org settles (its account read, checkout,
 * the hourly sweep — `settleReferralsEarnedBy`), and also when the referrer reads its
 * promises (`settleReferralsHeldBy`), since both hold the figure that decides it.
 *
 * `referrer_org_id` is a legacy column: before 0071 the INVITEE held a promise
 * carrying it. Migration 0071 moved every ungranted one onto its referrer; nothing
 * writes it any more.
 *
 * ## Exactly-once
 *
 * Structural: the grant is a `local_promos` row on the referrer carrying
 * `idempotency_key = promise:<id>`, deduped by `idx_local_promos_org_idempotency`,
 * and the promise is stamped `granted_at` in the same transaction under
 * `granted_at IS NULL`. A replayed or concurrent settle grants once.
 *
 * ## Fail loud
 *
 * A missing `referral_reward` ledger key THROWS: prod HAS lost promo-code seeds
 * before (see CLAUDE.md), and silently skipping would leave a referrer short.
 */

import { and, asc, eq, isNotNull, isNull, sql as rawSql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import {
  billingAccounts,
  freeCreditPromises,
  localPromoCodes,
  localPromos,
  PROMISE_KIND_REFERRAL,
  PROMISE_KIND_WELCOME,
  REFERRAL_REWARD_CODE,
  type FreeCreditPromise,
} from "../db/schema.js";
import { addCents, gte, subCents } from "./cents.js";
import { sumEntitlementGrantsForOrg } from "./promos.js";
import { sumSucceededTopupsForOrg } from "./stripe-service-client.js";
import {
  resolveOrgDisplayIdentity,
  type OrgDisplayIdentity,
} from "./brand-service-client.js";
import {
  notifyReferralRewardOpened,
  notifyReferralCreditsGranted,
} from "./referral-notifications.js";

/** System sentinel — a promise grant has no human user (it is platform-issued). */
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

const ZERO = "0.0000000000";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toCents(amountCents: number): string {
  return new Decimal(amountCents).toFixed(10);
}

function dollars(cents: number | string): string {
  return new Decimal(cents).dividedBy(100).toFixed(2);
}

export class ReferralRewardCodeMissingError extends Error {
  constructor() {
    super(
      `referral ledger key missing: ${REFERRAL_REWARD_CODE} (run migration 0033)`
    );
  }
}

export class ReferralAlreadyClaimedError extends Error {
  constructor(
    readonly orgId: string,
    readonly existingReferrerOrgId: string
  ) {
    super(
      `org ${orgId} was already referred by ${existingReferrerOrgId} — an org is referred once`
    );
  }
}

export class SelfReferralError extends Error {
  constructor(orgId: string) {
    super(`org ${orgId} cannot refer itself`);
  }
}

/**
 * The `referral_reward` code row — both the ledger key a granted referral writes
 * under AND the live amount a NEW referral promise freezes. Throws when absent.
 */
async function requireReferralRewardCode(runner: Tx | typeof db = db) {
  const [row] = await runner
    .select()
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, REFERRAL_REWARD_CODE))
    .limit(1);
  if (!row) throw new ReferralRewardCodeMissingError();
  return row;
}

/** True when the referral ledger key exists (a referral grant is possible at all). */
export async function referralRewardCodeExists(): Promise<boolean> {
  const [row] = await db
    .select({ id: localPromoCodes.id })
    .from(localPromoCodes)
    .where(eq(localPromoCodes.code, REFERRAL_REWARD_CODE))
    .limit(1);
  return row !== undefined;
}

/**
 * Materialise this org's `welcome` promise if it is missing, copying the amount and
 * bar already FROZEN on its billing account — never recomputing them, so an existing
 * org's offer cannot move. Idempotent, and a no-op for an org with no account or one
 * excluded from the welcome completion (its welcome promise can never be granted, so
 * showing it as outstanding would be a lie).
 *
 * The welcome grant itself still runs through lib/welcome-completion.ts against the
 * account columns; this row exists so the welcome offer is one of the promises the
 * dashboard lists, and so a referral bar stacks above it.
 */
export async function ensureWelcomePromise(orgId: string): Promise<void> {
  const [account] = await db
    .select({
      eligible: billingAccounts.welcomeCompletionEligible,
      entitlementCents: billingAccounts.freeCreditEntitlementCents,
      paidTriggerCents: billingAccounts.freeCreditPaidTriggerCents,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!account || !account.eligible) return;

  await db
    .insert(freeCreditPromises)
    .values({
      orgId,
      kind: PROMISE_KIND_WELCOME,
      amountCents: account.entitlementCents,
      paidTriggerCents: account.paidTriggerCents,
    })
    .onConflictDoNothing();
}

/** Stamp the org's welcome promise as granted (called when the completion lands). */
export async function markWelcomePromiseGranted(
  orgId: string,
  localPromoId: string | null
): Promise<void> {
  await db
    .update(freeCreditPromises)
    .set({ grantedAt: new Date(), grantedLocalPromoId: localPromoId })
    .where(
      and(
        eq(freeCreditPromises.orgId, orgId),
        eq(freeCreditPromises.kind, PROMISE_KIND_WELCOME),
        isNull(freeCreditPromises.grantedAt)
      )
    );
}

export interface ReferralClaimResult {
  /** The REFERRER's promise this claim opened (or the one an earlier claim opened). */
  promise: FreeCreditPromise;
  alreadyClaimed: boolean;
}

/**
 * Record that `orgId` signed up through `referrerOrgId`'s invite link — what
 * client-service calls at invite claim.
 *
 * Opens ONE promise, held by the REFERRER: the live referral amount, earned once the
 * referred org has paid that same amount. The referred org gets nothing. Grants
 * nothing now.
 *
 * Re-claiming the SAME invite is a no-op that returns the existing promise. A claim
 * by a DIFFERENT referrer is rejected (an org is referred once).
 */
export async function claimReferral(
  orgId: string,
  referrerOrgId: string
): Promise<ReferralClaimResult> {
  if (orgId === referrerOrgId) throw new SelfReferralError(orgId);

  const code = await requireReferralRewardCode();

  const existing = await findReferralOf(orgId);
  if (existing) return sameReferrerOrThrow(existing, orgId, referrerOrgId);

  const inserted = await db
    .insert(freeCreditPromises)
    .values({
      orgId: referrerOrgId,
      kind: PROMISE_KIND_REFERRAL,
      amountCents: code.amountCents,
      paidTriggerCents: code.amountCents,
      referredOrgId: orgId,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    // The referrer cannot see this coming from anywhere else. Fail-soft inside.
    await notifyReferralRewardOpened(inserted[0]);
    return { promise: inserted[0], alreadyClaimed: false };
  }

  // Lost the race against a concurrent claim — re-read and apply the same rule.
  const raced = await findReferralOf(orgId);
  if (!raced) throw new Error(`referral claim for org ${orgId} vanished after conflict`);
  return sameReferrerOrThrow(raced, orgId, referrerOrgId);
}

function sameReferrerOrThrow(
  promise: FreeCreditPromise,
  orgId: string,
  referrerOrgId: string
): ReferralClaimResult {
  if (promise.orgId !== referrerOrgId) {
    throw new ReferralAlreadyClaimedError(orgId, promise.orgId);
  }
  return { promise, alreadyClaimed: true };
}

/** The referral promise naming this org as the referred one, if any. */
async function findReferralOf(orgId: string): Promise<FreeCreditPromise | null> {
  const [row] = await db
    .select()
    .from(freeCreditPromises)
    .where(
      and(
        eq(freeCreditPromises.kind, PROMISE_KIND_REFERRAL),
        eq(freeCreditPromises.referredOrgId, orgId)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Grant one referral promise to the org that HOLDS it (the referrer). Idempotent:
 * returns the stamped row only for the caller whose grant actually landed.
 */
async function grantReferralPromise(
  promise: FreeCreditPromise
): Promise<FreeCreditPromise | null> {
  const code = await requireReferralRewardCode();

  const landed = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(localPromos)
      .values({
        orgId: promise.orgId,
        userId: SYSTEM_USER_ID,
        amountCents: toCents(promise.amountCents),
        promoCodeId: code.id,
        description: `Referral reward: $${dollars(promise.amountCents)} (referred org paid $${dollars(promise.paidTriggerCents)})`,
        // Stacking key: a referrer legitimately holds several referral grants, so
        // these rows dedup on the promise, not on (org, promo_code).
        idempotencyKey: `promise:${promise.id}`,
      })
      .onConflictDoNothing({
        target: [localPromos.orgId, localPromos.idempotencyKey],
        where: rawSql`idempotency_key IS NOT NULL`,
      })
      .returning();

    const [stamped] = await tx
      .update(freeCreditPromises)
      .set({
        grantedAt: new Date(),
        grantedLocalPromoId: inserted[0]?.id ?? promise.grantedLocalPromoId ?? null,
      })
      .where(
        and(eq(freeCreditPromises.id, promise.id), isNull(freeCreditPromises.grantedAt))
      )
      .returning();

    return inserted.length > 0 && stamped ? stamped : null;
  });

  if (landed) {
    // Strictly AFTER the transaction commits; fail-soft inside.
    await notifyReferralCreditsGranted(landed);
  }
  return landed;
}

export interface ReferralSettleResult {
  /**
   * Referral rewards granted by THIS call. They land on the REFERRER's account,
   * never on the org whose payments earned them.
   */
  granted: FreeCreditPromise[];
}

/**
 * The REFERRED org's payments moved: grant every referral reward they have now
 * earned for whoever referred them.
 *
 * `paidTopupsCents` is the REFERRED org's cumulative succeeded payments net of
 * returns — real money only, never a credit. Nothing a caller asserts can conjure a
 * grant: the figure is Stripe's record of money received.
 */
export async function settleReferralsEarnedBy(
  referredOrgId: string,
  paidTopupsCents: string
): Promise<ReferralSettleResult> {
  const outstanding = await db
    .select()
    .from(freeCreditPromises)
    .where(
      and(
        eq(freeCreditPromises.kind, PROMISE_KIND_REFERRAL),
        eq(freeCreditPromises.referredOrgId, referredOrgId),
        isNull(freeCreditPromises.grantedAt)
      )
    );

  const granted: FreeCreditPromise[] = [];
  for (const promise of outstanding) {
    if (!gte(paidTopupsCents, toCents(promise.paidTriggerCents))) continue;
    const landed = await grantReferralPromise(promise);
    if (landed) granted.push(landed);
  }
  return { granted };
}

/**
 * The REFERRER's view: every outstanding referral promise it holds, each with the
 * referred org's paid figure, granting the ones already earned. Reads one paid sum
 * per referred org (fail-loud: an unreadable figure is never read as zero).
 */
export async function settleReferralsHeldBy(
  referrerOrgId: string
): Promise<Map<string, string>> {
  const held = await db
    .select()
    .from(freeCreditPromises)
    .where(
      and(
        eq(freeCreditPromises.orgId, referrerOrgId),
        eq(freeCreditPromises.kind, PROMISE_KIND_REFERRAL),
        isNotNull(freeCreditPromises.referredOrgId),
        isNull(freeCreditPromises.grantedAt)
      )
    );

  const paidByReferred = new Map<string, string>();
  for (const promise of held) {
    const referred = promise.referredOrgId!;
    if (!paidByReferred.has(referred)) {
      paidByReferred.set(referred, await sumSucceededTopupsForOrg(referred));
    }
    if (gte(paidByReferred.get(referred)!, toCents(promise.paidTriggerCents))) {
      await grantReferralPromise(promise);
    }
  }
  return paidByReferred;
}

/**
 * Orgs the sweep must visit, each settled on its OWN payments:
 *   - anyone holding an outstanding welcome promise whose account is still eligible;
 *   - every REFERRED org behind an outstanding referral promise (its payments are
 *     what earn the referrer's reward).
 */
export async function listPromiseSweepCandidates(): Promise<string[]> {
  const rows = (await db.execute(rawSql`
    SELECT DISTINCT org_id FROM (
      SELECT p.org_id
        FROM free_credit_promises p
       WHERE p.granted_at IS NULL
         AND p.kind = 'welcome'
         AND EXISTS (
           SELECT 1 FROM billing_accounts a
            WHERE a.org_id = p.org_id AND a.welcome_completion_eligible
         )
      UNION ALL
      SELECT p.referred_org_id AS org_id
        FROM free_credit_promises p
       WHERE p.granted_at IS NULL
         AND p.kind = 'referral'
         AND p.referred_org_id IS NOT NULL
    ) c
  `)) as unknown as Array<{ org_id: string }>;
  return rows.map((r) => r.org_id);
}

export interface FreeCreditPromiseView {
  id: string;
  kind: string;
  /** What lands when it unlocks (canonical cents string). */
  amount_cents: string;
  /** Cumulative net payments that unlock it. */
  paid_trigger_cents: string;
  /** How far along, capped at the bar. */
  paid_so_far_cents: string;
  /** Bar minus progress; "0.…" once the bar is met but the grant has not landed yet. */
  remaining_to_unlock_cents: string;
  /** 0–100, integer. */
  progress_pct: number;
  /** The referred org whose conversion caused this promise; null otherwise. */
  referred_org_id: string | null;
  /**
   * Display name of that referred org, so an inviter holding three pending $500s
   * sees WHICH referral earned each one instead of three identical rows.
   *
   * Absent (undefined) on a promise with no referred org, and null whenever the
   * lookup resolved nothing real. Never fabricated from the UUID: a placeholder
   * name is worse than no name. See lib/brand-service-client.ts.
   */
  referred_org_name?: string | null;
  /** Domain of that org — what the dashboard turns into a logo. Same rules as above. */
  referred_org_domain?: string | null;
  /** The org that referred us, on our own referral promise; null otherwise. */
  referrer_org_id: string | null;
  created_at: string;
}

/**
 * Every promise this org is still waiting on, cheapest bar first, with progress
 * measured against the payments Stripe says it has actually made.
 *
 * The welcome promise is reported at what would ACTUALLY land — its frozen
 * entitlement MINUS the free credit the org has already been gifted (the $5 signup
 * gift, staff grants, redeemed codes) — because that is the number the customer will
 * see arrive. Referral grants are excluded from that subtraction: they are additional
 * money on top of the welcome offer, never a replacement for it. A welcome promise
 * with nothing left to give is not listed.
 */
export async function listOutstandingPromises(
  orgId: string,
  paidTopupsCents: string,
  paidByReferredOrg: Map<string, string> = new Map()
): Promise<FreeCreditPromiseView[]> {
  const rows = await db
    .select()
    .from(freeCreditPromises)
    .where(
      and(eq(freeCreditPromises.orgId, orgId), isNull(freeCreditPromises.grantedAt))
    )
    .orderBy(asc(freeCreditPromises.paidTriggerCents), asc(freeCreditPromises.createdAt));

  if (rows.length === 0) return [];

  const giftedCents = rows.some((r) => r.kind === PROMISE_KIND_WELCOME)
    ? await sumEntitlementGrantsForOrg(orgId)
    : ZERO;

  const out: FreeCreditPromiseView[] = [];
  for (const row of rows) {
    const amountCents =
      row.kind === PROMISE_KIND_WELCOME
        ? subCents(toCents(row.amountCents), giftedCents)
        : toCents(row.amountCents);
    if (new Decimal(amountCents).lessThanOrEqualTo(0)) continue;

    // A referral reward is earned on the REFERRED org's payments, never the
    // holder's own: progress is measured on the figure that actually decides it.
    let progressBasis = paidTopupsCents;
    if (row.kind === PROMISE_KIND_REFERRAL && row.referredOrgId) {
      const referredPaid = paidByReferredOrg.get(row.referredOrgId);
      if (referredPaid === undefined) {
        throw new Error(
          `listOutstandingPromises: no paid figure for referred org ${row.referredOrgId}`
        );
      }
      progressBasis = referredPaid;
    }
    const bar = new Decimal(row.paidTriggerCents);
    const paid = Decimal.min(new Decimal(progressBasis), bar);
    const progress = paid.isNegative() ? new Decimal(0) : paid;

    out.push({
      id: row.id,
      kind: row.kind,
      amount_cents: amountCents,
      paid_trigger_cents: toCents(row.paidTriggerCents),
      paid_so_far_cents: progress.toFixed(10),
      remaining_to_unlock_cents: bar.minus(progress).toFixed(10),
      progress_pct: bar.isZero()
        ? 100
        : Number(progress.dividedBy(bar).times(100).toFixed(0)),
      referred_org_id: row.referredOrgId,
      referrer_org_id: row.referrerOrgId,
      created_at: row.createdAt.toISOString(),
    });
  }
  return out;
}

/**
 * Attach a display identity to every promise that exists because a referral
 * converted, so the dashboard can render a name and a logo instead of a raw UUID.
 *
 * Only `referred_org_id` is resolved. The invitee's own `referrer_org_id` is
 * deliberately left bare: the invitee reached us THROUGH that org's invite link, so
 * they already know who it was, they hold exactly one referral promise (nothing to
 * disambiguate), and no consumer reads it. Revealing less is the default.
 *
 * One lookup per DISTINCT org, run in parallel. Never throws: a promise is the
 * money-bearing information and must be returned with its amounts intact even when
 * every identity lookup fails — an org that resolves to nothing simply carries no
 * name, which is the honest rendering.
 */
export async function attachReferredOrgIdentities(
  promises: FreeCreditPromiseView[]
): Promise<FreeCreditPromiseView[]> {
  const orgIds = [
    ...new Set(
      promises
        .map((p) => p.referred_org_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    ),
  ];
  if (orgIds.length === 0) return promises;

  const resolved = new Map<string, OrgDisplayIdentity | null>();
  await Promise.all(
    orgIds.map(async (id) => {
      resolved.set(id, await resolveOrgDisplayIdentity(id));
    })
  );

  return promises.map((p) => {
    if (!p.referred_org_id) return p;
    const identity = resolved.get(p.referred_org_id) ?? null;
    return {
      ...p,
      referred_org_name: identity?.name ?? null,
      referred_org_domain: identity?.domain ?? null,
    };
  });
}

/**
 * The TOTAL free credit this org is still waiting on, across every promise it
 * carries — the headline the dashboard sidebar states ("$X in free credits
 * coming").
 *
 * Computed from the SAME view rows the response returns, not from a second query:
 * the total and the rows underneath it can therefore never disagree about one
 * number, which is the whole reason the consumer is forbidden from summing money
 * in the browser. So it inherits every rule those rows already obey — the welcome
 * remainder net of what was already gifted, a promise worth nothing dropped, a
 * granted promise absent entirely.
 *
 * An org with no outstanding promises answers a canonical "0.0000000000", never
 * null and never an absent field: "nothing coming" is an unambiguous answer, and
 * a consumer rendering it has nothing to branch on.
 *
 * This is NOT money the org can spend. It never enters balance, credited or
 * spendable — a promise is deliberately not funds, and that separation is what
 * stops the billing page counting it twice.
 */
export function sumOutstandingPromiseAmounts(
  promises: FreeCreditPromiseView[]
): string {
  let total = ZERO;
  for (const promise of promises) total = addCents(total, promise.amount_cents);
  return total;
}
