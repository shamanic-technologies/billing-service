/**
 * POSTPAID card check: prove the card holds the first credit-line step BEFORE we
 * extend credit (owner 2026-10-22, CARD-HOLD-50-1022).
 *
 * Why: Jarygo Studios went postpaid with a US debit card, ran $36.93 of campaigns
 * on the $50 line, and both $50 charges were declined for insufficient funds.
 * Saving a card proves nothing about funds.
 *
 * The rule, worked through:
 *
 *     Client saves a card on the postpaid wall.
 *     We place a $50 authorization HOLD on it (funds blocked, nothing charged).
 *       bank says no  -> refused at the wall, no credit line, no campaign spends.
 *       bank says yes -> credit line open ($50 below zero).
 *     Spend reaches the $50 step while the hold is alive (~7 days)
 *       -> the step is paid by CAPTURING the hold (no second charge),
 *          then ONE hold for the next step ($200) is placed.
 *     The hold expires first -> nothing happens, the step charges as today.
 *     A hold is NEVER renewed.
 *
 * State: `billing_accounts.postpaid_card_check` ('required' | 'passed' | 'refused' |
 * 'grandfathered'). Only 'passed' / 'grandfathered' open a line (lib/topup-tier
 * `autoTopupArmed`, the one reader). Holds themselves are stripe-service's
 * (`/internal/card_holds/by-org/:orgId`, both acquirers): billing never stores a
 * hold, it asks for the live one when it is about to charge.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts } from "../db/schema.js";
import {
  captureCardHold,
  CardHoldUnavailableError,
  getLiveCardHold,
  getSavedPaymentMethod,
  placeCardHold,
  sumSucceededTopupsForOrg,
  type CardHold,
} from "./stripe-service-client.js";
import { tierFor } from "./topup-tier.js";
import { recordChargeSignal } from "./payment-alerts.js";
import type { ReloadOutcome } from "./reload-coalescer.js";

/** Marks the holds THIS module places, so a card-verification hold is never captured. */
export const CREDIT_LINE_HOLD_PURPOSE = "postpaid_credit_line_step";

const HOLD_CURRENCY = "usd";
/** Revolut can answer 503 `hold_pending` while it authorises: retry the SAME key. */
const HOLD_PENDING_ATTEMPTS = 4;
const HOLD_PENDING_MAX_WAIT_MS = 3000;

export type PostpaidCardCheckResult =
  | { result: "passed"; hold: CardHold }
  | { result: "refused"; message: string; code: string | null; hold: CardHold };

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function placeHoldRetryingPending(
  orgId: string,
  amountCents: number,
  idempotencyKey: string,
  metadata: Record<string, string>
): Promise<CardHold> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await placeCardHold(
        orgId,
        {
          amount: amountCents,
          currency: HOLD_CURRENCY,
          session: "off_session",
          description: "Distribute card check (nothing is charged)",
          metadata,
        },
        idempotencyKey
      );
    } catch (err) {
      const pending = err instanceof CardHoldUnavailableError && err.code === "hold_pending";
      if (!pending || attempt >= HOLD_PENDING_ATTEMPTS) throw err;
      await sleep(Math.min(HOLD_PENDING_MAX_WAIT_MS, 1000 * attempt));
    }
  }
}

/** The customer-facing sentence for a refused hold (the bank's own words when given). */
export function refusedHoldMessage(hold: CardHold): string {
  const bank = hold.failure?.message?.trim();
  return bank
    ? `Your bank refused a $${(hold.amount / 100).toFixed(2)} check on this card: ${bank} Use another card, or pay upfront.`
    : `Your bank refused a $${(hold.amount / 100).toFixed(2)} check on this card. Use another card, or pay upfront.`;
}

/**
 * Place the first-step hold on the org's saved card and record the verdict.
 * Throws when the bank could not be asked (no card, acquirer down): the check
 * stays as it was, nothing opens.
 */
