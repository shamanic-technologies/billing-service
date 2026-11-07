/**
 * "Can billing still charge this org, and if not, why" — the payment hold
 * verdict, answered FAST (FLEET-STALL-1107).
 *
 * campaign-service asks this every minute for every org with a live campaign,
 * and at every run's gate, and stops the org on `charge_blocked`. It used to ask
 * the full payment outlook, which also composes the spendable balance (runs-
 * service usage totals), the realized burn (a runs-service timeseries) and the
 * running budgets (campaign-service). Prod 2026-11-07, shared Postgres saturated:
 * that read took 50 s to 2.3 min, and campaign dispatch for every client fell to
 * ~0 for ~40 min.
 *
 * The verdict needs NONE of those figures. `charge_blocked` + its reason are
 * decided by: the account row (payment mode, auto top-up switch, postpaid card
 * check), the platform-org row, whether a chargeable card is on file and its
 * issuing country, and the refused-card streak row (plus `credited`, only when a
 * failed row exists, to know whether money has since ended it). So this module
 * reads exactly those, and `chargeBlockFrom` is the ONE decision: the payment
 * outlook calls it too, so the two reads can never disagree about an org.
 *
 * FRESHNESS. Everything billing writes itself (a refused charge, a card marked
 * unusable, a payment-mode switch) is read LIVE from its own row on every call:
 * a decline stops the org on the very next read (INSTANT-STOP-ON-DECLINE-1103).
 * Only the card facts come from stripe-service, and those are held at most
 * `CARD_FACTS_FRESH_MS` (then refreshed in the background, served at most
 * `CARD_FACTS_MAX_AGE_MS` old) and dropped at once when billing itself learns a
 * card went away (card removal route, stripe-service's lost-card signal). A card
 * removed straight in an acquirer portal is seen within a minute — the bound the
 * minute-sweep already had.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, campaignReloadSweepAttempts } from "../db/schema.js";
import { asPaymentMode, type PaymentMode } from "./payment-mode-types.js";
import { isPlatformOrg } from "./platform-org.js";
import { openRefusalStreak, type RefusalStreak } from "./refused-charge.js";
import { nextRetryDueAt } from "./campaign-reload-sweep.js";
import { composeCreditedCents } from "./balance.js";
import {
  hasChargeablePmForOrg,
  getOrgCardCountryByOrg,
  isAutoReloadBlockedCountry,
} from "./stripe-service-client.js";

/** Same vocabulary as the payment outlook's `blockedReason` (unchanged). */
export type ChargeBlockedReason =
  | "card_declined"
  | "card_unusable"
  | "retries_exhausted"
  | "no_chargeable_card"
  | "card_country_unsupported";

export interface ChargeBlock {
  blockedReason: ChargeBlockedReason;
  /** The next retry rung (card_declined only), else null. */
  nextChargeAttemptAt: string | null;
  trigger: "retry_rung" | null;
}

/** The facts the verdict is decided on. */
export interface ChargeFacts {
  paymentMode: PaymentMode;
  platformOrg: boolean;
  /** ≥1 chargeable payment method (card or link) on file right now. */
  hasCardPm: boolean;
  /** False when the card's issuing country cannot be charged off-session. */
  autoReloadSupported: boolean;
  /** The OPEN refusal streak (lib/refused-charge `openRefusalStreak`), or null. */
  streak: Pick<RefusalStreak, "cardUnusableAt" | "firstFailedAt" | "attemptCount"> | null;
}

/**
 * The ONE decision: the block that stops this org, or null when billing can
 * charge it. The payment outlook reads it in the same order it always did; this
 * file only gave it a name so a second, cheaper read can ask it alone.
 */
export function chargeBlockFrom(facts: ChargeFacts, now: Date): ChargeBlock | null {
  // Our own internal org is never blocked (lib/platform-org).
  if (facts.platformOrg) return null;
  // SUBSCRIPTION: a refused renewal has its own lifecycle; never charge_blocked.
  if (facts.paymentMode === "subscription") return null;

  const declined = (): ChargeBlock | null => {
    const s = facts.streak;
    if (!s || s.firstFailedAt == null) return null;
    const dueAt = nextRetryDueAt(s.attemptCount, s.firstFailedAt);
    if (dueAt === null) {
      return { blockedReason: "retries_exhausted", nextChargeAttemptAt: null, trigger: null };
    }
    return {
      blockedReason: "card_declined",
      nextChargeAttemptAt: new Date(Math.max(dueAt.getTime(), now.getTime())).toISOString(),
      trigger: "retry_rung",
    };
  };
  const unusable: ChargeBlock = {
    blockedReason: "card_unusable",
    nextChargeAttemptAt: null,
    trigger: null,
  };

  // PREPAID: only a card the bank refused (or called dead) blocks it; no card or
  // an unsupported country only means no automatic top-up.
  if (facts.paymentMode === "prepaid") {
    if (facts.streak?.cardUnusableAt != null) return unusable;
    return declined();
  }

  if (!facts.hasCardPm) {
    return { blockedReason: "no_chargeable_card", nextChargeAttemptAt: null, trigger: null };
  }
  if (facts.streak?.cardUnusableAt != null) return unusable;
  const d = declined();
  if (d) return d;
  if (!facts.autoReloadSupported) {
    return { blockedReason: "card_country_unsupported", nextChargeAttemptAt: null, trigger: null };
  }
  return null;
}

