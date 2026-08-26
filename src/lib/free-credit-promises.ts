/**
 * Free-credit promises — the stacked-offer engine.
 *
 * ## What a promise is
 *
 * An amount of free credit an org will receive once its cumulative SUCCEEDED
 * payments (net of refunds and lost disputes — the exact figure the welcome
 * completion already uses) reach a bar. Both figures are FROZEN when the promise is
 * created and never move, so re-pricing an offer later reaches only promises created
 * after the re-price: no cutoff date, no backfill, every existing customer
 * grandfathered by construction. Same discipline as the per-account offer (0032).
 *
 * An org may carry any number of promises at once. Today two kinds exist:
 *
 *   - `welcome`  — the signup offer ("$400 in free credits", $25 for the
 *                  grandfathered cohort). One per org, amount and bar copied from
 *                  the figures already frozen on its billing account. It is granted
 *                  by lib/welcome-completion.ts, whose arithmetic is unchanged; this
 *                  module only materialises the row so the welcome offer is ONE of
 *                  these promises rather than a special case, and so the referral
 *                  bar can stack above it.
 *   - `referral` — the invite offer ($500 today). No up-front portion: the whole
 *                  amount lands when its bar is crossed.
 *
 * ## The ladder
 *
 * The bar of a NEW promise is (the highest bar this org already carries) + (the new
 * promise's own amount) — whether or not that earlier promise has been earned,
 * because cumulative payments only ever go up so both readings give the same ladder:
 *
 *   brand-new $400 account          → $400 @ $400          (unchanged from today)
 *   ...then referred a $500 promise → $500 @ $900
 *   ...then a third $500 promise    → $500 @ $1,400        (and so on, no ceiling)
 *   grandfathered $25 account       → $25 @ $25, $500 @ $525
 *
 * ## The referral chain
 *
 * client-service tells billing "this org was referred by that org" at invite-claim
 * time (POST /internal/referrals/claim) and the invitee receives an outstanding
 * promise carrying `referrer_org_id`. When the INVITEE's promise is EARNED — by
 * their OWN payments — that same moment opens an identical promise for the INVITER,
 * whose bar stacks on the INVITER's own existing bars and which the inviter earns
 * only on their OWN payments. It is never granted for free, and it is never opened
 * by the invitee merely signing up. An inviter who refers ten converting customers
 * accumulates ten promises, each $500 above the last.
 *
 * ## Exactly-once
 *
 * Structural, no new bookkeeping:
 *   - the grant is a `local_promos` row carrying `idempotency_key = promise:<id>`,
 *     deduped by the partial unique index `idx_local_promos_org_idempotency`. It uses
 *     the stacking key (like admin_grant) rather than (org, promo_code) because an
 *     inviter legitimately holds several referral grants.
 *   - the inviter promise is deduped by the partial unique index on
 *     (org_id, referred_org_id), so a replayed or concurrent settle cannot open two.
 *   - a re-claimed invite hits the partial unique index on org_id where
 *     referrer_org_id IS NOT NULL and is a no-op.
 *
 * Crash safety: the grant + its stamp commit together, and the inviter promise is
 * opened in a SEPARATE transaction afterwards (never nested — two orgs referring each
 * other would otherwise deadlock on each other's account lock). If the process dies
 * between the two, `reconcileInviterPromises` re-opens it on the next settle, and the
 * sweep keeps such an org in its candidate set until it exists.
 *
 * ## Fail loud
 *
 * A missing `referral_reward` ledger key THROWS, exactly like the welcome-completion
 * seed: prod HAS lost promo-code seeds before (see CLAUDE.md), and silently skipping
 * would leave a customer short of credit they were promised.
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
 * The highest bar this org already carries, in whole cents.
 *
 * Reads the promises table AND the account's own frozen trigger, so it is correct
 * even for an org whose welcome promise row has not been materialised (an account
 * excluded from the welcome completion never gets one, yet it still carries that
 * bar). 0 when the org has neither.
 */
async function highestBarCents(runner: Tx | typeof db, orgId: string): Promise<number> {
  const rows = (await runner.execute(rawSql`
    SELECT GREATEST(
      COALESCE((SELECT MAX(paid_trigger_cents) FROM free_credit_promises WHERE org_id = ${orgId}), 0),
      COALESCE((SELECT free_credit_paid_trigger_cents FROM billing_accounts WHERE org_id = ${orgId}), 0)
    )::int AS bar
  `)) as unknown as Array<{ bar: number }>;
  return Number(rows[0]?.bar ?? 0);
}

/**
 * Insert a promise whose bar stacks on everything the org already carries.
 *
 * The caller's transaction takes a row lock on the org's billing account first, so
 * two promises opened for the same org concurrently cannot both read the same
 * highest bar and land on the same rung. The account row is created if absent (the
 * same ON CONFLICT DO NOTHING pre-create grantCredit does) so the lock always has
 * something to take and the org resolves to the current DB-default offer.
 */
