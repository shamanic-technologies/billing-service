/**
 * How an org pays — the customer's explicit choice, never inferred from whether
 * a card is on file. See lib/payment-mode.
 *
 * Kept in its own module so the pure tier math (lib/topup-tier) can name the
 * type without importing the database.
 */
export const PAYMENT_MODES = ["prepaid", "postpaid", "subscription"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * The modes a CUSTOMER may switch between on their own. SUBSCRIPTION is entered by
 * starting a subscription (or by staff), never by the payment-mode switch: being in
 * it without a subscription would mean no credit line and no subscription either.
 */
export const CUSTOMER_SWITCHABLE_PAYMENT_MODES = ["prepaid", "postpaid"] as const;

/**
 * Spends only money already paid in (or granted): no credit line, floor ZERO.
 * PREPAID and SUBSCRIPTION. Every rule that reads "a prepaid org" in the sense of
 * "no credit was extended to it" must read this instead.
 */
export function spendsOnlyPaidIn(mode: PaymentMode): boolean {
  return mode === "prepaid" || mode === "subscription";
}

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
