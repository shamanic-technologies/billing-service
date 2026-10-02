/**
 * When will we next take money from this customer, and if never, why not.
 *
 * Nothing here is a new rule. Every input already exists and is already the
 * source of truth for the thing it describes; this file puts them in one order
 * and states the consequence. The alternative — each consumer assembling the
 * five reads itself — is how two surfaces start giving one customer two
 * different answers.
 *
 * WHAT IT COMPOSES, and who owns each piece:
 *
 *  - the spendable balance and the postpaid credit-line floor: `lib/balance` +
 *    `lib/spend-block` (which is also the ONE predicate for "this org cannot
 *    spend", shared with the affordability pre-flight and the dunning tick);
 *  - the retry schedule for a refused card and the permanently-unusable verdict:
 *    `lib/campaign-reload-sweep` + `lib/card-usability`;
 *  - the month-end settle date: `lib/month-end-sweep`;
 *  - realized spend per day: `lib/realized-burn`, read from runs-service;
 *  - the configured ceilings: billing's own tables; the RUNNING split:
 *    campaign-service, fail-soft.
 *
 * THREE THINGS THE MEASUREMENT CHANGED, all of them against the obvious design.
 * Taken over the twelve orgs that spent anything in the fourteen days to
 * 2026-09-18:
 *
 *  1. HALF OF THEM CANNOT PAY AUTOMATICALLY AT ALL. Six of twelve carry no
 *     auto-topup, so they will not be charged — they will simply run out and
 *     stop. Handing those a date would be a fabrication, so `no_autopay` carries
 *     none. A forecast whose honest answer for half the population is "never"
 *     has to be able to say never.
 *  2. A DATE IS ABOUT A CHARGE ATTEMPT, NOT A PAYMENT. The two orgs already past
 *     their floor are exactly the two whose card the bank is refusing. billing
 *     can say when it will PRESENT the card; whether the bank says yes is not
 *     ours to predict, and conflating them would report a refusing customer as
 *     paying.
 *  3. THE BURN IS MEASURED, NEVER THE CEILING. Utilisation ran 4% to 146%, so
 *     the configured budget is not even an upper bound in practice. All three
 *     figures are served side by side; see `lib/realized-burn`.
 *
 * WHAT IT IS NOT. Not a table, not a snapshot, not a daily job. Twelve active
 * orgs is nothing to materialise, and a stored copy would be a second answer
 * that rots. Not a discount surface either: a floor and a ceiling are
 * configuration, and the per-org usage modifier applies to charges only.
 *
 * Fail-loud, with one documented exception: a campaign-service that cannot be
 * read yields `runningDailyBudgetCents: null` rather than the configured total
 * wearing a running label. Everything else propagates.
 */

import { Decimal } from "decimal.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, campaignReloadSweepAttempts } from "../db/schema.js";
import { computeBalance, computeSettleBalanceCents } from "./balance.js";
import { getBrandSalesBudget } from "./brand-sales-budget.js";
import { addCents, cmpCents, subCents } from "./cents.js";
import { resolveSpendBlock } from "./spend-block.js";
import { isPlatformOrg } from "./platform-org.js";
import { nextRetryDueAt } from "./campaign-reload-sweep.js";
import { computeSettleCharge, SWEEP_HOUR_UTC } from "./month-end-sweep.js";
import { fetchRealizedDailyBurn, type BurnUnavailableReason } from "./realized-burn.js";
import { fetchSpendableBudget } from "./campaign-service-client.js";
import { asPaymentMode, type PaymentMode } from "./payment-mode-types.js";
import {
  subscriptions,
  subscriptionCharges,
  type Subscription,
  type SubscriptionCharge,
} from "../db/schema.js";
import { subscriptionChargeDates } from "./subscription-schedule.js";

/** What billing expects to happen next, money-wise, for this org. */
export type PaymentOutlookState =
  /** A charge is expected, and `nextChargeAttemptAt` says when. */
  | "will_charge"
  /** Already past the point a charge fires; the next attempt is imminent. */
  | "charge_due_now"
  /** Something stops us charging. `blockedReason` says what. */
  | "charge_blocked"
  /** No auto-topup: this org will never be charged automatically. */
  | "no_autopay"
  /** Nothing is being spent, so nothing is coming due. */
  | "idle"
  /** Spend is happening but cannot be measured honestly — see `burn`. */
  | "unknown";

