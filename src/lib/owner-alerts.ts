/**
 * One Telegram message to the owner per customer billing event billing records
 * (owner 2026-10-06: "Also send me a telegram message when there is a billing
 * information, like topup, change in auto-topup, cancellation, upgrade in
 * subscription, anything like that"). Payments themselves are lib/payment-alerts.
 *
 * Rules, the same as the payment alert:
 *  - NEVER the owner's own actions: the acting person is read from the request's
 *    `x-email` (carried through async work by `ownerAlertActorMiddleware`); a staff
 *    address (`isStaffEmail`) sends nothing. Our own platform orgs send nothing.
 *  - Fire-and-forget: `notifyOwnerBillingEvent` returns at once and never throws,
 *    so a failed send can never fail or delay the billing write it reports. The
 *    caller fires it only AFTER its write committed.
 *  - Once per event: an event a sweep could report again carries a `dedupKey`,
 *    claimed in `owner_alerts` before the send (released if the send fails). A
 *    route event is one write = one message.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { ownerAlerts } from "../db/schema.js";
import { isPlatformOrg } from "./platform-org.js";
import { resolveOrgDisplayIdentity } from "./brand-service-client.js";
import { isStaffEmail } from "./payment-alerts.js";
import { escapeTelegramHtml, getTelegramConfig, sendOwnerTelegram } from "./telegram-client.js";

const actorStore = new AsyncLocalStorage<{ email: string | null }>();

/** Remember who is acting for the rest of this request (and the work it starts). */
export function ownerAlertActorMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.headers["x-email"];
  const email = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  actorStore.run({ email }, next);
}

export function currentActorEmail(): string | null {
  return actorStore.getStore()?.email ?? null;
}

export interface OwnerBillingEvent {
  orgId: string;
  /** One line, plain text: what changed, from what to what, amount. Escaped here. */
  text: string;
  emoji?: string;
  /** Claimed once in `owner_alerts`; set it for any event a re-run could report again. */
  dedupKey?: string;
}

export function composeOwnerEvent(input: {
  orgId: string;
  orgName: string | null;
  orgDomain: string | null;
  emoji: string;
  text: string;
}): string {
  const who = input.orgName
    ? `<b>${escapeTelegramHtml(input.orgName)}</b>`
    : `org <code>${input.orgId.slice(0, 8)}</code>`;
  const domain =
    input.orgDomain && input.orgDomain !== input.orgName ? ` (${escapeTelegramHtml(input.orgDomain)})` : "";
  return [`${input.emoji} ${who}${domain}`, escapeTelegramHtml(input.text), `<code>${input.orgId}</code>`].join("\n");
}

/** Never throws, never awaited by the billing write. */
export function notifyOwnerBillingEvent(event: OwnerBillingEvent): void {
  const actor = currentActorEmail();
  void deliver(event, actor).catch((err) => {
    console.error(`[billing-service] owner alert failed for org ${event.orgId} (${event.text}):`, err);
  });
}

/** Exported for tests: the whole delivery, awaited. */
export async function deliver(event: OwnerBillingEvent, actorEmail: string | null): Promise<"sent" | "skipped" | "failed"> {
  if (!getTelegramConfig()) return "skipped"; // warned loudly at boot
  if (isStaffEmail(actorEmail)) return "skipped";
  if (await isPlatformOrg(event.orgId)) return "skipped";

  if (event.dedupKey) {
    const claimed = await db
      .insert(ownerAlerts)
      .values({ dedupKey: event.dedupKey, orgId: event.orgId, text: event.text })
      .onConflictDoNothing()
      .returning({ key: ownerAlerts.dedupKey });
    if (claimed.length === 0) return "skipped";
  }

  const identity = await resolveOrgDisplayIdentity(event.orgId);
  const html = composeOwnerEvent({
    orgId: event.orgId,
    orgName: identity?.name ?? null,
    orgDomain: identity?.domain ?? null,
    emoji: event.emoji ?? "🔔",
    text: event.text,
  });
  const sent = await sendOwnerTelegram(html);
  if (!sent.ok) {
    if (event.dedupKey) await db.delete(ownerAlerts).where(eq(ownerAlerts.dedupKey, event.dedupKey));
    console.error(`[billing-service] owner alert Telegram send FAILED for org ${event.orgId} (${event.text}): ${sent.error}`);
    return "failed";
  }
  return "sent";
}

/** `$1,234.56` from integer or numeric-string cents. */
export function usd(cents: number | string): string {
  const n = typeof cents === "string" ? Number(cents) : cents;
  return `$${(n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}
