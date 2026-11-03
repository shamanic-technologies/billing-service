/**
 * The informational monthly update (owner 2026-10-04): "Your month for <brand>",
 * sent to every subscription org at the end of each period
 * (lib/subscription-monthly-update). Pure: composes subject, card HTML and plain
 * text from features-service's recap of the CLOSED period. Billing computes no figure.
 *
 * Rules (owner review of the rendered draft, 2026-10-04):
 *  - Results only. No proposal to raise spend, no upsell, and never what the
 *    client paid ("$99 invested" was replaced by the delivery rate).
 *  - A return is ONLY features-service's EXPECTED return or its REALIZED return
 *    (owner 2026-11-03, ROI-CONSISTENCY-1103), both from the recap's `returns` block,
 *    each named: "Expected 19× · no paid client yet ($94 spent)". The expected one is
 *    shown above 1x only (never surface a negative); the realized one states its paid
 *    clients and spend, its multiple only from 1x. The recap's old
 *    `expectedReturn.roiMultiple` (the retired pipeline return, "still learning") is
 *    never read.
 *  - "Sent" only on positive evidence a send happened, a figure below 1 is never inflated, a null figure drops its
 *    sentence or its cell, never a 0.
 *  - The window's REAL outcomes (features-service `actualOutcomes`: positive replies
 *    received, meetings booked) lead, as their own stat row. Only a positive count
 *    is shown: unknown (null) and a measured 0 drop the cell (client-comms: never
 *    surface a negative; a quiet month simply shows the volume).
 *
 * The card is registered bare (src/instrument.ts) and wrapped by
 * transactional-email-service in the official layout. Values from other services
 * (the brand name) are HTML-escaped: interpolation does not escape.
 */
import type { SubscriptionRecap } from "./subscription-recap-client.js";
import {
  P,
  count,
  escapeHtml,
  expectedRepliesStat,
  positive,
  statRowHtml,
  multiple,
  wholeDollars,
} from "./subscription-email-format.js";

export interface MonthlyUpdateEmail {
  subject: string;
  heading: string;
  bodyHtml: string;
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
}

export const MONTHLY_UPDATE_CTA_LABEL = "See your results";
export const NOTHING_TO_DO_SENTENCE = "Nothing to do on your side: we keep sending and track every reply.";

/**
 * The return line, or null. Expected (above 1x) and realized are joined by " · ".
 * Realized: 0 paid clients -> "no paid client yet ($94 spent)"; paid clients below 1x
 * -> their count and spend, no ratio; from 1x -> "3.2× realized on 2 paid clients".
 */
