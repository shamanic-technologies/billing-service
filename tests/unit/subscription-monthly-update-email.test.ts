/**
 * The informational monthly update's copy (owner review 2026-10-04): results only,
 * no upsell, never what the client paid; a return above 1x is a figure, anything
 * else is "still learning" with no ratio.
 */
import { describe, it, expect } from "vitest";
import { toSubscriptionRecap } from "../../src/lib/subscription-recap-client.js";
import {
  composeMonthlyUpdateEmail,
  recapHasActivity,
  STILL_LEARNING_SENTENCE,
} from "../../src/lib/subscription-monthly-update-email.js";

const CTA = "https://dashboard.distribute.you/orgs/org_1";

function recap(roi: number | null, overrides: Record<string, unknown> = {}) {
  return toSubscriptionRecap({
    outbound: {
      emailsSent: 412,
      recipientsEnrolled: 180,
      recipientsEmailed: 180,
      sendStatus: "emails_sent",
      deliveryRatePct: 96.2,
    },
    expectedPositiveReplies: 2.2,
    spendUsd: 99,
    expectedReturn: { roiMultiple: roi, lifetimeRevenuePerClientUsd: 5000, lifetimeRevenueSource: "offer_stated" },
    budgetIncrease: { expectedAdditionalRevenueUsd: 500, expectedAdditionalRecipientsEnrolled: 90 },
    ...overrides,
  } as never);
}

function all(e: ReturnType<typeof composeMonthlyUpdateEmail>) {
  return `${e.subject}\n${e.bodyHtml}\n${e.bodyText}`;
}

describe("monthly update email", () => {
  it.each([
    ["0.35x", 0.35],
    ["exactly 1x", 1],
    ["unknown", null],
  ])("a return of %s reads 'still learning', shows the delivery rate, never a ratio", (_l, roi) => {
    const e = composeMonthlyUpdateEmail({ recap: recap(roi), brandName: "Legistai", ctaUrl: CTA });
    expect(e.subject).toBe("Your month for Legistai");
    expect(e.bodyText).toContain("We sent 412 emails to 180 decision-makers this month.");
    expect(e.bodyText).toContain("96% delivered");
    expect(e.bodyText).not.toContain("were delivered");
    expect(e.bodyText).toContain(STILL_LEARNING_SENTENCE);
    expect(all(e)).not.toMatch(/expected return|0\.\dx|1\.0x/);
  });

  it("a return above 1x is shown, with its basis; no learning sentence", () => {
    const e = composeMonthlyUpdateEmail({ recap: recap(1.8), brandName: "Legistai", ctaUrl: CTA });
    expect(e.bodyText).toContain("1.8x expected return");
    expect(e.bodyText).toContain("96% were delivered.");
    expect(e.bodyText).toContain("Based on your $5,000 lifetime revenue per client");
    expect(e.bodyText).not.toContain(STILL_LEARNING_SENTENCE);
  });

  it.each([0.35, 1.8, null])("never an upsell, never what the client paid (roi %s)", (roi) => {
    const e = composeMonthlyUpdateEmail({ recap: recap(roi), brandName: "Legistai", ctaUrl: CTA });
    expect(all(e)).not.toMatch(/\$100|add more|more revenue|invested|\$99|upgrade|raise/i);
    expect(e.ctaLabel).toBe("See your results");
    expect(e.ctaUrl).toBe(CTA);
    expect(all(e)).not.toMatch(/[—–]/);
  });

  it("lined up but not sent yet: says booked, never 'sent'", () => {
    const e = composeMonthlyUpdateEmail({
      recap: recap(null, {
        outbound: { emailsSent: 0, recipientsEnrolled: 60, sendStatus: "lined_up_not_sent", deliveryRatePct: null },
      }),
      brandName: null,
      ctaUrl: CTA,
    });
    expect(e.subject).toBe("Your month with distribute.you");
    expect(e.bodyText).toContain("We lined up 60 decision-makers this month.");
    expect(e.bodyText).not.toMatch(/We sent|delivered/);
  });

  it("a null figure drops its cell, never a 0", () => {
    const e = composeMonthlyUpdateEmail({
      recap: recap(null, { expectedPositiveReplies: null }),
      brandName: "Legistai",
      ctaUrl: CTA,
    });
    expect(e.bodyText).not.toMatch(/positive repl/);
    expect(e.bodyText).not.toMatch(/(^|\n)0 /);
  });

  it("escapes the brand name in the HTML", () => {
    const e = composeMonthlyUpdateEmail({ recap: recap(null), brandName: "A<b>&", ctaUrl: CTA });
    expect(e.bodyHtml).toContain("A&lt;b&gt;&amp;");
    expect(e.bodyHtml).not.toContain("A<b>&");
  });

  it("activity = something lined up or sent", () => {
    expect(recapHasActivity(recap(null))).toBe(true);
    expect(
      recapHasActivity(recap(null, { outbound: { emailsSent: 0, recipientsEnrolled: 0, sendStatus: "nothing_sent" } }))
    ).toBe(false);
  });
});

