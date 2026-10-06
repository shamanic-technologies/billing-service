import { describe, it, expect } from "vitest";
import {
  buildBudgetChangeEmail,
  formatMoney,
  shortChannelName,
  type BudgetChangeEmailInput,
} from "../../src/lib/budget-change-email.js";
import { channelCatalogueFrom } from "../../src/lib/budget-change-context.js";
import type { SpendableBudget } from "../../src/lib/campaign-service-client.js";

const COLD = "sales-cold-email-outreach";
const MEET = "ai-meeting-booking";
const COLD_LEG = "start_to_conversation";
const WEB_LEG = "start_to_website_visit";
const MEET_LEG = "conversation_to_meeting_booked";

// Shaped like the live features-service GET /public/channels (2026-10-06).
// Legacy crewName values are present on purpose: they must never surface.
const catalogue = channelCatalogueFrom([
  {
    slug: COLD,
    name: "Sales Cold Email Outreach",
    stepTransitions: [
      { legKey: COLD_LEG, from: null, to: { label: "Positive reply" }, crewName: "Herald" },
      { legKey: WEB_LEG, from: null, to: { label: "Website visit" }, crewName: null },
    ],
  },
  {
    slug: MEET,
    name: "AI Meeting Booking",
    stepTransitions: [
      {
        legKey: MEET_LEG,
        from: { label: "Positive reply", shortDescription: "Replies they're interested" },
        to: { label: "Meeting booked" },
        crewName: "Pilot",
      },
    ],
  },
] as Parameters<typeof channelCatalogueFrom>[0]);

function spendableOf(
  brandId: string,
  orgId: string,
  offerId: string,
  rows: Array<{ slug: string; leg: string; cents: number; running: boolean }>
): SpendableBudget {
  return {
    orgId,
    brandId,
    grain: "campaign",
    configuredDailyBudgetCents: rows.reduce((s, r) => s + r.cents, 0),
    runningDailyBudgetCents: rows.filter((r) => r.running).reduce((s, r) => s + r.cents, 0),
    campaigns: [],
    rows: rows.map((r) => ({
      featureSlug: r.slug,
      offerId,
      legKey: r.leg,
      resolvedOfferId: offerId,
      dailyBudgetCents: r.cents,
      running: r.running,
      campaignId: null,
      campaignStatus: r.running ? "ongoing" : "stopped",
    })),
  };
}

const allText = (e: { subject: string; action: string; summaryText: string; summaryHtml: string }) =>
  `${e.subject}\n${e.action}\n${e.summaryText}\n${e.summaryHtml}`;

// --- The prod case (2026-10-06, brand Legistai) --------------------------------
// The cold-email campaign was stopped; the subscriber plan reallocation DELETED
// its 330-cent ceiling in the same second. Only AI meeting booking remains, a
// reactive 30-cent/day cap. The old email said "$3/day kept" (a row already gone)
// and "$0 cap" (30 cents rounded away), listed the mission twice under four
// headings.
const L_BRAND = "7d9cc3d9-15ec-4357-bfe9-49b17dadb90c";
const L_ORG = "fc600ac6-d6d4-4086-861d-fe12683d0637";
const L_OFFER = "0f1e2d3c-4b5a-4697-8877-665544332211";
const L_CLERK = "org_legistai";

function legistai(overrides: Partial<BudgetChangeEmailInput> = {}): BudgetChangeEmailInput {
  return {
    brandId: L_BRAND,
    orgId: L_ORG,
    firstBudget: false,
    changes: [],
    statusChanges: [{ featureSlug: COLD, offerId: L_OFFER, legKey: COLD_LEG, move: "paused" }],
    // As billing holds them AFTER the move: the cold-email row is gone.
    ceilings: [{ featureSlug: MEET, offerId: L_OFFER, legKey: MEET_LEG, dailyBudgetCents: "30.0000000000" }],
    brandName: "Legistai",
    org: { name: "Legistai", externalId: L_CLERK },
    offerNames: new Map([[L_OFFER, "LegistAI"]]),
    catalogue,
    spendable: spendableOf(L_BRAND, L_ORG, L_OFFER, [{ slug: MEET, leg: MEET_LEG, cents: 30, running: true }]),
    ...overrides,
  };
}

