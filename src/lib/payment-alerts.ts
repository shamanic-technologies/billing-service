/**
 * Tell the owner on Telegram, once, every time a customer's payment SUCCEEDS
 * (owner 2026-10-06: "JE NE RECOIS PAS DE NOTIF QUAND ON A UN CLIENT QUI A PAYE").
 *
 * WHAT COUNTS AS PAID: a payment stripe-service reports `succeeded` on
 * `GET /internal/payments/by-org/{orgId}`, the acquirer-neutral history (Stripe AND
 * Revolut). A checkout opened, a pending order, a refused card: never a message.
 * That list is the same money the balance counts, so "alerted" and "credited" read
 * one source. Nothing here changes how a payment is credited.
 *
 * EXACTLY ONCE: `payment_alerts` is keyed on the acquirer's own payment id. A scan
 * CLAIMS a payment (INSERT ... ON CONFLICT DO NOTHING) before it sends, so a
 * re-scan, a restart or a replica never sends twice. A failed send releases the
 * claim and the next scan retries; a payment older than MAX_ALERT_AGE_MS is never
 * alerted, so a long Telegram outage cannot replay a week of payments.
 *
 * WHO IS SCANNED: every ~30s the HOT orgs (a checkout opened or an off-session
 * charge in the last 48h), every ~10 min every billing account (the backstop for a
 * payment no billing path saw, e.g. an invoice paid later from its hosted page).
 *
 * NEVER THE OWNER'S OWN ACTIONS: money staff recorded by hand (`direct`), our own
 * platform orgs, and a checkout opened by a staff account are claimed as `skipped`
 * and never sent.
 *
 * LABELS come from what billing itself knows (`payment_alert_signals`): the reason
 * of an off-session charge it made, or a checkout it opened. A payment with no
 * matching signal is a checkout top-up.
 */
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { billingAccounts, paymentAlerts, paymentAlertSignals } from "../db/schema.js";
import { listOrgPayments, type OrgPayment } from "./stripe-service-client.js";
import { isPlatformOrg } from "./platform-org.js";
import { resolveOrgDisplayIdentity } from "./brand-service-client.js";
import {
  escapeTelegramHtml,
  getTelegramConfig,
  sendOwnerTelegram,
} from "./telegram-client.js";

/** Nothing paid before this instant is ever alerted: the deploy must not replay history. */
export const PAYMENT_ALERTS_LAUNCH_AT_ISO = "2026-10-06T15:00:00Z";
const LAUNCH_AT_MS = Date.parse(PAYMENT_ALERTS_LAUNCH_AT_ISO);
/** A payment this old is never alerted (bounds a retry after a long outage). */
export const MAX_ALERT_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * A payment is alerted once it is this old, so the off-session charge that made it
 * has had time to write its signal (the mirror is written before the charge
 * returns; the signal right after).
 */
export const ALERT_GRACE_MS = 45 * 1000;
/** An off-session charge signal labels a payment created within this distance. */
const CHARGE_MATCH_WINDOW_MS = 15 * 60 * 1000;
const HOT_WINDOW_MS = 48 * 60 * 60 * 1000;
const SCAN_CONCURRENCY = 4;

/**
 * Staff, mirrored from api-service `src/lib/staff.ts` (STAFF_EMAILS), plus any
 * `@distribute.you` address (our own test accounts). Plus-addressing is ignored.
 */
const STAFF_EMAILS = new Set(["kevin.lourd@gmail.com", "kevin@distribute.you"]);
const STAFF_DOMAIN = "@distribute.you";

export function isStaffEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.endsWith(STAFF_DOMAIN)) return true;
  const [local, domain] = normalized.split("@");
  return STAFF_EMAILS.has(`${local.split("+")[0]}@${domain}`);
}

export type PaymentKind =
  | "checkout_topup"
  | "auto_reload"
  | "subscription"
  | "month_end_settle"
  | "saved_card_topup"
  | "card_change_settle";

