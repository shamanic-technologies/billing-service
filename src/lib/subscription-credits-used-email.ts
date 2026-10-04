/**
 * The email a SUBSCRIPTION org gets once a period's credit is fully committed
 * (lib/subscription-notifications). Pure: composes the subject, the card HTML and
 * the plain-text part from features-service's recap. Billing computes no figure.
 *
 * Rules (owner review 2026-10-04, Legistai: "went out" while 0 emails had been sent):
 *  - It never claims a send that has not happened. Nothing sent yet = "booked"
 *    (the emails go out during each prospect's business hours). "Went out" only
 *    when features-service states emailsSent > 0.
 *  - A figure below 1 is never inflated: 0.2 expected replies reads as a cadence
 *    ("1 every 5 months"), never "about 1". Too slow a cadence drops the figure.
 *  - A figure features-service could not state (null) drops its sentence or its
 *    stat cell, never a 0.
 *  - It reads in 10 seconds: one heading, two lines, three figures, one upsell,
 *    one button. No dashes in copy.
 *
 * The card goes into the distribute.you transactional layout registered in
 * src/instrument.ts (CREDITS_USED_LAYOUT_HTML). transactional-email-service
 * interpolates `{{var}}` WITHOUT escaping, so every value composed here that came
 * from another service (the brand name) is HTML-escaped.
 */
import type { SubscriptionRecap } from "./subscription-recap-client.js";

/** Beyond this, a below-1 cadence is too slow to be worth a sentence. */
const MAX_CADENCE_MONTHS = 12;