describe("actualOutcomes (features-service period recap, the window's real results)", () => {
  const outcomes = (positiveReplies: unknown, meetingsBooked: unknown) => ({
    actualOutcomes: { basis: "dashboard_dated_series", positiveReplies, meetingsBooked },
  });

  it.each([
    ["present", outcomes(7, 2), 7, 2],
    ["measured zero", outcomes(0, 0), 0, 0],
    ["null (unknown)", outcomes(null, null), null, null],
    ["non-number", outcomes("7", undefined), null, null],
    ["block absent (older features-service)", {}, null, null],
    ["block null", { actualOutcomes: null }, null, null],
  ])("client maps %s", (_l, wire, replies, meetings) => {
    const r = toSubscriptionRecap(wire as never);
    expect(r.actualPositiveReplies).toBe(replies);
    expect(r.actualMeetingsBooked).toBe(meetings);
  });

  it("both shown, as their own row, before the existing cells", () => {
    const e = composeMonthlyUpdateEmail({ recap: recap(null, outcomes(7, 2)), brandName: "Doc Dinners", ctaUrl: CTA });
    expect(e.bodyText).toContain("\n7 positive replies\n2 meetings booked\n\n180 decision-makers");
    expect(e.bodyHtml).toContain(">7</div>");
    expect(e.bodyHtml).toContain(">positive replies</div>");
    expect(e.bodyHtml).toContain(">meetings booked</div>");
    expect(e.bodyHtml.match(/<table role="presentation"/g)).toHaveLength(2);
  });

  it("singular labels at 1", () => {
    const e = composeMonthlyUpdateEmail({ recap: recap(null, outcomes(1, 1)), brandName: null, ctaUrl: CTA });
    expect(e.bodyText).toContain("\n1 positive reply\n1 meeting booked\n");
  });

  it("one null drops only its cell", () => {
    const e = composeMonthlyUpdateEmail({ recap: recap(null, outcomes(7, null)), brandName: null, ctaUrl: CTA });
    expect(e.bodyText).toContain("\n7 positive replies\n");
    expect(e.bodyText).not.toContain("meeting");
  });

  it.each([
    ["both null", outcomes(null, null)],
    ["both measured zero", outcomes(0, 0)],
    ["block absent", {}],
  ])("%s: no outcome cells, never a 0, email otherwise unchanged", (_l, wire) => {
    const base = composeMonthlyUpdateEmail({ recap: recap(null), brandName: "Legistai", ctaUrl: CTA });
    const e = composeMonthlyUpdateEmail({ recap: recap(null, wire), brandName: "Legistai", ctaUrl: CTA });
    expect(e).toEqual(base);
    expect(e.bodyText).not.toMatch(/positive replies\n|meetings? booked/);
    expect(e.bodyText).not.toMatch(/(^|\n)0 /);
  });
});
