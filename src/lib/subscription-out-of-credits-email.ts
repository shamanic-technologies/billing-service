/**
 * The "out of credits" email of a SUBSCRIPTION org (owner 2026-10-10): « send an
 * email to tell them they are out of credits, with a link to upgrade », listing
 * « toutes les campagnes proactives qui ne tournent plus, mais surtout … toutes
 * les campagnes réactives qui convertissent le mieux qui ne fonctionnent plus ».
 *
 * Pure: composes subject, card HTML and plain text. Billing computes no figure:
 * the campaign names are campaign-service's (the sales funnel campaign's name),
 * whether each is reactive or proactive is features-service's served funnel type,
 * the plan amount is billing's own. Order: REACTIVE first (they answer prospects
 * who replied, they convert best), then PROACTIVE, then any whose type could not
 * be read (never guessed into either list). ONE button: upgrade.
 *
 * Copy rules: short, plain, English, one idea per sentence, no em/en dashes,
 * distribute.you is never called an agency. Every value from another service is
 * HTML-escaped (transactional-email-service interpolates without escaping).
 */
import { P, escapeHtml } from "./subscription-email-format.js";

export interface StoppedCampaign {
  /** The customer-visible name (campaign-service's sales funnel campaign name). */
  name: string;
  /** features-service's served funnel type; null = could not be read. */
  kind: "reactive" | "proactive" | null;
}

export interface OutOfCreditsEmail {
  subject: string;
  heading: string;
  bodyHtml: string;
  bodyText: string;
  ctaLabel: string;
  ctaUrl: string;
}

export const OUT_OF_CREDITS_CTA_LABEL = "Upgrade my plan";

function usdPerMonth(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}/month`;
}

export function composeOutOfCreditsEmail(params: {
  campaigns: StoppedCampaign[];
  brandName: string | null;
  trialing: boolean;
  monthlyAmountCents: number;
  ctaUrl: string;
}): OutOfCreditsEmail {
  const reactive = params.campaigns.filter((c) => c.kind === "reactive").map((c) => c.name);
  const proactive = params.campaigns.filter((c) => c.kind === "proactive").map((c) => c.name);
  const other = params.campaigns.filter((c) => c.kind === null).map((c) => c.name);

  const subject = params.brandName
    ? `Your campaigns for ${params.brandName} have stopped`
    : "Your campaigns have stopped";
  const heading = "You are out of credits";
  const intro = params.trialing
    ? "Your free trial credit is used up. Your campaigns have stopped."
    : `Your credit for this month is used up. Your campaigns have stopped until your next charge.`;

  const sections: Array<{ title: string; lead: string; names: string[] }> = [];
  if (reactive.length > 0) {
    sections.push({
      title: "Prospects who replied get no answer",
      lead: "These campaigns answer people who replied to you. They convert best.",
      names: reactive,
    });
  }
  if (proactive.length > 0) {
    sections.push({
      title: "No new prospects are reached",
      lead: "These campaigns start new conversations.",
      names: proactive,
    });
  }
  if (other.length > 0) {
    sections.push({ title: "Also stopped", lead: "", names: other });
  }

  const upgrade = params.trialing
    ? `You are on the ${usdPerMonth(params.monthlyAmountCents)} plan. Upgrade to start now. You pay today and your credit lands right away.`
    : `You are on the ${usdPerMonth(params.monthlyAmountCents)} plan. Upgrade to restart today. You pay the new amount now and your credit lands right away.`;

  const html: string[] = [
    `<h1 style="color:#0a0a14;font-size:24px;font-weight:700;letter-spacing:-0.02em;line-height:1.25;margin:0 0 20px;">${escapeHtml(heading)}</h1>`,
    `<p ${P}>${escapeHtml(intro)}</p>`,
  ];
  for (const s of sections) {
    html.push(
      `<p style="color:#0a0a14;font-size:16px;font-weight:600;line-height:1.5;margin:0 0 6px;">${escapeHtml(s.title)}</p>`
    );
    if (s.lead) {
      html.push(`<p style="color:#3a3d47;font-size:15px;line-height:1.6;margin:0 0 8px;">${escapeHtml(s.lead)}</p>`);
    }
    html.push(
      `<ul style="color:#3a3d47;font-size:15px;line-height:1.6;margin:0 0 20px;padding-left:20px;">${s.names
        .map((n) => `<li>${escapeHtml(n)}</li>`)
        .join("")}</ul>`
    );
  }
  html.push(
    `<p ${P}>${escapeHtml(upgrade)}</p>`,
    `<p style="margin:0 0 28px;"><a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;background:#2563EB;color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-size:16px;font-weight:600;">${escapeHtml(OUT_OF_CREDITS_CTA_LABEL)}</a></p>`,
    `<p style="color:#3a3d47;font-size:16px;line-height:1.65;margin:0;">Kevin<br />Founder, distribute.you</p>`
  );

  const text: string[] = [heading, "", intro];
  for (const s of sections) {
    text.push("", s.title);
    if (s.lead) text.push(s.lead);
    text.push(...s.names.map((n) => `- ${n}`));
  }
  text.push(
    "",
    upgrade,
    "",
    `${OUT_OF_CREDITS_CTA_LABEL}: ${params.ctaUrl}`,
    "",
    "Kevin",
    "Founder, distribute.you",
    "",
    "--",
    "distribute.you",
    "Revenue made easy."
  );

  return {
    subject,
    heading,
    bodyHtml: html.join("\n"),
    bodyText: text.join("\n"),
    ctaLabel: OUT_OF_CREDITS_CTA_LABEL,
    ctaUrl: params.ctaUrl,
  };
}