export interface CreditsUsedEmail {
  subject: string;
  heading: string;
  /** The card's inner HTML, dropped into the layout's `{{bodyHtml}}`. */
  bodyHtml: string;
  /** The whole plain-text part, dropped into `{{bodyText}}`. */
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wholeDollars(usd: number): string {
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function times(x: number): string {
  return `${x.toFixed(1)}x`;
}

function positive(v: number | null | undefined): v is number {
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

const P = 'style="color:#3a3d47;font-size:16px;line-height:1.65;margin:0 0 18px;"';

function statRowHtml(cells: Array<{ value: string; label: string }>): string {
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

export function composeCreditsUsedEmail(params: {
  recap: SubscriptionRecap | null;
  brandName: string | null;
  ctaUrl: string;
}): CreditsUsedEmail {
  const r = params.recap;
  // "Went out" needs positive evidence a send happened: features-service's verdict
  // when it states one, else a positive emailsSent.
  const sent =
    positive(r?.sentCount) && (r?.sendStatus == null || r.sendStatus === "emails_sent") ? r!.sentCount! : null;
  const recipients = positive(r?.recipientsCount) ? r!.recipientsCount! : null;
  const emailed = positive(r?.recipientsEmailedCount) ? r!.recipientsEmailedCount! : null;
  const forBrand = params.brandName ? ` for ${params.brandName}` : "";

  const subject = sent !== null ? "Your month of outreach went out" : "Your month of outreach is booked";
  const heading = `${subject}.`;

  // The lines (plain text; escaped once when rendered to HTML).
  const lines: string[] = [];
  if (sent !== null) {
    // Who got an email, never the lined-up count (some may still be queued).
    const reached = emailed ?? (r?.sendStatus == null ? recipients : null);
    lines.push(
      reached !== null
        ? `We sent ${count(sent)} emails to ${count(reached)} decision-makers${forBrand} this month.`
        : `We sent ${count(sent)} emails${forBrand} this month.`
    );
    if (r?.deliveryRatePct != null) lines.push(`${Math.round(r.deliveryRatePct)}% were delivered.`);
  } else {
    lines.push(
      recipients !== null
        ? `We lined up ${count(recipients)} decision-makers${forBrand} this month.`
        : `We lined up this month's decision-makers${forBrand}.`
    );
    lines.push("Their emails go out during each prospect's business hours, for the best reply rate.");
  }

  const cells: Array<{ value: string; label: string }> = [];
  if (recipients !== null) cells.push({ value: count(recipients), label: "decision-makers" });
  const replies = expectedRepliesStat(r?.expectedPositiveReplies ?? null);
  if (replies) cells.push(replies);
  if (positive(r?.expectedRoiMultiple)) cells.push({ value: times(r!.expectedRoiMultiple!), label: "expected return" });
  const hasForecast = replies !== null || positive(r?.expectedRoiMultiple);
  const finePrint =
    hasForecast && positive(r?.lifetimeRevenueUsd)
      ? // "your" only for the figure the customer stated on their offer; an
        // average from brand economics is not theirs.
        `Based on ${r!.lifetimeRevenueSource === "offer_stated" ? "your" : "a"} ${wholeDollars(
          r!.lifetimeRevenueUsd!
        )} lifetime revenue per client and our current reply rates.`
      : hasForecast
      ? "Based on our current reply rates."
      : null;

  // Who +$100 reaches reads first (owner-approved copy); replies are the
  // fallback on a recap that does not state it. Never computed here.
  const moreRecipients = r?.raiseAdditionalRecipients ?? null;
  const moreReplies = r?.raiseAdditionalPositiveReplies ?? null;
  const raiseSentence =
    positive(moreRecipients) && moreRecipients >= 1
      ? `Add $100 a month and we reach about ${count(moreRecipients)} more decision-makers.`
      : positive(moreReplies) && moreReplies >= 1
      ? `Add $100 a month and we expect about ${Math.round(moreReplies)} more positive ${
          Math.round(moreReplies) === 1 ? "reply" : "replies"
        }.`
      : "Add $100 a month and we reach more decision-makers.";
  // The gain sells the upgrade at a glance: bold in the HTML (owner review 2026-10-04).
  const gainSentence = positive(r?.raiseAdditionalRevenueUsd)
    ? `That is about ${wholeDollars(r!.raiseAdditionalRevenueUsd!)} more expected revenue.`
    : null;
  const upsell = gainSentence ? `${raiseSentence} ${gainSentence}` : raiseSentence;
  const upsellHtml = gainSentence
    ? `${escapeHtml(raiseSentence)} <strong style="color:#0a0a14;font-weight:700;">${escapeHtml(gainSentence)}</strong>`
    : escapeHtml(raiseSentence);
  const ctaLabel = "Add more revenue";

  const html: string[] = [
    `<h1 style="color:#0a0a14;font-size:24px;font-weight:700;letter-spacing:-0.02em;line-height:1.25;margin:0 0 20px;">${escapeHtml(heading)}</h1>`,
    `<p ${P}>${lines.map(escapeHtml).join(" ")}</p>`,
  ];
  if (cells.length > 0) html.push(statRowHtml(cells));
  if (finePrint) {
    html.push(`<p style="color:#8b8e98;font-size:13px;line-height:1.5;margin:0 0 24px;">${escapeHtml(finePrint)}</p>`);
  }
  html.push(
    `<p ${P}>${upsellHtml}</p>`,
    `<p style="margin:0 0 28px;"><a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;background:#2563EB;color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-size:16px;font-weight:600;">${escapeHtml(ctaLabel)}</a></p>`,
    `<p style="color:#3a3d47;font-size:16px;line-height:1.65;margin:0;">Kevin<br />Founder, distribute.you</p>`
  );

  const text: string[] = [heading, "", lines.join(" ")];
  if (cells.length > 0) {
    text.push("", ...cells.map((c) => `${c.value} ${c.label}`));
  }
  if (finePrint) text.push(finePrint);
  text.push("", upsell, "", `${ctaLabel}: ${params.ctaUrl}`, "", "Kevin", "Founder, distribute.you", "", "--", "distribute.you", "Revenue made easy.");

  return {
    subject,
    heading,
    bodyHtml: html.join("\n"),
    bodyText: text.join("\n"),
    ctaLabel,
    ctaUrl: params.ctaUrl,
  };
}

/**
 * The distribute.you transactional layout (same as the dashboard-owned
 * `welcome` / `goal_launched` templates): CSS text wordmark + blue dot, white
 * card, footer. A full `<html>` document, so it is delivered with the layout
 * whether or not transactional-email-service wraps bare bodies.
 */
export const CREDITS_USED_LAYOUT_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background-color:#fafaf8;font-family:'Space Grotesk','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="margin-bottom:28px;">
      <span style="font-size:26px;font-weight:700;letter-spacing:-0.03em;color:#0a0a14;">distribute.you</span><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#3D80FF;margin-left:3px;"></span>
    </div>
    <div style="background:#ffffff;border:1px solid rgba(10,10,20,0.08);border-radius:12px;padding:36px 32px;">
{{bodyHtml}}
    </div>
    <p style="color:#0a0a14;font-size:15px;font-weight:600;line-height:1.5;margin:28px 0 0;text-align:center;">Revenue made easy.</p>
    <p style="color:#8b8e98;font-size:13px;line-height:1.6;margin-top:6px;text-align:center;">
      Done-for-you cold outreach, sent from our domains on your behalf.<br />
      <a href="https://dashboard.distribute.you" style="color:#8b8e98;">Dashboard</a> &nbsp;·&nbsp; <a href="https://docs.distribute.you" style="color:#8b8e98;">Docs</a>
    </p>
  </div>
</body>
</html>`;
