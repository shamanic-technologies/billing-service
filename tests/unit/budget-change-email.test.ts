import { describe, it, expect } from "vitest";
import {
  buildBudgetChangeEmail,
  type BudgetChangeEmailInput,
} from "../../src/lib/budget-change-email.js";
import { channelCatalogueFrom } from "../../src/lib/budget-change-context.js";
import type { SpendableBudget } from "../../src/lib/campaign-service-client.js";

// The prod case this exists for (2026-09-29, brand NOVEMIQ): Herald (cold email
// -> positive reply, an ENTRY leg that spends daily) went $10 -> $7/day, Pilot
// (AI meeting booking, positive reply -> meeting booked, a REACTIVE cap) stayed
// at $3. The old email read "Running: $13/day -> $10/day" with UUIDs.
const BRAND = "933d4abb-9695-4fcb-b3aa-354d61565798";
const ORG = "22ffb00a-b7da-4453-9bf2-1784c2d2bf9e";
const OFFER = "e59646e4-e351-462d-a8a7-618098e7e5c1";
const COLD = "sales-cold-email-outreach";
const MEET = "ai-meeting-booking";
const HERALD_LEG = "start_to_conversation";
const PILOT_LEG = "conversation_to_meeting_booked";

// Crew names were retired 2026-10-04 (they now name sales path combinations).
// The catalogue below carries one leg with a legacy crewName, one with null and
// one with none: every line must name the CHANNEL either way.
const catalogue = channelCatalogueFrom([
  {
    slug: COLD,
    name: "Sales Cold Email Outreach",
    stepTransitions: [
      { legKey: HERALD_LEG, from: null, to: { label: "Positive reply" }, crewName: "Herald" },
      { legKey: "start_to_website_visit", from: null, to: { label: "Website visit" }, crewName: null },
    ],
  },
  {
    slug: MEET,
    name: "AI Meeting Booking",
    stepTransitions: [
      {
        legKey: PILOT_LEG,
        from: { label: "Positive reply" },
        to: { label: "Meeting booked" },
      },
    ],
  },
] as Parameters<typeof channelCatalogueFrom>[0]);

function spendable(rows: Array<{ slug: string; leg: string; cents: number; running: boolean }>): SpendableBudget {
  return {
    orgId: ORG,
    brandId: BRAND,
    grain: "campaign",
    configuredDailyBudgetCents: rows.reduce((s, r) => s + r.cents, 0),
    runningDailyBudgetCents: rows.filter((r) => r.running).reduce((s, r) => s + r.cents, 0),
    campaigns: [],
    rows: rows.map((r) => ({
      featureSlug: r.slug,
      offerId: OFFER,
      legKey: r.leg,
      resolvedOfferId: OFFER,
      dailyBudgetCents: r.cents,
      running: r.running,
      campaignId: null,
      campaignStatus: r.running ? "ongoing" : "stopped",
    })),
  };
}

function novemiq(overrides: Partial<BudgetChangeEmailInput> = {}): BudgetChangeEmailInput {
  return {
    brandId: BRAND,
    orgId: ORG,
    firstBudget: false,
    changes: [
      {
        featureSlug: COLD,
        offerId: OFFER,
        legKey: HERALD_LEG,
        previousDailyBudgetCents: "1000.0000000000",
        newDailyBudgetCents: "700.0000000000",
      },
    ],
    ceilings: [
      { featureSlug: COLD, offerId: OFFER, legKey: HERALD_LEG, dailyBudgetCents: "700.0000000000" },
      { featureSlug: MEET, offerId: OFFER, legKey: PILOT_LEG, dailyBudgetCents: "300.0000000000" },
    ],
    brandName: "NOVEMIQ",
    org: { name: "NOVEMIQ", externalId: "org_3JxXPgCKdCsyikm3KwmuWKcEu05" },
    offerNames: new Map([[OFFER, "Growth"]]),
    catalogue,
    spendable: spendable([
      { slug: COLD, leg: HERALD_LEG, cents: 700, running: true },
      { slug: MEET, leg: PILOT_LEG, cents: 300, running: true },
    ]),
    ...overrides,
  };
}

