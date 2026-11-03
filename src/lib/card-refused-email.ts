/**
 * Tell the customer, by email, EVERY time we try to charge their card and the
 * bank refuses it (REFUSED-CARD-EMAIL-EACH-1103).
 *
 * Owner 2026-11-03, verbatim: « ca doit etre un email transactionnel automatique
 * a chaque fois quon essaie et que sa carte est refusée ». Prod the same day: org
 * Beyond Logic (postpaid) had three $50 charges refused for insufficient funds and
 * received no email at all, because the billed-line charge path logged the refusal
 * and mailed nobody, while the other paths mailed only the first refusal of a streak.
 *
 * So the email lives in the ONE place every charge passes through: `chargeNow` in
 * lib/reload, on the branch where the acquirer answered "refused". Every path
 * (authorize reload, usage_apply, the blocked-campaign sweep, month-end settle,
 * card change, pay balance, on-demand charge, subscription charges, auto-upgrade)
 * reaches it with no code of its own, and no path can forget it.
 *
 * - **One refusal = one email.** Claimed in `card_refusal_emails` on the acquirer's
 *   charge reference: an idempotent replay of the same charge (same key, the bank
 *   was not asked again) answers the same reference and mails nothing.
 * - **No attempt = no email.** A backoff-skipped reload never reaches the acquirer,
 *   so it never reaches here.
 * - **The send can never charge.** It rides a platform run, the platform sentinel
 *   user and the `credits-reload-failed` event, which postmark-service bills to the
 *   PLATFORM (`PLATFORM_LIFECYCLE_TAGS`). Nothing here imports a charge or an
 *   authorize. Prod 2026-08-29 is why: this same event, billed to the org, re-entered
 *   authorize 2,939 times in 71 minutes.
 * - **Fail-soft.** Never throws, never delays the charge (fire-and-forget): a mail
 *   that cannot be sent must never change a money outcome. Every gap is logged loudly.
 */
import { db } from "../db/index.js";
import { cardRefusalEmails, PLATFORM_USER_ID } from "../db/schema.js";
import { fetchOrgCustomerOrNull } from "./stripe-service-client.js";
import { fetchOrgUsers } from "./client-service-client.js";
import { isStaffEmail } from "./payment-alerts.js";
import { createPlatformRun, completePlatformRun } from "./runs-client.js";
import { sendEmail } from "./email-client.js";
import { usd } from "./owner-alerts.js";
import { DASHBOARD_URL, P, escapeHtml } from "./subscription-email-format.js";
import { fetchOrgIdentity } from "./budget-change-context.js";
import { fetchOrgBrandIdsOldestFirst } from "./subscription-plans.js";

/**
 * Kept on the historical name on purpose: postmark-service already bills it to the
 * platform, so a refused-card mail can never be refused (or charged) for lack of
 * credit on the org it is about. billing owns its template (src/instrument.ts).
 */
export const CARD_REFUSED_EVENT = "credits-reload-failed";

export const CARD_REFUSED_CTA_LABEL = "Update my card";

export type CardRefusedOutcome = "sent" | "already_sent" | "no_recipient" | "no_run" | "error";

export interface CardRefusedEmail {
  subject: string;
  heading: string;
  bodyHtml: string;
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
}

/** No dash in copy we send, the bank's sentence included. */
function noDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ", ").trim();
}

export function billingSettingsUrl(clerkOrgId: string | null, brandId: string | null): string {
  if (!clerkOrgId) return DASHBOARD_URL;
  if (!brandId) return `${DASHBOARD_URL}/v2/orgs/${clerkOrgId}`;
  return `${DASHBOARD_URL}/v2/orgs/${clerkOrgId}/brands/${brandId}/billing`;
}

export function composeCardRefusedEmail(params: {
  amountCents: number;
  bankReason: string | null;
  permanent: boolean;
  ctaUrl: string;
}): CardRefusedEmail {
  const heading = "Your card was refused";
  const reason = params.bankReason ? noDashes(params.bankReason) : "";
  const lines = [
    `We tried to charge ${usd(params.amountCents)} on your saved card, and your bank refused the payment.`,
    reason ? `Your bank's reason: ${reason}` : "Your bank did not give a reason.",
    params.permanent
      ? "Your bank told us this card can no longer be used, so we will not try it again. Add a different card in your billing settings to keep your campaigns running."
      : "Update your card in your billing settings to keep your campaigns running.",
  ];
  const html = [
    `<h1 style="color:#0a0a14;font-size:24px;font-weight:700;letter-spacing:-0.02em;line-height:1.25;margin:0 0 20px;">${escapeHtml(heading)}</h1>`,
    ...lines.map((l) => `<p ${P}>${escapeHtml(l)}</p>`),
    `<p style="margin:0 0 28px;"><a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;background:#2563EB;color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-size:16px;font-weight:600;">${escapeHtml(CARD_REFUSED_CTA_LABEL)}</a></p>`,
    `<p style="color:#3a3d47;font-size:16px;line-height:1.65;margin:0;">Kevin<br />Founder, distribute.you</p>`,
  ];
  const text = [
    heading,
    "",
    ...lines,
    "",
    `${CARD_REFUSED_CTA_LABEL}: ${params.ctaUrl}`,
    "",
    "Kevin",
    "Founder, distribute.you",
    "",
    "--",
    "distribute.you",
    "Revenue made easy.",
  ];
  return {
    subject: heading,
    heading,
    bodyHtml: html.join("\n"),
    bodyText: text.join("\n"),
    ctaLabel: CARD_REFUSED_CTA_LABEL,
    ctaUrl: params.ctaUrl,
  };
}