describe("buildBudgetChangeEmail: the Legistai pause", () => {
  const email = buildBudgetChangeEmail(legistai());

  it("renders the owner's shape, exactly", () => {
    expect(email.subject).toBe("Legistai: sales cold email outreach paused");
    expect(email.action).toBe("paused sales cold email outreach (offer LegistAI)");
    expect(email.summaryText).toBe(
      [
        "Spending now: $0/day.",
        "Still on: AI meeting booking, up to $0.30/day, only when someone replies they're interested.",
        "",
        `Open in admin: https://admin.distribute.you/orgs/${L_CLERK}/brands/${L_BRAND}`,
        `Org Legistai · Brand id ${L_BRAND} · Org id ${L_ORG}`,
      ].join("\n")
    );
    expect(email.summaryHtml).toContain('>Open in admin</a>');
    expect(email.summaryHtml).toContain('<p style="color:#888;font-size:12px">Org Legistai');
  });

  it("never states an amount billing no longer holds, never prints $0 for 30 cents", () => {
    const body = allText(email);
    expect(body).not.toMatch(/kept/);
    expect(body).not.toMatch(/\$3\b|\$3\/day|\$3\.30/);
    expect(body).not.toMatch(/\$0 cap|up to \$0\/day/);
  });

  it("names each mission once, no jargon headings, no arrows, no em dash", () => {
    const body = `${email.action}\n${email.summaryText}`;
    expect(body.match(/sales cold email outreach/g)).toHaveLength(1);
    expect(body.match(/AI meeting booking/g)).toHaveLength(1);
    expect(allText(email)).not.toMatch(/What changed|Reactive caps|Paused \(amount|→|—|Herald|Pilot|crew/);
  });

  it("when billing still holds the paused row (no reallocation), the kept amount is true and stated once", () => {
    const kept = buildBudgetChangeEmail(
      legistai({
        ceilings: [
          { featureSlug: COLD, offerId: L_OFFER, legKey: COLD_LEG, dailyBudgetCents: "330" },
          { featureSlug: MEET, offerId: L_OFFER, legKey: MEET_LEG, dailyBudgetCents: "30" },
        ],
        spendable: spendableOf(L_BRAND, L_ORG, L_OFFER, [
          { slug: COLD, leg: COLD_LEG, cents: 330, running: false },
          { slug: MEET, leg: MEET_LEG, cents: 30, running: true },
        ]),
      })
    );
    expect(kept.action).toBe("paused sales cold email outreach (offer LegistAI), $3.30/day budget kept");
    expect(kept.summaryText).not.toContain("Paused, budget kept");
    expect(`${kept.action}\n${kept.summaryText}`.match(/sales cold email outreach/g)).toHaveLength(1);
  });

  it("a restart names the amount it restarts at", () => {
    const restart = buildBudgetChangeEmail(
      legistai({
        statusChanges: [{ featureSlug: COLD, offerId: L_OFFER, legKey: COLD_LEG, move: "restarted" }],
        ceilings: [
          { featureSlug: COLD, offerId: L_OFFER, legKey: COLD_LEG, dailyBudgetCents: "300" },
          { featureSlug: MEET, offerId: L_OFFER, legKey: MEET_LEG, dailyBudgetCents: "30" },
        ],
        spendable: spendableOf(L_BRAND, L_ORG, L_OFFER, [
          { slug: COLD, leg: COLD_LEG, cents: 300, running: true },
          { slug: MEET, leg: MEET_LEG, cents: 30, running: true },
        ]),
      })
    );
    expect(restart.subject).toBe("Legistai: sales cold email outreach restarted");
    expect(restart.action).toBe("restarted sales cold email outreach (offer LegistAI) at $3/day");
    expect(restart.summaryText.split("\n")[0]).toBe("Spending now: $3/day.");
  });

  it("a restart with no budget says it cannot spend", () => {
    const restart = buildBudgetChangeEmail(
      legistai({ statusChanges: [{ featureSlug: COLD, offerId: L_OFFER, legKey: COLD_LEG, move: "restarted" }] })
    );
    expect(restart.action).toBe(
      "restarted sales cold email outreach (offer LegistAI), with no budget set so it cannot spend"
    );
  });
});

describe("formatMoney: sub-dollar amounts keep their cents", () => {
  it.each([
    ["0", "$0"],
    ["30", "$0.30"],
    ["30.0000000000", "$0.30"],
    ["5", "$0.05"],
    ["0.4", "under $0.01"],
    ["330", "$3.30"],
    ["700", "$7"],
    ["21000", "$210"],
    ["1250.5", "$12.51"],
  ])("%s cents → %s", (cents, expected) => {
    expect(formatMoney(cents)).toBe(expected);
  });

  it("short channel names come from the catalogue, lowercased, acronyms kept", () => {
    expect(shortChannelName("Sales Cold Email Outreach")).toBe("sales cold email outreach");
    expect(shortChannelName("AI Meeting Booking")).toBe("AI meeting booking");
  });
});

// --- Budget writes (raise / lower), same shape --------------------------------
// NOVEMIQ 2026-09-29: cold email $10 -> $7/day, AI meeting booking a $3 reactive
// cap. The old email summed them ("$13/day → $10/day").
const N_BRAND = "933d4abb-9695-4fcb-b3aa-354d61565798";
const N_ORG = "22ffb00a-b7da-4453-9bf2-1784c2d2bf9e";
const N_OFFER = "e59646e4-e351-462d-a8a7-618098e7e5c1";

function novemiq(overrides: Partial<BudgetChangeEmailInput> = {}): BudgetChangeEmailInput {
  return {
    brandId: N_BRAND,
    orgId: N_ORG,
    firstBudget: false,
    changes: [
      { featureSlug: COLD, offerId: N_OFFER, legKey: COLD_LEG, previousDailyBudgetCents: "1000.0000000000", newDailyBudgetCents: "700.0000000000" },
    ],
    ceilings: [
      { featureSlug: COLD, offerId: N_OFFER, legKey: COLD_LEG, dailyBudgetCents: "700.0000000000" },
      { featureSlug: MEET, offerId: N_OFFER, legKey: MEET_LEG, dailyBudgetCents: "300.0000000000" },
    ],
    brandName: "NOVEMIQ",
    org: { name: "NOVEMIQ", externalId: "org_3JxXPgCKdCsyikm3KwmuWKcEu05" },
    offerNames: new Map([[N_OFFER, "Growth"]]),
    catalogue,
    spendable: spendableOf(N_BRAND, N_ORG, N_OFFER, [
      { slug: COLD, leg: COLD_LEG, cents: 700, running: true },
      { slug: MEET, leg: MEET_LEG, cents: 300, running: true },
    ]),
    ...overrides,
  };
}

describe("buildBudgetChangeEmail: a lower and a raise", () => {
  it("a lower: the mission with before and after, the daily total, the reactive cap apart", () => {
    const email = buildBudgetChangeEmail(novemiq());
    expect(email.subject).toBe("NOVEMIQ: sales cold email outreach lowered to $7/day");
    expect(email.action).toBe("lowered sales cold email outreach (offer Growth) from $10/day to $7/day");
    expect(email.summaryText.split("\n").slice(0, 2)).toEqual([
      "Spending now: $7/day.",
      "Still on: AI meeting booking, up to $3/day, only when someone replies they're interested.",
    ]);
    const body = allText(email);
    expect(body).not.toMatch(/\$13\b|\$10\/day\./);
    expect(body).not.toMatch(/Running:|Configured:|—|→/);
  });

  it("a raise, with another running daily mission folded into the total and named once", () => {
    const email = buildBudgetChangeEmail(
      novemiq({
        changes: [
          { featureSlug: COLD, offerId: N_OFFER, legKey: COLD_LEG, previousDailyBudgetCents: "700", newDailyBudgetCents: "1000" },
        ],
        ceilings: [
          { featureSlug: COLD, offerId: N_OFFER, legKey: COLD_LEG, dailyBudgetCents: "1000" },
          { featureSlug: COLD, offerId: N_OFFER, legKey: WEB_LEG, dailyBudgetCents: "250" },
          { featureSlug: MEET, offerId: N_OFFER, legKey: MEET_LEG, dailyBudgetCents: "300" },
        ],
        spendable: spendableOf(N_BRAND, N_ORG, N_OFFER, [
          { slug: COLD, leg: COLD_LEG, cents: 1000, running: true },
          { slug: COLD, leg: WEB_LEG, cents: 250, running: true },
          { slug: MEET, leg: MEET_LEG, cents: 300, running: true },
        ]),
      })
    );
    // Two legs on one channel: the outcome tells them apart.
    expect(email.subject).toBe("NOVEMIQ: sales cold email outreach (positive reply) raised to $10/day");
    expect(email.action).toBe(
      "raised sales cold email outreach (positive reply, offer Growth) from $7/day to $10/day"
    );
    expect(email.summaryText.split("\n")[0]).toBe(
      "Spending now: $12.50/day, with sales cold email outreach (website visit) at $2.50/day."
    );
    expect(email.summaryText).not.toContain("$13");
  });

  it("a paused mission not touched by this write is listed once with its kept amount, not counted", () => {
    const email = buildBudgetChangeEmail(
      novemiq({
        changes: [
          { featureSlug: MEET, offerId: N_OFFER, legKey: MEET_LEG, previousDailyBudgetCents: "300", newDailyBudgetCents: "500" },
        ],
        ceilings: [
          { featureSlug: COLD, offerId: N_OFFER, legKey: COLD_LEG, dailyBudgetCents: "700" },
          { featureSlug: MEET, offerId: N_OFFER, legKey: MEET_LEG, dailyBudgetCents: "500" },
        ],
        spendable: spendableOf(N_BRAND, N_ORG, N_OFFER, [
          { slug: COLD, leg: COLD_LEG, cents: 700, running: false },
          { slug: MEET, leg: MEET_LEG, cents: 500, running: true },
        ]),
      })
    );
    expect(email.action).toBe("raised AI meeting booking (offer Growth) from up to $3/day to up to $5/day");
    expect(email.summaryText.split("\n").slice(0, 2)).toEqual([
      "Spending now: $0/day.",
      "Paused, budget kept: sales cold email outreach $7/day.",
    ]);
    expect(`${email.action}\n${email.summaryText}`.match(/AI meeting booking/g)).toHaveLength(1);
  });

  it("a first budget and a drop to zero", () => {
    const first = buildBudgetChangeEmail(
      novemiq({
        firstBudget: true,
        changes: [{ featureSlug: COLD, offerId: N_OFFER, legKey: COLD_LEG, previousDailyBudgetCents: "0", newDailyBudgetCents: "700" }],
      })
    );
    expect(first.subject).toBe("NOVEMIQ: first budget, sales cold email outreach to $7/day");
    expect(first.action).toBe("set sales cold email outreach (offer Growth) to $7/day");

    const zero = buildBudgetChangeEmail(
      novemiq({
        changes: [{ featureSlug: COLD, offerId: N_OFFER, legKey: COLD_LEG, previousDailyBudgetCents: "700", newDailyBudgetCents: "0" }],
        ceilings: [{ featureSlug: MEET, offerId: N_OFFER, legKey: MEET_LEG, dailyBudgetCents: "300" }],
      })
    );
    expect(zero.subject).toBe("NOVEMIQ: sales cold email outreach lowered to $0/day");
    expect(zero.summaryText.split("\n")[0]).toBe("Spending now: $0/day.");
  });

  it("several changes: one action line naming each, the subject lists them", () => {
    const email = buildBudgetChangeEmail(
      novemiq({
        changes: [
          { featureSlug: COLD, offerId: N_OFFER, legKey: COLD_LEG, previousDailyBudgetCents: "1000", newDailyBudgetCents: "700" },
          { featureSlug: MEET, offerId: N_OFFER, legKey: MEET_LEG, previousDailyBudgetCents: "0", newDailyBudgetCents: "300" },
        ],
      })
    );
    expect(email.subject).toBe("NOVEMIQ: sales cold email outreach and AI meeting booking changed");
    expect(email.action).toBe(
      "lowered sales cold email outreach (offer Growth) from $10/day to $7/day; set AI meeting booking (offer Growth) to up to $3/day"
    );
    expect(email.summaryText).not.toContain("Still on");
  });
});

describe("buildBudgetChangeEmail: unreadable sources are said, never guessed", () => {
  it("no campaign statuses: no total, the budgets listed as status unknown", () => {
    const email = buildBudgetChangeEmail(novemiq({ spendable: null }));
    expect(email.summaryText.split("\n").slice(0, 2)).toEqual([
      "Spending now: unknown, campaign statuses could not be read.",
      "Budgets set, status unknown: AI meeting booking up to $3/day.",
    ]);
  });

  it("no catalogue: slugs, nothing classified or summed, and says so", () => {
    const email = buildBudgetChangeEmail(novemiq({ catalogue: null }));
    expect(email.action).toBe(
      "lowered sales-cold-email-outreach (leg start_to_conversation, offer Growth) from $10 to $7"
    );
    expect(email.summaryText).toContain(
      "Spending now: $0/day, not counting ai-meeting-booking (leg conversation_to_meeting_booked) $3 (running, could not be classified), not counting the mission above (running, could not be classified)."
    );
    expect(email.summaryText).toContain("The channel catalogue could not be read");
  });

  it("no names: brand, offer and org are stated as unavailable", () => {
    const email = buildBudgetChangeEmail(novemiq({ brandName: null, org: null, offerNames: null }));
    expect(email.subject.startsWith("A brand: ")).toBe(true);
    expect(email.action).toContain("(offer e59646e4, name unavailable)");
    expect(email.summaryText).toContain("The brand name could not be read.");
    expect(email.summaryText).toContain("No admin link");
    expect(email.summaryText).toContain("Org name unavailable · Brand id");
  });

  it("an unreadable ceiling read is stated, no amount invented", () => {
    const email = buildBudgetChangeEmail(
      legistai({ ceilings: [], ceilingsUnavailable: true, statusChanges: [{ featureSlug: COLD, offerId: L_OFFER, legKey: COLD_LEG, move: "restarted" }] })
    );
    expect(email.action).toBe("restarted sales cold email outreach (offer LegistAI)");
    expect(email.summaryText).toContain("The budgets could not be read from billing");
  });

  it("escapes customer-typed names in the HTML parts", () => {
    const email = buildBudgetChangeEmail(
      legistai({ brandName: "<b>X</b>", org: { name: "<i>O</i>", externalId: L_CLERK }, offerNames: new Map([[L_OFFER, "<s>Y</s>"]]) })
    );
    expect(email.summaryHtml).not.toMatch(/<b>X<\/b>|<i>O<\/i>/);
    expect(email.summaryHtml).toContain("&lt;i&gt;O&lt;/i&gt;");
    expect(email.actionHtml).toBe("paused sales cold email outreach (offer &lt;s&gt;Y&lt;/s&gt;)");
  });
});