describe("buildBudgetChangeEmail — the NOVEMIQ replay", () => {
  const email = buildBudgetChangeEmail(novemiq());

  it("states the one changed mission, by channel, with its delta", () => {
    expect(email.summaryText).toContain(
      'Sales Cold Email Outreach · Positive reply · offer "Growth": $10/day → $7/day (−$3, −30%)'
    );
    expect(email.subject).toBe("NOVEMIQ lowered Sales Cold Email Outreach · Positive reply: $10/day → $7/day");
  });

  it("the daily total is the running entry legs only, Pilot is a cap apart", () => {
    expect(email.summaryText).toContain("Daily spend now: $7/day");
    expect(email.summaryText).toContain("Reactive caps (spend only when triggered");
    expect(email.summaryText).toContain(
      'AI Meeting Booking · Positive reply → Meeting booked · offer "Growth": $3 cap'
    );
    // Never a daily + reactive sum anywhere.
    for (const body of [email.subject, email.summaryText, email.summaryHtml]) {
      expect(body).not.toMatch(/\$13\b/);
      expect(body).not.toContain("Daily spend now: $10");
      expect(body).not.toMatch(/Running:|Configured:/);
    }
  });

  it("names brand, org and links the admin console, ids only in the footer", () => {
    expect(email.summaryText.split("\n")[0]).toBe("NOVEMIQ (org NOVEMIQ)");
    expect(email.summaryHtml).toContain(
      `https://admin.distribute.you/orgs/org_3JxXPgCKdCsyikm3KwmuWKcEu05/brands/${BRAND}`
    );
    expect(email.summaryText.trim().split("\n").at(-1)).toBe(`Brand id ${BRAND} · Org id ${ORG}`);
  });

  it("carries no em-dash", () => {
    expect(`${email.subject}${email.summaryHtml}${email.summaryText}`).not.toContain("—");
  });
});

describe("buildBudgetChangeEmail — crew names retired (2026-10-04)", () => {
  // Herald leg: crewName "Herald"; website leg: crewName null; Pilot leg: absent.
  const WEB = "start_to_website_visit";
  const cases: Array<[string, string, string]> = [
    ["present", HERALD_LEG, "Sales Cold Email Outreach · Positive reply"],
    ["null", WEB, "Sales Cold Email Outreach · Website visit"],
  ];
  for (const [what, leg, name] of cases) {
    it(`crewName ${what}: the line names the channel, never a crew`, () => {
      const email = buildBudgetChangeEmail(
        novemiq({
          changes: [{ featureSlug: COLD, offerId: OFFER, legKey: leg, previousDailyBudgetCents: "700", newDailyBudgetCents: "1000" }],
        })
      );
      expect(email.subject).toBe(`NOVEMIQ raised ${name}: $7/day → $10/day`);
      expect(email.summaryText).toContain(`${name} · offer "Growth": $7/day → $10/day`);
      for (const body of [email.subject, email.summaryText, email.summaryHtml]) {
        expect(body).not.toMatch(/Herald|Scout|Pilot|crew/i);
      }
    });
  }

  it("crewName absent: the line names the channel, never a crew", () => {
    const email = buildBudgetChangeEmail(
      novemiq({
        changes: [{ featureSlug: MEET, offerId: OFFER, legKey: PILOT_LEG, previousDailyBudgetCents: "300", newDailyBudgetCents: "500" }],
      })
    );
    expect(email.subject).toBe("NOVEMIQ raised AI Meeting Booking · Positive reply → Meeting booked: $3 cap → $5 cap");
    for (const body of [email.subject, email.summaryText, email.summaryHtml]) {
      expect(body).not.toMatch(/Herald|Scout|Pilot|crew/i);
    }
  });

  it("a leg the catalogue does not carry names the channel and the leg", () => {
    const email = buildBudgetChangeEmail(
      novemiq({
        changes: [{ featureSlug: COLD, offerId: OFFER, legKey: "start_to_mystery", previousDailyBudgetCents: "700", newDailyBudgetCents: "1000" }],
      })
    );
    expect(email.summaryText).toContain(
      'Sales Cold Email Outreach · leg start_to_mystery (not in the channel catalogue) · offer "Growth": $7 → $10'
    );
    expect(email.summaryText).not.toMatch(/crew/i);
  });
});