// ── card facts, held briefly ───────────────────────────────────────────────

export const CARD_FACTS_FRESH_MS = 30_000;
export const CARD_FACTS_MAX_AGE_MS = 60_000;

interface CardFacts {
  hasCardPm: boolean;
  cardCountry: string | null;
}
interface CardFactsEntry {
  facts: CardFacts;
  readAt: number;
  /** Bumped by `forgetCardFacts`; a refresh started before it is discarded. */
  generation: number;
}

const cardFactsCache = new Map<string, CardFactsEntry>();
const inFlight = new Map<string, Promise<CardFacts>>();
const generations = new Map<string, number>();

async function readCardFactsLive(orgId: string): Promise<CardFacts> {
  const [hasCardPm, cardCountry] = await Promise.all([
    hasChargeablePmForOrg(orgId),
    getOrgCardCountryByOrg(orgId),
  ]);
  return { hasCardPm, cardCountry };
}

function refreshCardFacts(orgId: string): Promise<CardFacts> {
  const running = inFlight.get(orgId);
  if (running) return running;
  const generation = generations.get(orgId) ?? 0;
  const p = readCardFactsLive(orgId)
    .then((facts) => {
      if ((generations.get(orgId) ?? 0) === generation) {
        cardFactsCache.set(orgId, { facts, readAt: Date.now(), generation });
      }
      return facts;
    })
    .finally(() => {
      if (inFlight.get(orgId) === p) inFlight.delete(orgId);
    });
  inFlight.set(orgId, p);
  return p;
}

/**
 * Card facts at most `CARD_FACTS_MAX_AGE_MS` old. Fresh → served. Older than
 * fresh but within the max age → served, refreshed in the background. Beyond →
 * read live (fail-loud: stripe-service down with nothing recent = throws).
 */
async function cardFactsFor(orgId: string): Promise<CardFacts> {
  const entry = cardFactsCache.get(orgId);
  const age = entry ? Date.now() - entry.readAt : Infinity;
  if (entry && age < CARD_FACTS_FRESH_MS) return entry.facts;
  if (entry && age < CARD_FACTS_MAX_AGE_MS) {
    refreshCardFacts(orgId).catch((err) =>
      console.error(`[billing-service] charge-verdict card refresh failed for org ${orgId}:`, err)
    );
    return entry.facts;
  }
  return refreshCardFacts(orgId);
}

/**
 * Billing learned this org's card changed (removed, lost): the next verdict
 * reads stripe-service live. No argument = forget every org (tests).
 */
export function forgetCardFacts(orgId?: string): void {
  if (orgId === undefined) {
    cardFactsCache.clear();
    inFlight.clear();
    generations.clear();
    return;
  }
  cardFactsCache.delete(orgId);
  inFlight.delete(orgId);
  generations.set(orgId, (generations.get(orgId) ?? 0) + 1);
}

// ── the read ───────────────────────────────────────────────────────────────

export interface ChargeVerdict {
  orgId: string;
  paymentMode: PaymentMode;
  /** Exactly the outlook's `state === "charge_blocked"`. */
  chargeBlocked: boolean;
  /** Same values as the outlook's `blockedReason`; null when not blocked. */
  blockedReason: ChargeBlockedReason | null;
  /** The next retry rung for `card_declined`, else null. */
  nextChargeAttemptAt: string | null;
  trigger: "retry_rung" | null;
}

/**
 * The payment-hold verdict for one org, or null when it has no billing account.
 * Pure read. No runs-service, no campaign-service: a handful of primary-key
 * reads on billing's own tables plus the (briefly held) card facts.
 */
export async function getChargeVerdict(
  orgId: string,
  now: Date = new Date()
): Promise<ChargeVerdict | null> {
  const [accountRows, platformOrg, card, streakRows] = await Promise.all([
    db
      .select({
        paymentMode: billingAccounts.paymentMode,
      })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1),
    isPlatformOrg(orgId),
    cardFactsFor(orgId),
    db
      .select({ lastOutcome: campaignReloadSweepAttempts.lastOutcome })
      .from(campaignReloadSweepAttempts)
      .where(eq(campaignReloadSweepAttempts.orgId, orgId))
      .limit(1),
  ]);
  const account = accountRows[0];
  if (!account) return null;

  // `credited` is needed only to know whether a FAILED streak is still open
  // (money arriving ends it). Nearly every org has no failed row: no
  // stripe-service money read for them.
  const streak =
    streakRows[0]?.lastOutcome === "failed"
      ? await openRefusalStreak(orgId, (await composeCreditedCents(orgId)).creditedCents)
      : null;

  const paymentMode = asPaymentMode(account.paymentMode);
  const autoReloadSupported = !isAutoReloadBlockedCountry(card.cardCountry);
  const block = chargeBlockFrom(
    {
      paymentMode,
      platformOrg,
      hasCardPm: card.hasCardPm,
      autoReloadSupported,
      streak,
    },
    now
  );
  return {
    orgId,
    paymentMode,
    chargeBlocked: block !== null,
    blockedReason: block?.blockedReason ?? null,
    nextChargeAttemptAt: block?.nextChargeAttemptAt ?? null,
    trigger: block?.trigger ?? null,
  };
}
