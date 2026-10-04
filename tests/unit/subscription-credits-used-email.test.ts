/**
 * The "your month of outreach is booked" email (lib/subscription-credits-used-email):
 * a success to celebrate, never a shortage (owner rule 2026-10-01), never a send
 * claimed before it happened, never a figure below 1 inflated, and a figure
 * features-service could not state drops its sentence, never a 0 (owner review
 * 2026-10-04, Legistai).
 */
import { describe, it, expect } from "vitest";
import {
  composeCreditsUsedEmail,
  expectedRepliesStat,
} from "../../src/lib/subscription-credits-used-email.js";
import { toSubscriptionRecap, type SubscriptionRecap } from "../../src/lib/subscription-recap-client.js";

const SHORTAGE = /exhaust|used up|run out|ran out|depleted|no credit|out of credit/i;
const DASHES = /[—–]/;

/** Legistai's real recap on 2026-10-04: 302 lined up, nothing sent yet. */
const LEGISTAI: SubscriptionRecap = {
  sentCount: 0,
  recipientsCount: 302,
  recipientsEmailedCount: 0,
  sendStatus: "lined_up_not_sent",
  deliveryRatePct: null,
  expectedPositiveReplies: 1.24,
  expectedRoiMultiple: 7.02,
  lifetimeRevenueUsd: 2500,
  lifetimeRevenueSource: "offer_stated",
  raiseRevenueMultiple: 2.01,
  raiseAdditionalRevenueUsd: 701.75,
  raiseAdditionalPositiveReplies: 1.26,
};

const URL = "https://dashboard.distribute.you/orgs/org_1/billing";

/** The card as registered: bare content, wrapped by transactional-email-service. */
function render(e: { bodyHtml: string; subject: string }): string {
  return e.bodyHtml;
}