/** What stops the charge. Null unless the state is `charge_blocked`. */
export type PaymentBlockedReason =
  /** The bank refused, and the spaced retry schedule is still walking. */
  | "card_declined"
  /** The issuer called the card lost, stolen or closed — never re-present it. */
  | "card_unusable"
  /** Five refusals over a fortnight; the month-end settle still owns the debt. */
  | "retries_exhausted"
  /** No chargeable card on file. */
  | "no_chargeable_card"
  /** The card's issuing country cannot be charged off-session (e.g. India). */
  | "card_country_unsupported";

/** What brings the next charge about. Null when there is no date. */
export type PaymentChargeTrigger =
  /** Spend crosses the postpaid credit-line floor. */
  | "floor"
  /** The month-end sweep settles the balance to zero. */
  | "month_end"
  /** The next rung of the refused-card retry schedule. */
  | "retry_rung"
  /** A subscription's renewal (trial end, then monthly): billing charges the plan. */
  | "subscription_renewal";

export interface PaymentOutlook {
  orgId: string;
  /**
   * How this org pays (lib/payment-mode). A PREPAID org is never
   * `charge_blocked`: it spends only money already paid in, so a missing,
   * refused or unsupported card simply means no automatic charge (`no_autopay`)
   * and spend stops at zero through the affordability check.
   */
  paymentMode: PaymentMode;
  state: PaymentOutlookState;
  /**
   * When billing expects to PRESENT the card next (ISO 8601), or null when it
   * does not expect to. Never a payment date — see the note at the top.
   */
  nextChargeAttemptAt: string | null;
  /** What brings that date about. Null whenever the date is null. */
  trigger: PaymentChargeTrigger | null;
  /** Why no charge is possible. Null unless the state is `charge_blocked`. */
  blockedReason: PaymentBlockedReason | null;
  balanceCents: string;
  /** The postpaid credit-line floor ("0" when the org has no credit line). */
  floorCents: string;
  /**
   * Net platform spend per day over the burn window, or null when it cannot be
   * measured honestly — in which case `burnUnavailableReason` names why and no
   * date is invented from it.
   */
  realizedDailyBurnCents: string | null;
  burnUnavailableReason: BurnUnavailableReason | null;
  burnWindowDays: number;
  /**
   * The ceilings the customer configured across this org's brands. A PERMISSION,
   * not a prediction — served beside the realized burn, never instead of it.
   */
  configuredDailyBudgetCents: string;
  /**
   * The share of those ceilings with a campaign actually running behind them,
   * per campaign-service. Null when campaign-service could not be read — never
   * the configured total wearing a running label.
   */
  runningDailyBudgetCents: string | null;
}

/**
 * Every brand of this org that carries a funded ceiling — a campaign ceiling, a
 * brand-level scalar, or a brand-level "global" sales budget. A brand funded
 * ONLY by the global sales budget carries neither of the first two, and leaving
 * it out made its money read as zero.
 */
export async function fundedBrandIds(orgId: string): Promise<string[]> {
  const rows = await db.execute<{ brand_id: string }>(sql`
    SELECT DISTINCT brand_id
      FROM campaign_daily_budgets
     WHERE org_id = ${orgId}
     UNION
    SELECT DISTINCT brand_id
      FROM brand_daily_budgets
     WHERE org_id = ${orgId}
     UNION
    SELECT DISTINCT brand_id
      FROM brand_sales_budgets
     WHERE org_id = ${orgId}
  `);
  return (rows as unknown as { brand_id: string }[]).map((r) => r.brand_id);
}

/**
 * The org's configured ceiling total, and the running share of it.
 *
 * campaign-service answers per BRAND and there is no per-org read, so the sum
 * across this org's funded brands is billing's own — billing is the service that
 * knows which brands an org funds. Each per-brand figure is taken as SERVED and
 * never recomposed from the rows beneath it. Bounded by the number of funded
 * brands per org, which is a handful.
 *
 * A single brand campaign-service cannot answer makes the whole running total
 * null: a partial sum presented as a total would understate silently, which is
 * the failure mode a null exists to avoid.
 */
