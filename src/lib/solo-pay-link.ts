/**
 * The solo-founder plan's PAY LINK (SOLO-PLAN-1125): one URL per org, safe to paste in
 * a WhatsApp message, an email or an MCP answer, that takes the founder straight to
 * paying, with no login and no dashboard (the owner removed the dashboard from this
 * offer).
 *
 *   free      -> "Start my trial" (card page when no card, else the $99 hold + trial)
 *   trialing  -> "Pay $99 now" (the trial ends today)
 *   active    -> "Add $100 a month" (charged now, unspent credit deducted)
 *   past_due  -> "Update my card"
 *
 * The token is `<base64url(orgId.expiresAtUnix)>.<base64url(hmac)>`, HMAC-SHA256 under a
 * key DERIVED from the service's own API key (never sent anywhere, nothing to set by
 * hand). Whoever holds a link can only ever pay for THAT org, on the card THAT org saved.
 * A link lives 30 days; every plan read serves a fresh one.
 *
 * A GET never moves money: WhatsApp, Slack and mail clients fetch links to draw a
 * preview, so the page only SHOWS what one click will do. The money moves on the
 * page's single POST button, which carries the state the page showed (`expect`): a
 * stale page (back button, double submit) re-renders instead of charging twice.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const PAY_PATH = "/public/solo-plan/pay";

function signingKey(): Buffer {
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!apiKey) throw new Error("BILLING_SERVICE_API_KEY is not set: cannot sign solo plan pay links");
  return createHmac("sha256", apiKey).update("solo-plan-pay-link:v1").digest();
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function mac(payload: string): Buffer {
  return createHmac("sha256", signingKey()).update(payload).digest();
}

export function signPayToken(orgId: string, now: Date = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${orgId}.${exp}`;
  return `${b64url(payload)}.${b64url(mac(payload))}`;
}

/** The org a token pays for, or null (malformed, forged, expired). */
export function verifyPayToken(token: string, now: Date = new Date()): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let payload: string;
  let given: Buffer;
  try {
    payload = Buffer.from(parts[0], "base64url").toString("utf8");
    given = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }
  const expected = mac(payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const m = /^([0-9a-f-]{36})\.(\d+)$/i.exec(payload);
  if (!m) return null;
  if (Number(m[2]) < Math.floor(now.getTime() / 1000)) return null;
  return m[1].toLowerCase();
}

/** The path a gateway serves publicly (GET page + POST button). */
export function payLinkPath(orgId: string, now: Date = new Date()): string {
  return `${PAY_PATH}/${signPayToken(orgId, now)}`;
}

/**
 * The full link: `SOLO_PLAN_PUBLIC_BASE_URL` (the public origin PLUS whatever prefix the
 * gateway mounts this path under, e.g. `https://api.distribute.you/v1/billing` when it
 * serves `/v1/billing/public/solo-plan/pay/:token`) + the path. Null when unset.
 */
export function payLinkUrl(orgId: string, now: Date = new Date()): string | null {
  const base = process.env.SOLO_PLAN_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}${payLinkPath(orgId, now)}` : null;
}

export const SOLO_PAY_PATH_PREFIX = PAY_PATH;