/** The `reason` an off-session charge carries (reloadOffSession metadata) → its kind. */
export function kindFromChargeReason(reason: string | undefined): PaymentKind {
  switch (reason) {
    case "subscription":
    case "subscription_reactive_items":
      return "subscription";
    case "month_end_sweep":
      return "month_end_settle";
    case "on_demand_topup":
      return "saved_card_topup";
    case "card_change_settlement":
      return "card_change_settle";
    default:
      // authorize / usage_apply reloads carry no reason; the campaign sweep says so.
      return "auto_reload";
  }
}

const KIND_LABELS: Record<PaymentKind, string> = {
  checkout_topup: "Top-up at checkout",
  auto_reload: "Automatic reload",
  subscription: "Subscription charge",
  month_end_settle: "Month-end settle",
  saved_card_topup: "Top-up on saved card",
  card_change_settle: "Balance settled at card change",
};

function paymentKey(p: OrgPayment): string {
  return `${p.acquirer}:${p.id}`;
}

/**
 * Record that billing just took money off-session. Fail-soft: a missing signal
 * only costs the label, never the charge, so it is logged and swallowed.
 */
export async function recordChargeSignal(
  orgId: string,
  reference: string | null,
  reason: string | undefined,
  amountMinor: number
): Promise<void> {
  try {
    await db.insert(paymentAlertSignals).values({
      orgId,
      signal: "charge",
      kind: kindFromChargeReason(reason),
      reference: reference || null,
      amountMinor,
    });
  } catch (err) {
    console.error(`[billing-service] payment alert: could not record charge signal for org ${orgId}:`, err);
  }
}

/** Record that a person opened a payment checkout for this org. Fail-soft. */
export async function recordCheckoutOpened(
  orgId: string,
  actorEmail: string | null,
  amountMinor: number | null
): Promise<void> {
  try {
    await db.insert(paymentAlertSignals).values({
      orgId,
      signal: "checkout_opened",
      kind: "checkout_topup",
      actorEmail: actorEmail?.trim() || null,
      amountMinor,
    });
  } catch (err) {
    console.error(`[billing-service] payment alert: could not record checkout signal for org ${orgId}:`, err);
  }
}

