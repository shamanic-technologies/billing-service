/**
 * How an org pays — the customer's explicit choice, never inferred from whether
 * a card is on file. See lib/payment-mode.
 *
 * Kept in its own module so the pure tier math (lib/topup-tier) can name the
 * type without importing the database.
 */
export const PAYMENT_MODES = ["prepaid", "postpaid"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export function isPaymentMode(value: unknown): value is PaymentMode {
  return typeof value === "string" && (PAYMENT_MODES as readonly string[]).includes(value);
}

/** Narrow a stored column value; the DB CHECK makes anything else impossible. */
export function asPaymentMode(value: string): PaymentMode {
  if (!isPaymentMode(value)) {
    throw new Error(`[billing-service] unknown payment_mode '${value}'`);
  }
  return value;
}
