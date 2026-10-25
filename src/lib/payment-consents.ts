/**
 * PAYMENT CONSENT — proof the customer ticked the consent boxes before a first
 * payment (owner 2026-10-11, migration 0081): dispute / chargeback evidence.
 *
 * The dashboard sends `consent` with the call it already makes (top-up checkout,
 * subscription checkout, subscription start). Optional and additive: a call
 * without it works exactly as before. Recorded BEFORE the payment action, so a
 * refused card still leaves the acceptance on file. Append-only, one row per
 * acceptance; never deleted on org teardown (evidence outlives the org).
 *
 * Fail loud: a write that fails fails the request (500 / 502 path of the route),
 * never a payment that went ahead with its consent silently lost.
 */
import { asc, eq } from "drizzle-orm";
import type { Request } from "express";
import { z } from "zod";
import "./zod-v3-compat.js";
import { db } from "../db/index.js";
import { paymentConsents, PLATFORM_USER_ID, type PaymentConsent } from "../db/schema.js";
import { PaymentConsentSchema } from "../schemas.js";

export type PaymentConsentInput = z.infer<typeof PaymentConsentSchema>;
export type PaymentConsentContext =
  | "topup_checkout"
  | "subscription_checkout"
  | "subscription_start"
  | "prepaid_checkout"
  /** PUT /v1/accounts/payment_mode {postpaid}: the postpaid signup arm (card saved, nothing charged). */
  | "payment_mode_postpaid";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Store one acceptance. Who is read from the request's identity headers. */
export async function recordPaymentConsent(params: {
  orgId: string;
  req: Request;
  context: PaymentConsentContext;
  consent: PaymentConsentInput;
  now?: Date;
}): Promise<PaymentConsent> {
  const userIdHeader = params.req.headers["x-user-id"];
  const userId =
    typeof userIdHeader === "string" && UUID_RE.test(userIdHeader) && userIdHeader !== PLATFORM_USER_ID
      ? userIdHeader
      : null;
  const emailHeader = params.req.headers["x-email"];
  const now = params.now ?? new Date();
  const [row] = await db
    .insert(paymentConsents)
    .values({
      orgId: params.orgId,
      userId,
      email: typeof emailHeader === "string" && emailHeader ? emailHeader : null,
      context: params.context,
      statements: params.consent.statements,
      termsVersion: params.consent.terms_version,
      acceptedAt: params.consent.accepted_at ? new Date(params.consent.accepted_at) : now,
      userAgent: params.consent.user_agent ?? null,
      ipAddress: params.consent.ip_address ?? null,
      createdAt: now,
    })
    .returning();
  console.log(
    `[billing-service] payment consent recorded for org ${params.orgId} (${params.context}, terms ${params.consent.terms_version}, ${params.consent.statements.length} statements)`
  );
  return row;
}

/** Every acceptance of an org, oldest first. */
export async function listPaymentConsents(orgId: string): Promise<PaymentConsent[]> {
  return db
    .select()
    .from(paymentConsents)
    .where(eq(paymentConsents.orgId, orgId))
    .orderBy(asc(paymentConsents.createdAt), asc(paymentConsents.id));
}

export function paymentConsentWire(row: PaymentConsent) {
  return {
    id: row.id,
    org_id: row.orgId,
    user_id: row.userId,
    email: row.email,
    context: row.context,
    statements: row.statements,
    terms_version: row.termsVersion,
    accepted_at: row.acceptedAt.toISOString(),
    user_agent: row.userAgent,
    ip_address: row.ipAddress,
    recorded_at: row.createdAt.toISOString(),
  };
}