describe("buildBudgetChangeEmail — rules", () => {
  it("one line per changed mission, direction reallocated when both ways", () => {
    const email = buildBudgetChangeEmail(
      novemiq({
        changes: [
          { featureSlug: COLD, offerId: OFFER, legKey: HERALD_LEG, previousDailyBudgetCents: "1000", newDailyBudgetCents: "700" },
          { featureSlug: MEET, offerId: OFFER, legKey: PILOT_LEG, previousDailyBudgetCents: "0", newDailyBudgetCents: "300" },
        ],
      })
    );
    const section = email.summaryText.split("What changed\n")[1].split("\n\n")[0];
    expect(section.split("\n")).toHaveLength(2);
    expect(section).toContain("AI Meeting Booking");
    expect(section).toContain("$0 → $3 cap (+$3, new)");
    expect(email.subject).toBe("NOVEMIQ reallocated Sales Cold Email Outreach · Positive reply and AI Meeting Booking · Positive reply → Meeting booked");
  });

  it("subject says raised, paused and first budget", () => {
    const raise = buildBudgetChangeEmail(
      novemiq({ changes: [{ featureSlug: COLD, offerId: OFFER, legKey: HERALD_LEG, previousDailyBudgetCents: "700", newDailyBudgetCents: "1000" }] })
    );
    expect(raise.subject).toBe("NOVEMIQ raised Sales Cold Email Outreach · Positive reply: $7/day → $10/day");

    const pause = buildBudgetChangeEmail(
      novemiq({ changes: [{ featureSlug: COLD, offerId: OFFER, legKey: HERALD_LEG, previousDailyBudgetCents: "700", newDailyBudgetCents: "0" }] })
    );
    expect(pause.subject).toBe("NOVEMIQ paused Sales Cold Email Outreach · Positive reply ($0)");

    const first = buildBudgetChangeEmail(
      novemiq({
        firstBudget: true,
        changes: [{ featureSlug: COLD, offerId: OFFER, legKey: HERALD_LEG, previousDailyBudgetCents: "0", newDailyBudgetCents: "700" }],
      })
    );
    expect(first.subject).toBe("NOVEMIQ set a first budget: Sales Cold Email Outreach · Positive reply $7/day");
  });

  it("a paused mission is listed with its kept amount and not counted", () => {
    const email = buildBudgetChangeEmail(
      novemiq({
        spendable: spendable([
          { slug: COLD, leg: HERALD_LEG, cents: 700, running: false },
          { slug: MEET, leg: PILOT_LEG, cents: 300, running: true },
        ]),
      })
    );
    expect(email.summaryText).toContain("Daily spend now: $0/day");
    expect(email.summaryText).toContain("Paused (amount kept, not spending)");
    expect(email.summaryText).toMatch(/Sales Cold Email Outreach · Positive reply · .*: \$7\/day kept/);
  });

  it("an unreadable campaign-service states no total and says why", () => {
    const email = buildBudgetChangeEmail(novemiq({ spendable: null }));
    expect(email.summaryText).toContain("Daily spend now: unavailable");
    expect(email.summaryText).toContain("Campaign statuses could not be read");
    expect(email.summaryText).toContain("Funded, status unknown");
  });

  it("an unreadable catalogue never classifies or sums, and says so", () => {
    const email = buildBudgetChangeEmail(novemiq({ catalogue: null }));
    expect(email.summaryText).toContain("The channel catalogue (features-service) could not be read");
    expect(email.summaryText).toContain("Daily spend now: $0/day");
    expect(email.summaryText).toContain("not counting 2 running missions we could not classify");
    expect(email.subject).toContain("sales-cold-email-outreach · leg start_to_conversation (channel catalogue unavailable)");
    expect(email.subject).not.toMatch(/crew/i);
  });

  it("unreadable names are stated in words, never guessed", () => {
    const email = buildBudgetChangeEmail(
      novemiq({ brandName: null, org: null, offerNames: null })
    );
    expect(email.subject.startsWith("A brand ")).toBe(true);
    expect(email.summaryText).toContain("offer name unavailable (e59646e4)");
    expect(email.summaryText).toContain("The brand name could not be read");
    expect(email.summaryText).toContain("The org name could not be read");
    expect(email.summaryText).toContain("No admin console link");
  });

  it("escapes names in the HTML part", () => {
    const email = buildBudgetChangeEmail(novemiq({ brandName: "<b>X</b>" }));
    expect(email.summaryHtml).not.toContain("<b>X</b>");
    expect(email.summaryHtml).toContain("&lt;b&gt;X&lt;/b&gt;");
  });
});

