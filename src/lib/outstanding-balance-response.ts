/**
 * The wire shape of "you owe us money, so we will not hand you a card session".
 *
 * 402 Payment Required, with a stable `code` the dashboard keys on — this must
 * be distinguishable from every other failure of these routes (400 bad body,
 * 404 no account, 502 stripe-service down), because it is the ONE case where the
 * customer can act: pay what is owed.
 *
 * `owed_cents` is what a successful settle would have taken (whole cents, the
 * same figure the month-end sweep bills). `balance_cents` is the raw negative
 * balance it came from, so nothing has to be re-derived to display either.
 */

import type { OutstandingBalanceError } from "./card-change-settlement.js";

export const OUTSTANDING_BALANCE_CODE = "outstanding_balance_unsettled";

export interface OutstandingBalanceBody {
  error: string;
  code: typeof OUTSTANDING_BALANCE_CODE;
  owed_cents: string;
  balance_cents: string;
  reason: string;
}

export function outstandingBalanceBody(
  err: OutstandingBalanceError
): OutstandingBalanceBody {
  return {
    error:
      "Settle your outstanding balance before changing your payment method.",
    code: OUTSTANDING_BALANCE_CODE,
    owed_cents: err.owedCents,
    balance_cents: err.balanceCents,
    reason: err.reason,
  };
}
