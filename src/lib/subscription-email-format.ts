/**
 * Formatting helpers shared by the subscription emails (today: the informational
 * monthly update, lib/subscription-monthly-update-email). Pure.
 *
 *  - A figure below 1 is never inflated: 0.2 expected replies reads as a cadence
 *    ("1 every 5 months"), never "about 1". Too slow a cadence drops the figure.
 *  - A figure features-service could not state (null) drops its cell, never a 0.
 *  - transactional-email-service interpolates `{{var}}` WITHOUT escaping, so every
 *    value from another service (the brand name) goes through escapeHtml.
 */

export const DASHBOARD_URL = "https://dashboard.distribute.you";

/** A return is stated as a figure only when strictly above 1x (owner 2026-10-04). */
export function expectedReturnAboveOne(roiMultiple: number | null | undefined): boolean {
  return typeof roiMultiple === "number" && Number.isFinite(roiMultiple) && roiMultiple > 1;
}

/** Beyond this, a below-1 cadence is too slow to be worth a sentence. */
const MAX_CADENCE_MONTHS = 12;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function wholeDollars(usd: number): string {
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

export function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function times(x: number): string {
  return `${x.toFixed(1)}x`;
}

export function positive(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Expected positive replies, as a stat cell. >= 1 rounds to a whole number (a
 * real rounding, never a floor lifted to 1). Below 1 becomes a cadence, or null.
 */
export function expectedRepliesStat(x: number | null): { value: string; label: string } | null {
  if (!positive(x)) return null;
  if (x >= 1) {
    const n = Math.round(x);
    return { value: `~${n}`, label: `positive ${n === 1 ? "reply" : "replies"} expected` };
  }
  const months = Math.round(1 / x);
  if (months > MAX_CADENCE_MONTHS) return null;
  return {
    value: months <= 1 ? "~1" : `1 every ${months} months`,
    label: "positive reply expected",
  };
}

export const P = 'style="color:#3a3d47;font-size:16px;line-height:1.65;margin:0 0 18px;"';

export function statRowHtml(cells: Array<{ value: string; label: string }>): string {
  const width = Math.floor(100 / cells.length);
  const tds = cells
    .map(
      (c) =>
        `<td width="${width}%" valign="top" style="padding:16px 8px;text-align:center;border:1px solid rgba(10,10,20,0.08);border-radius:10px;background:#fafaf8;">` +
        `<div style="color:#0a0a14;font-size:22px;font-weight:700;letter-spacing:-0.02em;line-height:1.2;">${escapeHtml(c.value)}</div>` +
        `<div style="color:#6b6e78;font-size:13px;line-height:1.4;margin-top:4px;">${escapeHtml(c.label)}</div>` +
        `</td>`
    )
    .join('<td width="8" style="width:8px;font-size:0;line-height:0;">&nbsp;</td>');
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 12px;"><tr>${tds}</tr></table>`
  );
}