async function insertStackedPromise(
  tx: Tx,
  params: {
    orgId: string;
    kind: string;
    amountCents: number;
    referrerOrgId?: string | null;
    referredOrgId?: string | null;
  }
): Promise<FreeCreditPromise | null> {
  await tx.insert(billingAccounts).values({ orgId: params.orgId }).onConflictDoNothing();
  await tx.execute(
    rawSql`SELECT 1 FROM billing_accounts WHERE org_id = ${params.orgId} FOR UPDATE`
  );

  const barCents = (await highestBarCents(tx, params.orgId)) + params.amountCents;

  const inserted = await tx
    .insert(freeCreditPromises)
    .values({
      orgId: params.orgId,
      kind: params.kind,
      amountCents: params.amountCents,
      paidTriggerCents: barCents,
      referrerOrgId: params.referrerOrgId ?? null,
      referredOrgId: params.referredOrgId ?? null,
    })
    .onConflictDoNothing()
    .returning();

  return inserted[0] ?? null;
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
  promise: FreeCreditPromise;
  alreadyClaimed: boolean;
}

/**
 * Open the INVITEE's referral promise — what client-service calls when someone signs
 * up through another org's invite link.
 *
 * Grants nothing: the referral offer has no up-front portion, the whole amount lands
 * when the bar is crossed. The bar stacks above whatever the invitee already carries
 * (its own welcome offer, normally), so a brand-new $400 account ends with $400 @
 * $400 and $500 @ $900.
 *
 * Re-claiming the SAME invite is a no-op that returns the existing promise. A claim
 * by a DIFFERENT inviter is rejected (an org is referred once) rather than silently
 * stacked — the caller sees the conflict instead of us guessing.
 */
export async function claimReferral(
  orgId: string,
  referrerOrgId: string
): Promise<ReferralClaimResult> {
  if (orgId === referrerOrgId) throw new SelfReferralError(orgId);

  const code = await requireReferralRewardCode();

  const existing = await findReferredPromise(orgId);
  if (existing) {
    if (existing.referrerOrgId !== referrerOrgId) {
      throw new ReferralAlreadyClaimedError(orgId, existing.referrerOrgId!);
    }
    return { promise: existing, alreadyClaimed: true };
  }

  // The invitee's own welcome promise must exist first, or the referral bar would
  // stack on nothing and land at $500 instead of $900.
  await db.insert(billingAccounts).values({ orgId }).onConflictDoNothing();
  await ensureWelcomePromise(orgId);

  const inserted = await db.transaction((tx) =>
    insertStackedPromise(tx, {
      orgId,
      kind: PROMISE_KIND_REFERRAL,
      amountCents: code.amountCents,
      referrerOrgId,
    })
  );

  if (inserted) return { promise: inserted, alreadyClaimed: false };

  // Lost the race against a concurrent claim — re-read and apply the same rule.
  const raced = await findReferredPromise(orgId);
  if (!raced) throw new Error(`referral claim for org ${orgId} vanished after conflict`);
  if (raced.referrerOrgId !== referrerOrgId) {
    throw new ReferralAlreadyClaimedError(orgId, raced.referrerOrgId!);
  }
  return { promise: raced, alreadyClaimed: true };
}

