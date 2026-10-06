/**
 * Shared subscription-email helpers (lib/subscription-email-format) and the
 * features-service recap reader (lib/subscription-recap-client), used by the
 * informational monthly update.
 */
import { describe, it, expect } from "vitest";
import {
  expectedRepliesStat,
  expectedReturnAboveOne,
  escapeHtml,
} from "../../src/lib/subscription-email-format.js";
import { toSubscriptionRecap } from "../../src/lib/subscription-recap-client.js";

describe("expectedRepliesStat", () => {
  it("0.2 expected replies never renders 'about 1': it becomes a cadence", () => {
    expect(expectedRepliesStat(0.2)).toEqual({ value: "1 every 5 months", label: "positive reply expected" });
    expect(expectedRepliesStat(0.05)).toBeNull();
    expect(expectedRepliesStat(0)).toBeNull();
    expect(expectedRepliesStat(null)).toBeNull();
    expect(expectedRepliesStat(1.6)).toEqual({ value: "~2", label: "positive replies expected" });
  });
});

describe("expectedReturnAboveOne", () => {
  it("strictly above 1x only; 1.0x, below, unknown are false", () => {
    expect(expectedReturnAboveOne(1.2)).toBe(true);
    expect(expectedReturnAboveOne(1)).toBe(false);
    expect(expectedReturnAboveOne(0.35)).toBe(false);
    expect(expectedReturnAboveOne(null)).toBe(false);
    expect(expectedReturnAboveOne(Number.NaN)).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes a brand name from another service", () => {
    expect(escapeHtml(`A&B <x> "q" 'a'`)).toBe("A&amp;B &lt;x&gt; &quot;q&quot; &#39;a&#39;");
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
        budgetIncrease: {
          revenueMultiple: null,
          expectedAdditionalRevenueUsd: 701.75,
          expectedAdditionalPositiveReplies: 1.26,
          expectedAdditionalRecipientsEnrolled: 305,
        },
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
      raiseAdditionalRecipients: 305,
      actualPositiveReplies: null,
      actualMeetingsBooked: null,
    });
  });
});