export function formatPaidAmount(amountMinor: number, currency: string): string {
  const major = (amountMinor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency.toLowerCase() === "usd" ? `$${major}` : `${major} ${currency.toUpperCase()}`;
}

function acquirerLabel(acquirer: string): string {
  if (acquirer === "stripe") return "Stripe";
  if (acquirer === "revolut") return "Revolut";
  return acquirer;
}

export function composePaymentAlert(input: {
  orgId: string;
  orgName: string | null;
  orgDomain: string | null;
  amountMinor: number;
  currency: string;
  kind: PaymentKind;
  acquirer: string;
  paymentNumber: number;
}): string {
  const who = input.orgName
    ? `<b>${escapeTelegramHtml(input.orgName)}</b>`
    : `org <code>${input.orgId.slice(0, 8)}</code>`;
  const domain =
    input.orgDomain && input.orgDomain !== input.orgName
      ? ` (${escapeTelegramHtml(input.orgDomain)})`
      : "";
  const history =
    input.paymentNumber === 1 ? "🥇 First payment ever" : `Payment #${input.paymentNumber} from this org`;
  return [
    `💰 <b>${formatPaidAmount(input.amountMinor, input.currency)} paid</b> by ${who}${domain}`,
    `${KIND_LABELS[input.kind]} · ${acquirerLabel(input.acquirer)}`,
    history,
    `<code>${input.orgId}</code>`,
  ].join("\n");
}

export interface OrgScanResult {
  sent: number;
  skipped: number;
  failed: number;
}

/** Find this org's newly succeeded payments, claim each once, and tell the owner. */
export async function scanOrgPayments(orgId: string, now: Date = new Date()): Promise<OrgScanResult> {
  const result: OrgScanResult = { sent: 0, skipped: 0, failed: 0 };
  const nowMs = now.getTime();
  const payments = await listOrgPayments(orgId);

  // Ordinal over EVERY succeeded payment (a hand-recorded one included): "first
  // payment ever" means the first money this org ever gave us.
  const succeeded = payments
    .filter((p) => p.status === "succeeded")
    .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  const numberOf = new Map(succeeded.map((p, i) => [paymentKey(p), i + 1]));

  const candidates = succeeded.filter((p) => {
    const paidMs = p.created * 1000;
    return (
      p.acquirer !== "direct" && // staff recorded it by hand: their own action
      paidMs >= LAUNCH_AT_MS &&
      paidMs >= nowMs - MAX_ALERT_AGE_MS &&
      paidMs <= nowMs - ALERT_GRACE_MS
    );
  });
  if (candidates.length === 0) return result;

  const known = await db
    .select({ key: paymentAlerts.paymentKey })
    .from(paymentAlerts)
    .where(inArray(paymentAlerts.paymentKey, candidates.map(paymentKey)));
  const knownKeys = new Set(known.map((r) => r.key));
  const fresh = candidates.filter((p) => !knownKeys.has(paymentKey(p)));
  if (fresh.length === 0) return result;

  const signals = await db
    .select()
    .from(paymentAlertSignals)
    .where(
      and(
        eq(paymentAlertSignals.orgId, orgId),
        gte(paymentAlertSignals.createdAt, new Date(nowMs - MAX_ALERT_AGE_MS - HOT_WINDOW_MS))
      )
    )
    .orderBy(desc(paymentAlertSignals.createdAt));
  const platformOrg = await isPlatformOrg(orgId);
  let identity: Awaited<ReturnType<typeof resolveOrgDisplayIdentity>> | undefined;

  for (const p of fresh) {
    const key = paymentKey(p);
    const paidMs = p.created * 1000;
    const charge =
      signals.find((s) => s.signal === "charge" && s.reference === p.id) ??
      signals.find(
        (s) =>
          s.signal === "charge" &&
          (s.matchedPaymentKey === null || s.matchedPaymentKey === key) &&
          s.amountMinor === p.amount &&
          Math.abs(s.createdAt.getTime() - paidMs) <= CHARGE_MATCH_WINDOW_MS
      );
    const kind: PaymentKind = charge ? ((charge.kind ?? "auto_reload") as PaymentKind) : "checkout_topup";

    let skipReason: string | null = null;
    if (platformOrg) {
      skipReason = "platform_org";
    } else if (!charge) {
      // Whoever opened the checkout this payment came through: the latest one opened
      // before it (5 min clock tolerance) within the hot window.
      const opener = signals.find(
        (s) =>
          s.signal === "checkout_opened" &&
          s.createdAt.getTime() <= paidMs + 5 * 60 * 1000 &&
          s.createdAt.getTime() >= paidMs - HOT_WINDOW_MS
      );
      if (opener && isStaffEmail(opener.actorEmail)) skipReason = "staff_actor";
    }

    const claimed = await db
      .insert(paymentAlerts)
      .values({
        paymentKey: key,
        orgId,
        acquirer: p.acquirer,
        amountMinor: p.amount,
        currency: p.currency,
        kind,
        paymentNumber: numberOf.get(key)!,
        outcome: skipReason ? "skipped" : "sending",
        skipReason,
        paidAt: new Date(paidMs),
      })
      .onConflictDoNothing()
      .returning({ key: paymentAlerts.paymentKey });
    if (claimed.length === 0) continue; // another scan got it first
    if (charge && charge.matchedPaymentKey === null) {
      await db
        .update(paymentAlertSignals)
        .set({ matchedPaymentKey: key })
        .where(and(eq(paymentAlertSignals.id, charge.id), isNull(paymentAlertSignals.matchedPaymentKey)));
      charge.matchedPaymentKey = key;
    }
    if (skipReason) {
      console.log(`[billing-service] payment alert skipped (${skipReason}) for ${key} org ${orgId}`);
      result.skipped++;
      continue;
    }

    if (identity === undefined) identity = await resolveOrgDisplayIdentity(orgId);
    const html = composePaymentAlert({
      orgId,
      orgName: identity?.name ?? null,
      orgDomain: identity?.domain ?? null,
      amountMinor: p.amount,
      currency: p.currency,
      kind,
      acquirer: p.acquirer,
      paymentNumber: numberOf.get(key)!,
    });
    const sent = await sendOwnerTelegram(html);
    if (sent.ok) {
      await db
        .update(paymentAlerts)
        .set({ outcome: "sent", sentAt: new Date() })
        .where(eq(paymentAlerts.paymentKey, key));
      result.sent++;
    } else {
      // Release the claim so the next scan retries; the payment itself is untouched.
      await db.delete(paymentAlerts).where(eq(paymentAlerts.paymentKey, key));
      console.error(`[billing-service] payment alert Telegram send FAILED for ${key} org ${orgId}: ${sent.error}`);
      result.failed++;
    }
  }
  return result;
}

export interface PaymentAlertScanResult extends OrgScanResult {
  orgs: number;
  orgErrors: number;
  unconfigured: boolean;
}

/** One scan: the hot orgs, or every billing account when `full`. Never throws per org. */
export async function runPaymentAlertScan(opts: { full: boolean; now?: Date }): Promise<PaymentAlertScanResult> {
  const now = opts.now ?? new Date();
  const out: PaymentAlertScanResult = { orgs: 0, orgErrors: 0, sent: 0, skipped: 0, failed: 0, unconfigured: false };
  // Nothing can be told: claim nothing, so the payments are alerted once it is fixed.
  if (!getTelegramConfig()) {
    out.unconfigured = true;
    return out;
  }

  const hot = await db
    .selectDistinct({ orgId: paymentAlertSignals.orgId })
    .from(paymentAlertSignals)
    .where(gte(paymentAlertSignals.createdAt, new Date(now.getTime() - HOT_WINDOW_MS)));
  const orgIds = new Set(hot.map((r) => r.orgId));
  if (opts.full) {
    const all = await db.select({ orgId: billingAccounts.orgId }).from(billingAccounts);
    for (const r of all) orgIds.add(r.orgId);
  }

  const queue = [...orgIds];
  out.orgs = queue.length;
  const worker = async () => {
    for (let orgId = queue.shift(); orgId; orgId = queue.shift()) {
      try {
        const r = await scanOrgPayments(orgId, now);
        out.sent += r.sent;
        out.skipped += r.skipped;
        out.failed += r.failed;
      } catch (err) {
        out.orgErrors++;
        console.error(`[billing-service] payment alert scan failed for org ${orgId}:`, err);
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  return out;
}

export const PAYMENT_ALERT_TICK_MS = 30 * 1000;
/** Every Nth tick scans every billing account, not only the hot ones (~10 min). */
const FULL_SCAN_EVERY = 20;

let alertTimer: NodeJS.Timeout | null = null;

/** Self-rescheduling loop, started after the port is bound; first tick is a full scan. */
export function startPaymentAlertScheduler(): void {
  let tickNo = 0;
  const tick = async () => {
    const full = tickNo % FULL_SCAN_EVERY === 0;
    tickNo++;
    try {
      const r = await runPaymentAlertScan({ full });
      if (r.sent > 0 || r.failed > 0 || r.orgErrors > 0 || r.skipped > 0) {
        console.log(
          `[billing-service] payment alert scan (${full ? "full" : "hot"}): orgs=${r.orgs} sent=${r.sent} ` +
            `skipped=${r.skipped} failed=${r.failed} orgErrors=${r.orgErrors}`
        );
      }
    } catch (err) {
      console.error("[billing-service] payment alert scan failed:", err);
    } finally {
      alertTimer = setTimeout(tick, PAYMENT_ALERT_TICK_MS);
    }
  };
  alertTimer = setTimeout(tick, PAYMENT_ALERT_TICK_MS);
}

export function stopPaymentAlertScheduler(): void {
  if (alertTimer) clearTimeout(alertTimer);
  alertTimer = null;
}