async function findReferredPromise(orgId: string): Promise<FreeCreditPromise | null> {
  const [row] = await db
    .select()
    .from(freeCreditPromises)
    .where(
      and(
        eq(freeCreditPromises.orgId, orgId),
        isNotNull(freeCreditPromises.referrerOrgId)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Open the INVITER's promise for one converted invitee, at the inviter's OWN next
 * bar. Idempotent on (inviter, invitee). Runs in its own transaction, never nested
 * inside the invitee's — A referring B while B refers A would otherwise deadlock.
 */
async function openInviterPromise(
  inviterOrgId: string,
  invitedOrgId: string,
  amountCents: number
): Promise<FreeCreditPromise | null> {
  // The inviter's own welcome promise must be materialised first, or their ladder
  // would read as if the referral were their only promise. It does not change the
  // bar (highestBarCents already reads the account's frozen trigger either way) —
  // it makes what the dashboard lists match what the org actually carries.
  await db.insert(billingAccounts).values({ orgId: inviterOrgId }).onConflictDoNothing();
  await ensureWelcomePromise(inviterOrgId);

  return db.transaction((tx) =>
    insertStackedPromise(tx, {
      orgId: inviterOrgId,
      kind: PROMISE_KIND_REFERRAL,
      amountCents,
      referredOrgId: invitedOrgId,
    })
  );
}

/**
 * Re-open any inviter promise that a granted referral should have produced but did
 * not — the crash-safety leg of "the grant commits, then the inviter promise opens".
 * Idempotent and cheap (both sides are indexed).
 */
export async function reconcileInviterPromises(orgId: string): Promise<number> {
  const granted = await db
    .select()
    .from(freeCreditPromises)
    .where(
      and(
        eq(freeCreditPromises.orgId, orgId),
        isNotNull(freeCreditPromises.referrerOrgId),
        isNotNull(freeCreditPromises.grantedAt)
      )
    );

  let opened = 0;
  for (const promise of granted) {
    const created = await openInviterPromise(
      promise.referrerOrgId!,
      orgId,
      promise.amountCents
    );
    if (created) {
      opened += 1;
      // The referrer cannot see this coming from anywhere else: it happened
      // because somebody ELSE paid. Awaited only so its marker claim settles
      // before the next pass could reach the same promise; the send itself is
      // fire-and-forget inside, and every failure path is swallowed and logged
      // so a mail can never disturb the grant that produced it.
      await notifyReferralRewardOpened(created);
    }
  }
  return opened;
}

export interface ReferralSettleResult {
  /** Total granted by THIS call (canonical cents string). */
  grantedCents: string;
  /** Promises granted by this call. */
  granted: FreeCreditPromise[];
  /** Inviter promises opened as a consequence. */
  inviterPromisesOpened: number;
}

/**
 * Grant every referral promise this org has now earned, cheapest bar first.
 *
 * Derived entirely from money Stripe says was received, so a request can only make
 * an already-earned grant land sooner — nothing a caller asserts can conjure one.
 * Idempotent: the grant row carries `promise:<id>` as its idempotency key, so a
 * replayed payment event or a concurrent settle grants once.
 */
export async function settleReferralPromises(
  orgId: string,
  paidTopupsCents: string
): Promise<ReferralSettleResult> {
  const outstanding = await db
    .select()
    .from(freeCreditPromises)
    .where(
      and(
        eq(freeCreditPromises.orgId, orgId),
        eq(freeCreditPromises.kind, PROMISE_KIND_REFERRAL),
        isNull(freeCreditPromises.grantedAt)
      )
    )
    .orderBy(asc(freeCreditPromises.paidTriggerCents));

  const earned = outstanding.filter((p) =>
    gte(paidTopupsCents, toCents(p.paidTriggerCents))
  );

  let grantedCents = ZERO;
  const granted: FreeCreditPromise[] = [];

  if (earned.length > 0) {
    const code = await requireReferralRewardCode();

    for (const promise of earned) {
      const landed = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(localPromos)
          .values({
            orgId,
            userId: SYSTEM_USER_ID,
            amountCents: toCents(promise.amountCents),
            promoCodeId: code.id,
            description: promise.referredOrgId
              ? `Referral reward: $${dollars(promise.amountCents)} (referred org converted)`
              : `Referral credits: $${dollars(promise.amountCents)}`,
            // Stacking key: an inviter legitimately holds several referral grants,
            // so these rows must be exempt from the (org, promo_code) uniqueness and
            // dedup on the promise instead.
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
            and(
              eq(freeCreditPromises.id, promise.id),
              isNull(freeCreditPromises.grantedAt)
            )
          )
          .returning();

        return { newGrant: inserted.length > 0, stamped: stamped ?? null };
      });

      if (landed.newGrant && landed.stamped) {
        grantedCents = new Decimal(grantedCents)
          .plus(promise.amountCents)
          .toFixed(10);
        granted.push(landed.stamped);
        // Strictly AFTER the transaction commits: the money is the point, and a
        // notification must never sit inside the transaction that moves it.
        await notifyReferralCreditsGranted(landed.stamped);
      }
    }
  }

  // Crash-safe leg: every GRANTED referral promise that carries a referrer must have
  // opened that inviter's promise. Idempotent, so it is also how the invite chain
  // continues on the normal path.
  const inviterPromisesOpened = await reconcileInviterPromises(orgId);

  return { grantedCents, granted, inviterPromisesOpened };
}

/**
 * Orgs the sweep must still visit:
 *   - anyone holding an outstanding promise (a welcome promise only counts while its
 *     account is still eligible — an excluded org's can never be granted), and
 *   - anyone whose granted referral has not yet opened its inviter's promise, so the
 *     chain completes even if a process died mid-way.
 */
export async function listPromiseSweepCandidates(): Promise<string[]> {
  const rows = (await db.execute(rawSql`
    SELECT DISTINCT org_id FROM (
      SELECT p.org_id
        FROM free_credit_promises p
       WHERE p.granted_at IS NULL
         AND (
           p.kind <> 'welcome'
           OR EXISTS (
             SELECT 1 FROM billing_accounts a
              WHERE a.org_id = p.org_id AND a.welcome_completion_eligible
           )
         )
      UNION ALL
      SELECT p.org_id
        FROM free_credit_promises p
       WHERE p.granted_at IS NOT NULL
         AND p.referrer_org_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM free_credit_promises i
            WHERE i.org_id = p.referrer_org_id AND i.referred_org_id = p.org_id
         )
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
  paidTopupsCents: string
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

    const bar = new Decimal(row.paidTriggerCents);
    const paid = Decimal.min(new Decimal(paidTopupsCents), bar);
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