describe("buildBudgetChangeEmail — a person paused or restarted a mission", () => {
  const herald = { featureSlug: COLD, offerId: OFFER, legKey: HERALD_LEG };

  it("a pause is the same email: the move, then the state after it", () => {
    const email = buildBudgetChangeEmail(
      novemiq({
        changes: [],
        statusChanges: [{ ...herald, move: "paused" }],
        spendable: spendable([
          { slug: COLD, leg: HERALD_LEG, cents: 700, running: false },
          { slug: MEET, leg: PILOT_LEG, cents: 300, running: true },
        ]),
      })
    );
    expect(email.subject).toBe("NOVEMIQ paused Sales Cold Email Outreach · Positive reply ($7/day kept)");
    expect(email.action).toBe("paused a mission");
    const changed = email.summaryText.split("What changed\n")[1].split("\n\n")[0];
    expect(changed).toBe(
      '- Sales Cold Email Outreach · Positive reply · offer "Growth": paused ($7/day kept)'
    );
    expect(email.summaryText).toContain("Daily spend now: $0/day (no daily mission is running)");
    expect(email.summaryText).toContain(
      'AI Meeting Booking · Positive reply → Meeting booked · offer "Growth": $3 cap'
    );
    expect(email.summaryText).toMatch(/Paused \(amount kept, not spending\)\n- Sales Cold Email Outreach · Positive reply · .*: \$7\/day kept/);
    expect(`${email.subject}${email.summaryText}`).not.toMatch(/\$10\b|—/);
  });

  it("a restart says restarted and counts the mission again", () => {
    const email = buildBudgetChangeEmail(
      novemiq({ changes: [], statusChanges: [{ ...herald, move: "restarted" }] })
    );
    expect(email.subject).toBe("NOVEMIQ restarted Sales Cold Email Outreach · Positive reply ($7/day)");
    expect(email.action).toBe("restarted a mission");
    expect(email.summaryText).toContain('offer "Growth": restarted ($7/day)');
    expect(email.summaryText).toContain("Daily spend now: $7/day");
    expect(email.summaryText).not.toContain("Paused (amount kept");
  });

  it("a paused reactive mission keeps its cap wording", () => {
    const email = buildBudgetChangeEmail(
      novemiq({
        changes: [],
        statusChanges: [{ featureSlug: MEET, offerId: OFFER, legKey: PILOT_LEG, move: "paused" }],
      })
    );
    expect(email.subject).toBe("NOVEMIQ paused AI Meeting Booking · Positive reply → Meeting booked ($3 cap kept)");
  });

  it("a mission with no ceiling says so, and an unreadable ceiling read is stated", () => {
    const email = buildBudgetChangeEmail(
      novemiq({
        changes: [],
        statusChanges: [{ ...herald, move: "restarted" }],
        ceilings: [],
        ceilingsUnavailable: true,
      })
    );
    expect(email.subject).toBe("NOVEMIQ restarted Sales Cold Email Outreach · Positive reply (no budget set, so it cannot spend)");
    expect(email.summaryText).toContain("The mission budgets could not be read from billing");
  });

  it("a budget write still reads as a budget change", () => {
    expect(buildBudgetChangeEmail(novemiq()).action).toBe("changed a daily budget");
  });
});
