/**
 * A usage discount and the welcome match are NOT cumulative (DISCOUNT-NO-MATCH-1030).
 *
 * Owner 2026-10-30, verbatim: « le 50% de discount et le 100 match 100 ne sont pas
 * cumulables ». Example: an org on "we match your first $100" gets a 50% usage
 * discount from staff before paying $100 -> its pending $100 match is withdrawn; it
 * pays $100 later and receives nothing on top. Its discount stays.
 *
 * Two entry points, one function:
 *   - setting a discount > 0 (`setUsageDiscount`) withdraws at once;
 *   - every welcome settle (`settleWelcomeCompletion`) checks the discount first, so
 *     an org whose discount predates this rule is withdrawn on its next settle (the
 *     hourly sweep reaches every candidate) and can never be granted in between.
 *
 * Withdrawal = the existing offer zeroing (`withdrawFreeCreditOffer`: account offer
 * columns + ungranted welcome promise to 0), plus a trace on the promise row
 * (`withdrawn_at`, `withdrawn_reason`, `withdrawn_amount_cents`). Nothing already
 * granted is touched, nothing is debited, nobody is emailed. Removing the discount
 * later does NOT bring the match back: the offer was decided.
 */

import { Decimal } from "decimal.js";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  freeCreditPromises,
  PROMISE_KIND_WELCOME,
} from "../db/schema.js";
import { sumEntitlementGrantsForOrg } from "./promos.js";
import { withdrawFreeCreditOffer } from "./welcome-recipient.js";

export const WITHDRAWN_FOR_USAGE_DISCOUNT = "usage_discount";

export interface MatchWithdrawal {
  /** True when THIS call withdrew a match that was still to come. */
  withdrawn: boolean;
  /** What was still to come and is now withdrawn (cents); 0 when nothing was. */
  withdrawnCents: number;
}

/**
 * Withdraw the org's welcome match if any of it is still to come. Idempotent: once
 * withdrawn the entitlement is 0, so a replay finds nothing left and does nothing.
 */
export async function withdrawWelcomeMatchForUsageDiscount(
  orgId: string
): Promise<MatchWithdrawal> {
  const [account] = await db
    .select({
      entitlementCents: billingAccounts.freeCreditEntitlementCents,
      paidTriggerCents: billingAccounts.freeCreditPaidTriggerCents,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  if (!account) return { withdrawn: false, withdrawnCents: 0 };

  // What is still to come = the org's own entitlement minus what it was already
  // gifted toward it (the same remainder settleWelcomeCompletion would grant).
  const gifted = new Decimal(await sumEntitlementGrantsForOrg(orgId));
  const remaining = new Decimal(account.entitlementCents).minus(gifted);
  if (remaining.lessThanOrEqualTo(0)) return { withdrawn: false, withdrawnCents: 0 };

  const now = new Date();
  await db.transaction(async (tx) => {
    const stamped = await tx
      .update(freeCreditPromises)
      .set({
        withdrawnAt: now,
        withdrawnReason: WITHDRAWN_FOR_USAGE_DISCOUNT,
        withdrawnAmountCents: account.entitlementCents,
      })
      .where(
        and(
          eq(freeCreditPromises.orgId, orgId),
          eq(freeCreditPromises.kind, PROMISE_KIND_WELCOME),
          isNull(freeCreditPromises.grantedAt)
        )
      )
      .returning({ id: freeCreditPromises.id });
    if (stamped.length === 0) {
      // No mirror row yet (an account that predates the promise table): record the
      // withdrawn offer anyway, so the fact is on the ledger like any other.
      await tx
        .insert(freeCreditPromises)
        .values({
          orgId,
          kind: PROMISE_KIND_WELCOME,
          amountCents: 0,
          paidTriggerCents: 0,
          withdrawnAt: now,
          withdrawnReason: WITHDRAWN_FOR_USAGE_DISCOUNT,
          withdrawnAmountCents: account.entitlementCents,
        })
        .onConflictDoNothing();
    }
    await withdrawFreeCreditOffer(tx, orgId);
  });

  const withdrawnCents = remaining.ceil().toNumber();
  console.log(
    `[billing-service] welcome match withdrawn (usage discount, not cumulative): org=${orgId} withdrawn_cents=${withdrawnCents} entitlement_was=${account.entitlementCents} trigger_was=${account.paidTriggerCents}`
  );
  return { withdrawn: true, withdrawnCents };
}