export function returnLine(r: SubscriptionRecap): string | null {
  const parts: string[] = [];
  if (r.expectedReturnMultiple !== null && r.expectedReturnMultiple > 1) {
    parts.push(`Expected ${multiple(r.expectedReturnMultiple)}`);
  }
  const z = r.realizedReturn;
  if (z && z.spentUsd > 0) {
    const spent = `(${wholeDollars(z.spentUsd)} spent)`;
    const n = Math.round(z.closedWonCount);
    const clients = `${count(n)} paid ${n === 1 ? "client" : "clients"}`;
    if (n <= 0) parts.push(`no paid client yet ${spent}`);
    else if (z.roiMultiple >= 1) parts.push(`${multiple(z.roiMultiple)} realized on ${clients} ${spent}`);
    else parts.push(`${clients} so far ${spent}`);
  }
  if (parts.length === 0) return null;
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Was anything lined up or sent in the window? An email about nothing is not sent. */
export function recapHasActivity(r: SubscriptionRecap): boolean {
  return positive(r.sentCount) || positive(r.recipientsCount);
}

/** The window's real outcomes as stat cells, positive counts only (0 and null dropped). */
export function actualOutcomeCells(r: SubscriptionRecap): Array<{ value: string; label: string }> {
  const cells: Array<{ value: string; label: string }> = [];
  if (positive(r.actualPositiveReplies)) {
    const n = Math.round(r.actualPositiveReplies);
    cells.push({ value: count(n), label: n === 1 ? "positive reply" : "positive replies" });
  }
  if (positive(r.actualMeetingsBooked)) {
    const n = Math.round(r.actualMeetingsBooked);
    cells.push({ value: count(n), label: n === 1 ? "meeting booked" : "meetings booked" });
  }
  return cells;
}

export function composeMonthlyUpdateEmail(params: {
  recap: SubscriptionRecap;
  brandName: string | null;
  ctaUrl: string;
}): MonthlyUpdateEmail {
  const r = params.recap;
  const sent =
    positive(r.sentCount) && (r.sendStatus == null || r.sendStatus === "emails_sent") ? r.sentCount : null;
  const recipients = positive(r.recipientsCount) ? r.recipientsCount : null;
  const emailed = positive(r.recipientsEmailedCount) ? r.recipientsEmailedCount : null;
  const delivered = r.deliveryRatePct != null && sent !== null ? Math.round(r.deliveryRatePct) : null;

  const subject = params.brandName ? `Your month for ${params.brandName}` : "Your month with distribute.you";
  const heading = subject;

  const lines: string[] = [];
  if (sent !== null) {
    const reached = emailed ?? (r.sendStatus == null ? recipients : null);
    lines.push(
      reached !== null
        ? `We sent ${count(sent)} emails to ${count(reached)} decision-makers this month.`
        : `We sent ${count(sent)} emails this month.`
    );
  } else if (recipients !== null) {
    lines.push(`We lined up ${count(recipients)} decision-makers this month.`);
    lines.push("Their emails go out during each prospect's business hours, for the best reply rate.");
  }

  const outcomeCells = actualOutcomeCells(r);
  const cells: Array<{ value: string; label: string }> = [];
  if (recipients !== null) cells.push({ value: count(recipients), label: "decision-makers" });
  const replies = expectedRepliesStat(r.expectedPositiveReplies);
  if (replies) cells.push(replies);
  if (delivered !== null) cells.push({ value: `${delivered}%`, label: "delivered" });

  const finePrint = replies ? "Expected replies based on our current reply rates." : null;
  const returns = returnLine(r);

  const status = NOTHING_TO_DO_SENTENCE;
  const ctaLabel = MONTHLY_UPDATE_CTA_LABEL;

  const html: string[] = [
    `<h1 style="color:#0a0a14;font-size:24px;font-weight:700;letter-spacing:-0.02em;line-height:1.25;margin:0 0 20px;">${escapeHtml(heading)}</h1>`,
  ];
  if (lines.length > 0) html.push(`<p ${P}>${lines.map(escapeHtml).join(" ")}</p>`);
  if (outcomeCells.length > 0) html.push(statRowHtml(outcomeCells));
  if (cells.length > 0) html.push(statRowHtml(cells));
  if (finePrint) {
    html.push(`<p style="color:#8b8e98;font-size:13px;line-height:1.5;margin:0 0 24px;">${escapeHtml(finePrint)}</p>`);
  }
  if (returns) html.push(`<p ${P}><strong>${escapeHtml(returns)}</strong></p>`);
  html.push(
    `<p ${P}>${escapeHtml(status)}</p>`,
    `<p style="margin:0 0 28px;"><a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;background:#2563EB;color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-size:16px;font-weight:600;">${escapeHtml(ctaLabel)}</a></p>`,
    `<p style="color:#3a3d47;font-size:16px;line-height:1.65;margin:0;">Kevin<br />Founder, distribute.you</p>`
  );

  const text: string[] = [heading];
  if (lines.length > 0) text.push("", lines.join(" "));
  if (outcomeCells.length > 0) text.push("", ...outcomeCells.map((c) => `${c.value} ${c.label}`));
  if (cells.length > 0) text.push("", ...cells.map((c) => `${c.value} ${c.label}`));
  if (finePrint) text.push(finePrint);
  if (returns) text.push("", returns);
  text.push("", status, "", `${ctaLabel}: ${params.ctaUrl}`, "", "Kevin", "Founder, distribute.you", "", "--", "distribute.you", "Revenue made easy.");

  return { subject, heading, bodyHtml: html.join("\n"), bodyText: text.join("\n"), ctaLabel, ctaUrl: params.ctaUrl };
}
