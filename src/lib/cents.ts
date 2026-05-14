import { Decimal } from "decimal.js";

// Match DB column scale: numeric(16,10).
// Decimal.js precision counts total significant digits — set high enough that
// 16+10 digit operands plus a few digits of headroom never round.
Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });

const SCALE = 10;
const MAX_INT_DIGITS = 16;

/**
 * Validate + normalize a fractional-cents input.
 * Accepts string or number, rejects:
 *   - non-finite (NaN, ±Infinity)
 *   - negative
 *   - zero
 *   - integer part > 16 digits
 *   - non-numeric strings
 *
 * Returns canonical string with fixed scale (10 fractional digits).
 */
export function parsePositiveCents(input: unknown): string {
  if (typeof input !== "string" && typeof input !== "number") {
    throw new Error("amount_cents must be a number or decimal string");
  }
  if (typeof input === "number" && !Number.isFinite(input)) {
    throw new Error("amount_cents must be a finite number");
  }
  let dec: Decimal;
  try {
    dec = new Decimal(input);
  } catch {
    throw new Error(`amount_cents is not a valid decimal: ${String(input)}`);
  }
  if (dec.isNaN() || !dec.isFinite()) {
    throw new Error("amount_cents must be a finite number");
  }
  if (dec.lessThanOrEqualTo(0)) {
    throw new Error("amount_cents must be positive");
  }
  const intDigits = dec.truncated().abs().toFixed(0);
  if (intDigits.length > MAX_INT_DIGITS) {
    throw new Error(`amount_cents integer part exceeds ${MAX_INT_DIGITS} digits`);
  }
  return dec.toFixed(SCALE);
}

/**
 * Validate + normalize a non-negative cents input (allows 0). For optional
 * fields like reload_threshold_cents that historically allowed integer 0.
 */
export function parseNonNegativeCents(input: unknown): string {
  if (typeof input !== "string" && typeof input !== "number") {
    throw new Error("value must be a number or decimal string");
  }
  if (typeof input === "number" && !Number.isFinite(input)) {
    throw new Error("value must be a finite number");
  }
  let dec: Decimal;
  try {
    dec = new Decimal(input);
  } catch {
    throw new Error(`value is not a valid decimal: ${String(input)}`);
  }
  if (dec.isNaN() || !dec.isFinite()) {
    throw new Error("value must be a finite number");
  }
  if (dec.lessThan(0)) {
    throw new Error("value must be non-negative");
  }
  const intDigits = dec.truncated().abs().toFixed(0);
  if (intDigits.length > MAX_INT_DIGITS) {
    throw new Error(`value integer part exceeds ${MAX_INT_DIGITS} digits`);
  }
  return dec.toFixed(SCALE);
}

/** Add two cent strings — returns canonical fixed-scale string. */
export function addCents(a: string, b: string): string {
  return new Decimal(a).plus(b).toFixed(SCALE);
}

/** Subtract `b` from `a`. */
export function subCents(a: string, b: string): string {
  return new Decimal(a).minus(b).toFixed(SCALE);
}

/** Compare: -1, 0, 1. */
export function cmpCents(a: string, b: string): -1 | 0 | 1 {
  return new Decimal(a).comparedTo(b) as -1 | 0 | 1;
}

/** True if value <= 0 (depleted check). */
export function isDepleted(a: string): boolean {
  return new Decimal(a).lessThanOrEqualTo(0);
}

/** True if a >= b. */
export function gte(a: string, b: string): boolean {
  return new Decimal(a).greaterThanOrEqualTo(b);
}