async function resolveBudgets(
  orgId: string
): Promise<{ configuredCents: string; runningCents: string | null }> {
  const brandIds = await fundedBrandIds(orgId);
  if (brandIds.length === 0) return { configuredCents: "0", runningCents: "0" };

  const answers = await Promise.all(
    brandIds.map(async (brandId) => ({
      sales: await getBrandSalesBudget(orgId, brandId),
      answer: await fetchSpendableBudget(orgId, brandId),
    }))
  );

  let configured = "0";
  let running: string | null = "0";
  for (const { sales, answer } of answers) {
    if (sales) {
      // GLOBAL mode: the brand stated ONE daily sales budget and campaign-service
      // puts it behind whichever path it picks, so the configured figure is that
      // amount (billing's own, the same one getBrandDailyBudget serves) — never
      // the campaign ceilings kept underneath it. It is running when at least one
      // of the brand's campaigns is; campaign-service's per-ceiling split does not
      // describe a brand funded this way.
      configured = addCents(configured, sales.dailyBudgetCents);
      if (answer === null) {
        running = null;
      } else if (running !== null && answer.campaigns.some((c) => c.running)) {
        running = addCents(running, sales.dailyBudgetCents);
      }
      continue;
    }
    if (answer === null) {
      running = null;
      continue;
    }
    configured = addCents(configured, String(answer.configuredDailyBudgetCents));
    if (running !== null) {
      running = addCents(running, String(answer.runningDailyBudgetCents));
    }
  }
  return { configuredCents: configured, runningCents: running };
}

/**
 * The next month-end settle, as an instant.
 *
 * The sweep fires on the last day of the month at `SWEEP_HOUR_UTC`; the hour is
 * part of the gate for a documented reason (see `lib/month-end-sweep`), so it is
 * part of the date here too.
 */
export function nextMonthEndSweepAt(now: Date): Date {
  const thisMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, SWEEP_HOUR_UTC, 0, 0, 0)
  );
  if (now.getTime() < thisMonth.getTime()) return thisMonth;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0, SWEEP_HOUR_UTC, 0, 0, 0)
  );
}

/**
 * When spend carries the balance past the floor, or null when it never does.
 *
 * Null covers both honest cases: nothing is being spent, and the balance is
 * already past the floor (which the caller reports as due now, not as a date).
 */
export function floorCrossingAt(
  balanceCents: string,
  floorCents: string,
  requiredCents: string,
  dailyBurnCents: string,
  now: Date
): Date | null {
  if (cmpCents(dailyBurnCents, "0") <= 0) return null;
  // The charge fires when `balance − required < floor`, not when the balance
  // reaches the floor — `cannotSpend` is the one predicate and it reserves the
  // next run's estimate. Dating the bare floor would be late by exactly
  // `required ÷ burn`, which for the wedged prod org was most of a day.
  const headroom = subCents(subCents(balanceCents, requiredCents), floorCents);
  if (cmpCents(headroom, "0") <= 0) return null;
  const days = new Decimal(headroom).dividedBy(new Decimal(dailyBurnCents));
  const ms = days.times(24 * 60 * 60 * 1000);
  if (!ms.isFinite()) return null;
  return new Date(now.getTime() + ms.toNumber());
}

/**
 * Whether the month-end settle will actually charge anything.
 *
 * The sweep settles a NEGATIVE balance to zero and leaves a non-negative one
 * alone, so the date is only a charge date if spend carries the balance below
 * zero before it arrives. Treating month-end as an unconditional charge would
 * promise a charge to every org holding credit — which is most of them.
 */
export function settlesAtMonthEnd(
  balanceCents: string,
  dailyBurnCents: string,
  now: Date,
  monthEnd: Date
): boolean {
  const days = new Decimal(monthEnd.getTime() - now.getTime()).dividedBy(
    24 * 60 * 60 * 1000
  );
  const projected = new Decimal(balanceCents).minus(
    new Decimal(dailyBurnCents).times(days)
  );
  return projected.lessThan(0);
}

/** The org's open failed-reload streak, if the world has not moved since. */
async function openStreak(orgId: string, creditedCents: string) {
  const [row] = await db
    .select()
    .from(campaignReloadSweepAttempts)
    .where(eq(campaignReloadSweepAttempts.orgId, orgId))
    .limit(1);

  if (!row) return null;
  if (row.lastOutcome !== "failed") return null;
  // `credited` rising means money arrived, so the streak is over and any verdict
  // about the old card is stale — the same test decideAttempt makes, in the same
  // order, so the two cannot disagree about whether a streak is live.
  if (cmpCents(row.creditedCentsAtAttempt, creditedCents) !== 0) return null;
  return row;
}