export async function runPostpaidCardCheck(orgId: string): Promise<PostpaidCardCheckResult> {
  const [saved, paidTopupsCents] = await Promise.all([
    getSavedPaymentMethod(orgId),
    sumSucceededTopupsForOrg(orgId),
  ]);
  if (!saved.saved || !saved.method) {
    throw new CardHoldUnavailableError(409, "no_saved_payment_method", `org ${orgId} has no saved card to check`);
  }
  const amountCents = tierFor(paidTopupsCents).amountCents;
  // One attempt per card per UTC day: a re-click replays the same answer, a new
  // card (or tomorrow, once funds arrived) is asked afresh.
  const key = `postpaid-card-check:${orgId}:${saved.method.id}:${utcDay()}`;
  const hold = await placeHoldRetryingPending(orgId, amountCents, key, {
    billing_purpose: CREDIT_LINE_HOLD_PURPOSE,
    reason: "postpaid_card_check",
  });

  if (hold.status === "held") {
    await db
      .update(billingAccounts)
      .set({
        postpaidCardCheck: "passed",
        postpaidCardCheckMessage: null,
        postpaidCardCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(billingAccounts.orgId, orgId));
    console.log(
      `[billing-service] postpaid card check: org ${orgId} hold ${hold.id} accepted (${amountCents} cents, expires ${hold.expires_at})`
    );
    return { result: "passed", hold };
  }

  // Anything but held is a refusal: `requires_action` cannot happen off_session,
  // and a line is never opened on a hold the bank did not accept.
  const message = refusedHoldMessage(hold);
  await db
    .update(billingAccounts)
    .set({
      postpaidCardCheck: "refused",
      postpaidCardCheckMessage: hold.failure?.message ?? null,
      postpaidCardCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.orgId, orgId));
  console.warn(
    `[billing-service] postpaid card check: org ${orgId} hold ${hold.id} ${hold.status}` +
      (hold.failure ? ` (${hold.failure.code}: ${hold.failure.message})` : "")
  );
  return { result: "refused", message, code: hold.failure?.code ?? null, hold };
}

/**
 * Place ONE hold for the next step after a capture. Never throws, never awaited by
 * the charge: the step is already paid. Never renewed: this runs only after a
 * capture, keyed on the captured hold, so one capture = at most one next hold.
 */
export async function placeNextStepHold(orgId: string, capturedHoldId: string): Promise<void> {
  try {
    const paid = await sumSucceededTopupsForOrg(orgId);
    const amountCents = tierFor(paid).amountCents;
    const hold = await placeHoldRetryingPending(
      orgId,
      amountCents,
      `postpaid-next-step-hold:${orgId}:${capturedHoldId}`,
      { billing_purpose: CREDIT_LINE_HOLD_PURPOSE, reason: "postpaid_next_step", after_hold: capturedHoldId }
    );
    console.log(
      `[billing-service] postpaid next-step hold: org ${orgId} ${hold.status} ${amountCents} cents (hold ${hold.id})`
    );
  } catch (err) {
    console.error(`[billing-service] postpaid next-step hold failed for org ${orgId}:`, err);
  }
}

/**
 * Pay a POSTPAID org's charge by capturing its live credit-line hold, when one is
 * alive and covers the amount. Returns the outcome, or null when no hold can pay
 * it (not postpaid, no live hold, hold too small, hold gone at capture): the
 * caller then charges the card as usual. A hold is only ever captured for money
 * already owed (every caller of the charge path collects spent money).
 */
export async function payByCapturingHold(
  orgId: string,
  amountCents: number,
  metadata?: Record<string, string>
): Promise<ReloadOutcome | null> {
  const [account] = await db
    .select({ paymentMode: billingAccounts.paymentMode })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!account || account.paymentMode !== "postpaid") return null;

  let live: CardHold | null;
  try {
    live = await getLiveCardHold(orgId);
  } catch (err) {
    // Charging instead is safe: the hold simply expires, nothing is taken twice.
    console.error(`[billing-service] postpaid hold read failed for org ${orgId}, charging the card instead:`, err);
    return null;
  }
  if (!live || live.metadata?.billing_purpose !== CREDIT_LINE_HOLD_PURPOSE || amountCents > live.amount) return null;

  let captured: CardHold | null;
  try {
    captured = await captureCardHold(orgId, live.id, amountCents);
  } catch (err) {
    console.error(`[billing-service] postpaid hold capture failed for org ${orgId}, charging the card instead:`, err);
    return null;
  }
  if (!captured || captured.status !== "captured") {
    console.warn(
      `[billing-service] postpaid hold ${live.id} not captured for org ${orgId} (${captured?.status ?? "not live"}), charging the card instead`
    );
    return null;
  }
  const reference = (captured as CardHold & { payment_reference?: string | null }).payment_reference ?? captured.reference ?? captured.id;
  await recordChargeSignal(orgId, reference, metadata?.reason, amountCents);
  console.log(`[billing-service] postpaid step paid by capturing hold ${live.id}: org ${orgId}, ${amountCents} cents`);
  void placeNextStepHold(orgId, live.id);
  return { status: "succeeded", reference };
}
