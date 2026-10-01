/**
 * The "all your outbound went out" email (lib/subscription-notifications): a
 * success to celebrate, never a shortage (owner rule 2026-10-01). Every variable
 * is a complete sentence; a figure features-service could not state drops its
 * sentence, never a 0.
 */
import { describe, it, expect } from "vitest";
import { composeCreditsUsedEmail } from "../../src/lib/subscription-notifications.js";

const SHORTAGE = /exhaust|used up|run out|ran out|depleted|no credit|out of credit/i;

describe("composeCreditsUsedEmail", () => {
  it("states the result, the expected return and the upsell with its gain", () => {
    const e = composeCreditsUsedEmail({
      recap: {
        sentCount: 1240,
        deliveryRatePct: 99.2,
        expectedPositiveReplies: 6.4,
        expectedRoiMultiple: 3.2,
        lifetimeRevenueUsd: 2500,
        raiseRevenueMultiple: 3,
        raiseAdditionalRevenueUsd: 957.85,
      },
      monthlyAmountCents: 9900,
      ctaUrl: "https://dashboard.distribute.you/orgs/org_1/billing",
    });
    expect(e.subject).toBe("All your outbound went out 🎉");
    expect(e.intro).toBe(
      "Congratulations, all 1,240 emails of this month's outbound went out successfully. 99% were delivered."
    );
    expect(e.results).toBe(
      "On this volume we expect about 6 positive replies, for a 3.2x return based on your $2,500 lifetime revenue per client."
    );
    expect(e.upsell).toBe(
      "We strongly recommend raising your plan: +$100 a month would bring about $958 more revenue at your current results."
    );
    expect(e.ctaLabel).toBe("Raise my plan to $199/month");
    expect(JSON.stringify(e)).not.toMatch(SHORTAGE);
    expect(JSON.stringify(e)).not.toContain("—");
  });

  it("drops what it cannot state, never writes 0 or a placeholder", () => {
    const e = composeCreditsUsedEmail({ recap: null, monthlyAmountCents: 19900, ctaUrl: "u" });
    expect(e.intro).toBe("Congratulations, all of this month's outbound went out successfully.");
    expect(e.results).toBe("");
    expect(e.upsell).toContain("$299 a month");
    expect(JSON.stringify(e)).not.toMatch(/null|undefined|NaN|\{\{/);
    expect(JSON.stringify(e)).not.toMatch(SHORTAGE);
  });
});

import { toSubscriptionRecap } from "../../src/lib/subscription-recap-client.js";

describe("toSubscriptionRecap (features-service OrgPeriodRecapResponse)", () => {
  it("reads the fields the email states, nulls stay null", () => {
    expect(
      toSubscriptionRecap({
        outbound: { emailsSent: 1240, deliveryRatePct: 99.1 },
        expectedPositiveReplies: 6.2,
        expectedReturn: { roiMultiple: 3.2, lifetimeRevenuePerClientUsd: 2500 },
        budgetIncrease: { revenueMultiple: null, expectedAdditionalRevenueUsd: 957.85 },
      })
    ).toEqual({
      sentCount: 1240,
      deliveryRatePct: 99.1,
      expectedPositiveReplies: 6.2,
      expectedRoiMultiple: 3.2,
      lifetimeRevenueUsd: 2500,
      raiseRevenueMultiple: null,
      raiseAdditionalRevenueUsd: 957.85,
    });
  });
});