/**
 * The inputs the outlook was decided on, for a reader that must project FROM the
 * same decision (lib/charge-schedule) rather than re-derive it and risk a second
 * answer for one org.
 */
export interface PaymentOutlookInputs {
  balanceCents: string;
  /**
   * Credited minus ACTUAL usage — what a month-end settle charges against. The
   * spendable `balanceCents` also subtracts provisioned holds, which are never
   * charged (see `computeSettleBalanceCents`).
   */
  settleBalanceCents: string;
  paidTopupsCents: string;
  /** The largest stored campaign estimate ("0" when none). */
  requiredCents: string;
  /** Null when the org has no credit line (nothing can be reloaded). */
  tierAmountCents: number | null;
  /** ≥1 chargeable payment method on file right now (card or link). */
  hasCardPm: boolean;
  /** False when the card's issuing country cannot be charged off-session. */
  autoReloadSupported: boolean;
  /** The stored auto top-up switch (config present). */
  autoTopupEnabled: boolean;
  /** The issuer called the card lost / stolen / closed on a live streak. */
  cardUnusable: boolean;
  /**
   * SUBSCRIPTION orgs: the live (or latest) subscription and its current charge,
   * which date every charge billing will make (lib/subscription-schedule). Null
   * for every other mode, and for a subscription-mode org that never subscribed.
   */
  subscription: { sub: Subscription; currentCharge: SubscriptionCharge | null } | null;
}

/** The org's live subscription (else its latest) and that period's charge row. */
async function readSubscriptionFacts(
  orgId: string
): Promise<{ sub: Subscription; currentCharge: SubscriptionCharge | null } | null> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  if (!sub) return null;
  const [currentCharge] = await db
    .select()
    .from(subscriptionCharges)
    .where(
      and(
        eq(subscriptionCharges.subscriptionId, sub.id),
        eq(subscriptionCharges.periodStart, sub.currentPeriodStart)
      )
    )
    .limit(1);
  return { sub, currentCharge: currentCharge ?? null };
}

/**
 * Everything billing expects, money-wise, for one org. Pure read: it opens no
 * episode, charges nothing and changes no retry state.
 */
export async function getPaymentOutlook(
  orgId: string,
  now: Date = new Date()
): Promise<PaymentOutlook | null> {
  const resolved = await resolvePaymentOutlook(orgId, now);
  return resolved ? resolved.outlook : null;
}

/** The outlook plus the inputs it was decided on. Same pure read. */
export async function resolvePaymentOutlook(
  orgId: string,
  now: Date = new Date()
): Promise<{ outlook: PaymentOutlook; inputs: PaymentOutlookInputs } | null> {
  const outlookInputs = { current: null as PaymentOutlookInputs | null };
  const outlook = await decideOutlook(orgId, now, outlookInputs);
  if (!outlook || !outlookInputs.current) return null;
  return { outlook, inputs: outlookInputs.current };
}