/**
 * Who reads it: the org's billing email, else a person of the org (a real client
 * before a staff member), else nobody (logged).
 */
async function resolveRecipient(orgId: string): Promise<string | null> {
  const customer = await fetchOrgCustomerOrNull(orgId).catch((err) => {
    console.error(`[billing-service] card refused email: billing customer of org ${orgId} unreadable:`, err);
    return null;
  });
  if (customer?.email) return customer.email;
  const users = await fetchOrgUsers(orgId).catch((err) => {
    console.error(`[billing-service] card refused email: users of org ${orgId} unreadable:`, err);
    return [] as Array<{ id: string; email: string | null }>;
  });
  const withEmail = users.filter((u) => u.email);
  return (withEmail.find((u) => !isStaffEmail(u.email)) ?? withEmail[0])?.email ?? null;
}

export async function sendCardRefusedEmail(params: {
  orgId: string;
  amountCents: number;
  /** The acquirer's reference for the refused charge (else the idempotency key). */
  chargeKey: string;
  bankReason: string | null;
  permanent: boolean;
}): Promise<CardRefusedOutcome> {
  try {
    const recipientEmail = await resolveRecipient(params.orgId);
    if (!recipientEmail) {
      console.error(`[billing-service] card refused email: org ${params.orgId} has no recipient, not mailed (charge ${params.chargeKey})`);
      return "no_recipient";
    }
    // A send with no end user needs a run that ALREADY EXISTS in runs-service, or
    // the mail is silently dropped (`sent: false`).
    const runId = await createPlatformRun("card-refused-notify");
    if (!runId) {
      console.error(`[billing-service] card refused email: no platform run for org ${params.orgId}, not mailed (charge ${params.chargeKey})`);
      return "no_run";
    }
    const claimed = await db
      .insert(cardRefusalEmails)
      .values({ chargeKey: params.chargeKey, orgId: params.orgId, amountCents: params.amountCents })
      .onConflictDoNothing()
      .returning({ key: cardRefusalEmails.chargeKey });
    if (claimed.length === 0) {
      await completePlatformRun(runId);
      return "already_sent";
    }
    const [identity, brandIds] = await Promise.all([
      fetchOrgIdentity(params.orgId).catch(() => null),
      fetchOrgBrandIdsOldestFirst(params.orgId).catch((err) => {
        console.error(`[billing-service] card refused email: brands of org ${params.orgId} unreadable (link to the org):`, err);
        return [] as string[];
      }),
    ]);
    const email = composeCardRefusedEmail({
      amountCents: params.amountCents,
      bankReason: params.bankReason,
      permanent: params.permanent,
      ctaUrl: billingSettingsUrl(identity?.externalId ?? null, brandIds[0] ?? null),
    });
    sendEmail({
      eventType: CARD_REFUSED_EVENT,
      orgId: params.orgId,
      userId: PLATFORM_USER_ID,
      runId,
      recipientEmail,
      metadata: { ...email, settingsUrl: email.ctaUrl },
    });
    await completePlatformRun(runId);
    console.log(`[billing-service] card refused email sent for org ${params.orgId} (charge ${params.chargeKey}, ${params.amountCents} cents)`);
    return "sent";
  } catch (err) {
    console.error(`[billing-service] card refused email failed for org ${params.orgId} (charge ${params.chargeKey}):`, err);
    return "error";
  }
}

const inFlight = new Set<Promise<CardRefusedOutcome>>();

/** Fire-and-forget: the charge's answer never waits on the mail. */
export function notifyCardRefused(params: Parameters<typeof sendCardRefusedEmail>[0]): void {
  const p = sendCardRefusedEmail(params);
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/** Tests: wait for every mail started so far. */
export async function flushCardRefusedEmails(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}