describe("composeCreditsUsedEmail", () => {
  it("queued (nothing sent yet): booked, never 'went out'", () => {
    const e = composeCreditsUsedEmail({ recap: LEGISTAI, brandName: "Legistai", ctaUrl: URL });
    expect(e.subject).toBe("Your month of outreach is booked ✅");
    expect(e.heading).toBe("Your month of outreach is booked ✅");
    expect(e.bodyHtml).toContain(">Your month of outreach is booked ✅</h1>");
    expect(e.bodyText.split("\n")[0]).toBe("Your month of outreach is booked ✅");
    const all = JSON.stringify(e);
    expect(all).not.toMatch(/went out|were sent|we sent/i);
    expect(e.bodyText).toContain(
      "We lined up 302 decision-makers for Legistai this month. Their emails go out during each prospect's business hours, for the best reply rate."
    );
    expect(e.bodyText).toContain("302 decision-makers");
    expect(e.bodyText).toContain("~1 positive reply expected");
    expect(e.bodyText).toContain("7.0x expected return");
    expect(e.bodyText).toContain("Based on your $2,500 lifetime revenue per client and our current reply rates.");
    expect(e.bodyText).toContain(
      "Add $100 a month and we expect about 1 more positive reply. That is about $702 more expected revenue."
    );
    // The gain sentence is bold in the rendered email, the raise sentence is not.
    expect(e.bodyHtml).toContain(
      'Add $100 a month and we expect about 1 more positive reply. <strong style="color:#0a0a14;font-weight:700;">That is about $702 more expected revenue.</strong>'
    );
    expect(render(e)).toContain("<strong");
    expect(render(e)).not.toContain("&lt;strong");
    expect(e.ctaLabel).toBe("Add more revenue");
    expect(e.bodyHtml).toContain(`>Add more revenue</a>`);
    expect(e.bodyText).toContain("Add more revenue: " + URL);
    expect(all).not.toContain("Raise my plan");
    expect(e.bodyText.endsWith("--\ndistribute.you\nRevenue made easy.")).toBe(true);
    expect(all).not.toMatch(SHORTAGE);
    expect(all).not.toMatch(DASHES);
  });

  it("sent variant only when emails were actually sent, with the delivery rate", () => {
    const e = composeCreditsUsedEmail({
      recap: { ...LEGISTAI, sentCount: 1240, recipientsEmailedCount: 290, sendStatus: "emails_sent", deliveryRatePct: 99.2 },
      brandName: "Legistai",
      ctaUrl: URL,
    });
    expect(e.subject).toBe("Your month of outreach went out ✅");
    expect(e.bodyText).toContain("We sent 1,240 emails to 290 decision-makers for Legistai this month. 99% were delivered.");
  });

  it("an older recap without sendStatus still needs emailsSent > 0 to say 'went out'", () => {
    const old = { ...LEGISTAI, sendStatus: null, recipientsEmailedCount: null };
    expect(composeCreditsUsedEmail({ recap: old, brandName: null, ctaUrl: URL }).subject).toBe(
      "Your month of outreach is booked ✅"
    );
    const sentOld = composeCreditsUsedEmail({ recap: { ...old, sentCount: 40 }, brandName: null, ctaUrl: URL });
    expect(sentOld.subject).toBe("Your month of outreach went out ✅");
  });

  it("0.2 expected replies never renders 'about 1': it becomes a cadence", () => {
    const e = composeCreditsUsedEmail({
      recap: { ...LEGISTAI, expectedPositiveReplies: 0.2, raiseAdditionalPositiveReplies: 0.2 },
      brandName: null,
      ctaUrl: URL,
    });
    const all = JSON.stringify(e);
    expect(all).not.toMatch(/about 1 |~1 /);
    expect(e.bodyText).toContain("1 every 5 months positive reply expected");
    expect(e.bodyText).toContain("Add $100 a month and we reach more decision-makers.");
    expect(expectedRepliesStat(0.2)).toEqual({ value: "1 every 5 months", label: "positive reply expected" });
    expect(expectedRepliesStat(0.05)).toBeNull();
    expect(expectedRepliesStat(0)).toBeNull();
    expect(expectedRepliesStat(1.6)).toEqual({ value: "~2", label: "positive replies expected" });
  });

  it("a null figure drops its sentence or cell, never a 0 or a placeholder", () => {
    const e = composeCreditsUsedEmail({ recap: null, brandName: null, ctaUrl: "u" });
    expect(e.subject).toBe("Your month of outreach is booked ✅");
    expect(e.bodyText).toContain("We lined up this month's decision-makers.");
    expect(e.bodyHtml).not.toContain("<table");
    expect(e.bodyText).not.toContain("Based on");
    expect(e.bodyText).not.toContain("more expected revenue");
    expect(e.ctaLabel).toBe("Add more revenue");
    expect(e.bodyHtml).not.toContain("<strong");
    expect(JSON.stringify(e)).not.toMatch(/null|undefined|NaN|\{\{/);
    expect(e.bodyText).not.toMatch(/\b0 /);

    const noRoi = composeCreditsUsedEmail({
      recap: { ...LEGISTAI, expectedRoiMultiple: null, lifetimeRevenueUsd: null, raiseAdditionalRevenueUsd: null },
      brandName: "Legistai",
      ctaUrl: URL,
    });
    expect(noRoi.bodyText).not.toContain("expected return");
    expect(noRoi.bodyText).not.toContain("lifetime revenue");
    expect(noRoi.bodyText).not.toContain("more expected revenue");

    const averaged = composeCreditsUsedEmail({
      recap: { ...LEGISTAI, lifetimeRevenueSource: "brand_economics" },
      brandName: null,
      ctaUrl: URL,
    });
    expect(averaged.bodyText).toContain("Based on a $2,500 lifetime revenue per client");
  });

  it("is bare card content: no logo, no blue-dot wordmark, no layout of its own (owner 2026-10-04)", () => {
    for (const recap of [LEGISTAI, { ...LEGISTAI, sentCount: 1240, sendStatus: "emails_sent" as const }]) {
      const e = composeCreditsUsedEmail({ recap, brandName: "Legistai", ctaUrl: URL });
      const html = render(e);
      // The official logo comes from transactional-email-service's layout; a
      // full document would be sent unwrapped, so the card must stay a fragment.
      expect(html).not.toMatch(/<!doctype|<html[\s>]|<body/i);
      expect(html).not.toContain(">distribute.you</span>");
      expect(html).not.toMatch(/#3D80FF|border-radius:50%/i);
      expect(html).toContain("background:#2563EB");
      expect(html).toContain('<table role="presentation"');
      expect(html).not.toMatch(/display:\s*(flex|grid)/);
      expect(html).not.toContain("{{");
      expect(e.bodyHtml).toContain("Kevin<br />Founder, distribute.you");
      // Its text already signs with the why, so the wrap adds no second sign-off.
      expect(e.bodyText).toContain("Revenue made easy.");
    }
  });

  it("escapes a brand name from another service", () => {
    const e = composeCreditsUsedEmail({ recap: LEGISTAI, brandName: "A&B <x>", ctaUrl: URL });
    expect(e.bodyHtml).toContain("A&amp;B &lt;x&gt;");
    expect(e.bodyHtml).not.toContain("<x>");
  });
});

describe("toSubscriptionRecap (features-service OrgPeriodRecapResponse)", () => {
  it("an older features-service (no sendStatus) reads null, not a guess", () => {
    const r = toSubscriptionRecap({ outbound: { emailsSent: 3, recipientsContacted: 2 } });
    expect(r.sendStatus).toBeNull();
    expect(r.recipientsEmailedCount).toBeNull();
    expect(r.recipientsCount).toBe(2);
  });

  it("reads the fields the email states, nulls stay null", () => {
    expect(
      toSubscriptionRecap({
        outbound: {
          emailsSent: 0,
          recipientsContacted: 302,
          recipientsEnrolled: 302,
          recipientsEmailed: 0,
          sendStatus: "lined_up_not_sent",
          deliveryRatePct: null,
        },
        expectedPositiveReplies: 1.24,
        expectedReturn: { roiMultiple: 7.02, lifetimeRevenuePerClientUsd: 2500, lifetimeRevenueSource: "offer_stated" },
        budgetIncrease: { revenueMultiple: null, expectedAdditionalRevenueUsd: 701.75, expectedAdditionalPositiveReplies: 1.26 },
      })
    ).toEqual({
      sentCount: 0,
      recipientsCount: 302,
      recipientsEmailedCount: 0,
      sendStatus: "lined_up_not_sent",
      deliveryRatePct: null,
      expectedPositiveReplies: 1.24,
      expectedRoiMultiple: 7.02,
      lifetimeRevenueUsd: 2500,
      lifetimeRevenueSource: "offer_stated",
      raiseRevenueMultiple: null,
      raiseAdditionalRevenueUsd: 701.75,
      raiseAdditionalPositiveReplies: 1.26,
    });
  });
});