async function decideOutlook(
  orgId: string,
  now: Date,
  inputsOut: { current: PaymentOutlookInputs | null }
): Promise<PaymentOutlook | null> {
  const [account] = await db
    .select({
      orgId: billingAccounts.orgId,
      paymentMode: billingAccounts.paymentMode,
      createdAt: billingAccounts.createdAt,
      topupAmountCents: billingAccounts.topupAmountCents,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!account) return null;

  const snapshot = await computeBalance(orgId);
  const [block, burn, budgets, streak, settleBalanceCents, platformOrg] = await Promise.all([
    resolveSpendBlock(orgId, snapshot),
    fetchRealizedDailyBurn(orgId, now, account.createdAt),
    resolveBudgets(orgId),
    openStreak(orgId, snapshot.creditedCents),
    computeSettleBalanceCents(orgId, snapshot),
    isPlatformOrg(orgId),
  ]);

  inputsOut.current = {
    balanceCents: snapshot.balanceCents,
    settleBalanceCents,
    paidTopupsCents: snapshot.paidTopupsCents,
    requiredCents: block.requiredCents,
    tierAmountCents: block.tier ? block.tier.amountCents : null,
    hasCardPm: snapshot.hasCardPm,
    autoReloadSupported: snapshot.autoReloadSupported,
    autoTopupEnabled: account.topupAmountCents != null,
    cardUnusable: streak?.cardUnusableAt != null,
    subscription:
      account.paymentMode === "subscription" ? await readSubscriptionFacts(orgId) : null,
  };

  const paymentMode = asPaymentMode(account.paymentMode);
  const base = {
    orgId,
    paymentMode,
    balanceCents: snapshot.balanceCents,
    floorCents: block.floorCents,
    realizedDailyBurnCents: burn.dailyCents,
    burnUnavailableReason: burn.unavailableReason,
    burnWindowDays: burn.windowDays,
    configuredDailyBudgetCents: budgets.configuredCents,
    runningDailyBudgetCents: budgets.runningCents,
  };

  const noDate = { nextChargeAttemptAt: null, trigger: null } as const;

  // Our own internal org (lib/platform-org) is never charged automatically and
  // never blocked: no date, and nothing for campaign-service to stop on.
  if (platformOrg) return { ...base, ...noDate, state: "no_autopay", blockedReason: null };

  // SUBSCRIPTION: the only charge is the plan, on its renewal date (trial end, then
  // monthly), or the next retry rung of a refused renewal. No floor reload, no
  // month-end settle, and no card rule blocks it: between charges spend stops at
  // zero (lib/subscription). Cancel pending / ended / never started → no date.
  if (paymentMode === "subscription") {
    const facts = inputsOut.current?.subscription ?? null;
    const [first] = facts
      ? subscriptionChargeDates(facts.sub, facts.currentCharge, new Date(8.64e15))
      : [];
    if (!first) return { ...base, ...noDate, state: "no_autopay", blockedReason: null };
    return {
      ...base,
      state: "will_charge",
      blockedReason: null,
      nextChargeAttemptAt: new Date(Math.max(first.at.getTime(), now.getTime())).toISOString(),
      trigger: first.trigger,
    };
  }

  // PREPAID: the card rules below exist because a postpaid org spends on credit
  // we must be able to collect. A prepaid org spends only what it already paid,
  // so no card, a refused card, an unusable card or an unsupported country never
  // blocks it — they only mean no automatic top-up will happen, and its spend
  // stops when the balance reaches zero. A live refusal streak still has a real
  // next attempt, so that date is stated; everything else falls through to the
  // ordinary floor / month-end projection, whose floor is zero for this org.
  if (paymentMode === "prepaid") {
    if (
      !snapshot.hasCardPm ||
      block.tier === null ||
      streak?.cardUnusableAt != null
    ) {
      return { ...base, ...noDate, state: "no_autopay", blockedReason: null };
    }
    if (streak && streak.firstFailedAt != null) {
      const dueAt = nextRetryDueAt(streak.attemptCount, streak.firstFailedAt);
      if (dueAt === null) {
        return { ...base, ...noDate, state: "no_autopay", blockedReason: null };
      }
      return {
        ...base,
        state: "will_charge",
        blockedReason: null,
        nextChargeAttemptAt: new Date(
          Math.max(dueAt.getTime(), now.getTime())
        ).toISOString(),
        trigger: "retry_rung",
      };
    }
  }

  // No chargeable payment method on file RIGHT NOW: nothing can ever be charged,
  // so every campaign of this org must stop (campaign-service stops on
  // `charge_blocked`). Read from the CURRENT state, never from a detach event —
  // the card-change flow attaches the new card before detaching the old one, so
  // that customer still reads as holding a card, and adding a card back clears
  // this on the next read with nothing to reset. It outranks the refused-card
  // family below because a retry rung for a card that is gone is a date nobody
  // will act on.
  if (!snapshot.hasCardPm) {
    return {
      ...base,
      ...noDate,
      state: "charge_blocked",
      blockedReason: "no_chargeable_card",
    };
  }

  // A card the issuer called lost, stolen or closed may never be re-presented,
  // at any interval — that outranks every schedule below it.
  if (streak?.cardUnusableAt != null) {
    return { ...base, ...noDate, state: "charge_blocked", blockedReason: "card_unusable" };
  }

  // A live refusal streak: the next rung IS the next attempt, and it is a real
  // date. Out of rungs, the month-end settle owns what is owed but this org is
  // blocked, not scheduled.
  if (streak && streak.firstFailedAt != null) {
    const dueAt = nextRetryDueAt(streak.attemptCount, streak.firstFailedAt);
    if (dueAt === null) {
      return {
        ...base,
        ...noDate,
        state: "charge_blocked",
        blockedReason: "retries_exhausted",
      };
    }
    return {
      ...base,
      state: "charge_blocked",
      blockedReason: "card_declined",
      nextChargeAttemptAt: new Date(
        Math.max(dueAt.getTime(), now.getTime())
      ).toISOString(),
      trigger: "retry_rung",
    };
  }

  // No credit line means nothing can be reloaded, and `resolvePostpaidTier`
  // grants one only to an org that can actually be charged — so a null tier is
  // either no configuration, no chargeable card, or a blocked issuing country.
  // Those are three different sentences to a customer, so they are three reasons
  // (no chargeable card was answered above).
  if (block.tier === null) {
    if (!snapshot.autoReloadSupported) {
      return {
        ...base,
        ...noDate,
        state: "charge_blocked",
        blockedReason: "card_country_unsupported",
      };
    }
    // A POSTPAID org with a chargeable card and auto top-up OFF is still
    // collected at month end on what it owes (lib/month-end-sweep sweeps every
    // postpaid org), so when it owes a chargeable amount the month-end settle IS
    // its next charge — saying `no_autopay` would contradict the sweep about to
    // charge it. Only what it owes NOW: with no credit line its floor is zero, so
    // spend stops there and no burn projection can carry it further below.
    if (paymentMode === "postpaid" && computeSettleCharge(settleBalanceCents) > 0) {
      return {
        ...base,
        state: "will_charge",
        blockedReason: null,
        nextChargeAttemptAt: nextMonthEndSweepAt(now).toISOString(),
        trigger: "month_end",
      };
    }
    return { ...base, ...noDate, state: "no_autopay", blockedReason: null };
  }

  // Past the floor already: the hourly sweep presents the card on its next tick.
  if (block.blocked) {
    return {
      ...base,
      state: "charge_due_now",
      blockedReason: null,
      nextChargeAttemptAt: now.toISOString(),
      trigger: "floor",
    };
  }

  const monthEnd = nextMonthEndSweepAt(now);

  // Spend we cannot measure is not spend we can date. A balance that is ALREADY
  // negative will be settled at month end whatever the rate turns out to be, so
  // that date is certain and is stated; a non-negative one needs a rate to know
  // whether it ever goes negative, and no rate is available. Either way the
  // state says plainly that the floor crossing is unknown rather than implying
  // a projection nobody made.
  if (burn.dailyCents === null) {
    const owes = cmpCents(settleBalanceCents, "0") < 0;
    return {
      ...base,
      state: "unknown",
      blockedReason: null,
      nextChargeAttemptAt: owes ? monthEnd.toISOString() : null,
      trigger: owes ? "month_end" : null,
    };
  }

  // Two things can take money, so both are dated and the sooner one wins. The
  // floor crossing is a rate question; the month-end settle is a balance
  // question, and it charges only what is owed — so it counts only if spend has
  // carried the balance below zero by the time it arrives.
  const candidates: { at: Date; trigger: PaymentChargeTrigger }[] = [];

  const crossing = floorCrossingAt(
    snapshot.balanceCents,
    block.floorCents,
    block.requiredCents,
    burn.dailyCents,
    now
  );
  if (crossing !== null) candidates.push({ at: crossing, trigger: "floor" });

  // The month-end settle charges ACTUAL usage only, so it is projected from the
  // settle balance, not from the spendable one (which also holds provisioned
  // reservations that are never charged).
  if (settlesAtMonthEnd(settleBalanceCents, burn.dailyCents, now, monthEnd)) {
    candidates.push({ at: monthEnd, trigger: "month_end" });
  }

  if (candidates.length === 0) {
    // Nothing is burning and nothing is owed: no charge is coming.
    return { ...base, ...noDate, state: "idle", blockedReason: null };
  }

  const next = candidates.reduce((a, b) => (a.at.getTime() <= b.at.getTime() ? a : b));
  return {
    ...base,
    state: "will_charge",
    blockedReason: null,
    nextChargeAttemptAt: next.at.toISOString(),
    trigger: next.trigger,
  };
}
