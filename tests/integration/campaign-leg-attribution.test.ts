/**
 * A ceiling is given the funnel LEG of the campaign it already paces.
 *
 * The leg is READ from that campaign, never derived here, so the two sides match
 * by construction — which is the whole point: a ceiling saying "no leg" beside a
 * campaign saying a leg is what made campaign-service provision a twin campaign
 * on 2026-09-06 and charge five customers twice.
 *
 * Money is the thing this incident is about, so the amount assertions are the
 * load-bearing ones: only `leg_key` may ever change.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db, sql } from "../../src/db/index.js";
import { brandFunnelDailyBudgets } from "../../src/db/schema.js";
import {
  attributeCeilingLeg,
  decideLegAttributions,
  UnknownCampaignFunnelError,
  type CeilingLegTarget,
} from "../../src/lib/campaign-leg-attribution.js";
import type { SpendableBudget } from "../../src/lib/campaign-service-client.js";

const orgId = "00000000-0000-0000-0000-0000000c1e01";
const brandId = "00000000-0000-0000-0000-0000000c1e99";

const COLD = "sales-cold-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";
const OFFER_A = "aaaaaaaa-c1e0-4c1e-8c1e-aaaaaaaaaaaa";

// features-service mints these; billing stores them opaque and never parses them.
const LEG_START = "start_to_conversation";
const LEG_BOOKED = "conversation_to_meeting_booked";

/**
 * campaign-service answers the CANONICAL funnel spelling while this table
 * stores the pre-retirement one — the shape a live prod response has.
 */
const CANONICAL_REPLY_MEETING = "sales_meetings_from_conversation";

function spendable(over: Partial<SpendableBudget> = {}): SpendableBudget {
  return {
    orgId,
    brandId,
    grain: "leg",
    configuredDailyBudgetCents: 0,
    runningDailyBudgetCents: 0,
    campaigns: [],
    rows: [],
    ...over,
  };
}

function campaign(
  campaignId: string,
  featureSlug: string,
  legKey: string | null,
  offerId: string | null = OFFER_A
) {
  return {
    campaignId,
    status: "ongoing",
    running: true,
    funnelKey: CANONICAL_REPLY_MEETING,
    featureSlug,
    offerId,
    legKey,
    configuredDailyBudgetCents: 0,
    runningDailyBudgetCents: 0,
  };
}

function row(
  featureSlug: string,
  campaignId: string | null,
  offerId: string | null = OFFER_A,
  legKey: string | null = null
) {
  return {
    funnelKey: CANONICAL_REPLY_MEETING,
    featureSlug,
    offerId,
    legKey,
    resolvedOfferId: offerId,
    dailyBudgetCents: 0,
    running: true,
    campaignId,
    campaignStatus: campaignId ? "ongoing" : null,
  };
}

async function seedCeiling(
  featureSlug: string,
  dailyBudgetCents: string,
  offerId: string | null = OFFER_A,
  legKey: string | null = null
): Promise<void> {
  await db.insert(brandFunnelDailyBudgets).values({
    orgId,
    brandId,
    funnelKey: "reply_meeting",
    featureSlug,
    offerId,
    legKey,
    dailyBudgetCents,
  });
}

async function readCeilings() {
  return sql<
    {
      feature_slug: string;
      offer_id: string | null;
      leg_key: string | null;
      daily_budget_cents: string;
      updated_at: string;
    }[]
  >`
    SELECT feature_slug, offer_id, leg_key, daily_budget_cents,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS updated_at
      FROM brand_funnel_daily_budgets
     WHERE org_id = ${orgId} AND brand_id = ${brandId}
     ORDER BY feature_slug
  `;
}

const target = (over: Partial<CeilingLegTarget> = {}): CeilingLegTarget => ({
  funnelKey: "reply_meeting",
  featureSlug: COLD,
  offerId: OFFER_A,
  legKey: LEG_START,
  campaignId: "cmp-1",
  campaignStatus: "ongoing",
  ...over,
});

describe("attributing a campaign's leg to the ceiling it paces", () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("reads the leg off the campaign standing behind the ceiling, resolving the canonical funnel spelling", () => {
    const decisions = decideLegAttributions(
      spendable({
        campaigns: [campaign("cmp-1", COLD, LEG_START)],
        rows: [row(COLD, "cmp-1")],
      })
    );

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      attribute: true,
      target: {
        funnelKey: "reply_meeting",
        featureSlug: COLD,
        offerId: OFFER_A,
        legKey: LEG_START,
        campaignId: "cmp-1",
      },
    });
  });

  it("leaves a ceiling alone when no campaign stands behind it, when the campaign states no leg, and when it already carries one", () => {
    const decisions = decideLegAttributions(
      spendable({
        campaigns: [
          campaign("cmp-legless", FEEDBACK, null),
          campaign("cmp-ok", "third-channel", LEG_BOOKED, null),
        ],
        rows: [
          row(COLD, null),
          row(FEEDBACK, "cmp-legless"),
          row("third-channel", "cmp-ok", null, LEG_BOOKED),
          row("fourth-channel", "cmp-absent"),
        ],
      })
    );

    expect(decisions.map((d) => d.attribute)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(decisions.map((d) => "reason" in d && d.reason)).toEqual([
      "no campaign stands behind this ceiling — left alone",
      "campaign cmp-legless states no leg — left alone",
      "already carries a leg",
      "campaign cmp-absent is absent from the same response — left alone",
    ]);
  });

  it("throws on a funnel spelling neither side can name, rather than skipping it", () => {
    expect(() =>
      decideLegAttributions(
        spendable({
          campaigns: [campaign("cmp-1", COLD, LEG_START)],
          rows: [{ ...row(COLD, "cmp-1"), funnelKey: "invented_funnel" }],
        })
      )
    ).toThrow(UnknownCampaignFunnelError);
  });

  it("writes ONLY the leg — the amount and the timestamp are untouched to the cent and the microsecond", async () => {
    await sql`
      INSERT INTO brand_funnel_daily_budgets (org_id, brand_id, funnel_key, feature_slug, offer_id, daily_budget_cents, updated_at)
      VALUES (${orgId}, ${brandId}, 'reply_meeting', ${COLD}, ${OFFER_A}, '14000.0000000000', '2026-08-05 13:31:32.764549+00')
    `;

    const outcome = await attributeCeilingLeg(orgId, brandId, target());

    expect(outcome).toEqual({
      applied: true,
      dailyBudgetCentsBefore: "14000.0000000000",
      dailyBudgetCentsAfter: "14000.0000000000",
      legKey: LEG_START,
    });

    const [stored] = await readCeilings();
    expect(stored.leg_key).toBe(LEG_START);
    expect(stored.daily_budget_cents).toBe("14000.0000000000");
    expect(stored.updated_at).toBe("2026-08-05 13:31:32.764549");
  });

  it("attributes an UNSCOPED (offer-less) ceiling, which `= NULL` would silently miss", async () => {
    await seedCeiling(FEEDBACK, "1000.0000000000", null);

    const outcome = await attributeCeilingLeg(
      orgId,
      brandId,
      target({ featureSlug: FEEDBACK, offerId: null })
    );

    expect(outcome).toMatchObject({ applied: true, legKey: LEG_START });
    const [stored] = await readCeilings();
    expect(stored.leg_key).toBe(LEG_START);
    expect(stored.daily_budget_cents).toBe("1000.0000000000");
  });

  it("is a no-op on a second run — the ceiling is selected leg-less", async () => {
    await seedCeiling(COLD, "500.0000000000");

    await attributeCeilingLeg(orgId, brandId, target());
    const second = await attributeCeilingLeg(orgId, brandId, target());

    expect(second).toEqual({
      applied: false,
      reason:
        "no leg-less ceiling at that grain — already attributed, or removed since the read",
    });

    const stored = await readCeilings();
    expect(stored).toHaveLength(1);
    expect(stored[0].leg_key).toBe(LEG_START);
    expect(stored[0].daily_budget_cents).toBe("500.0000000000");
  });

  it("refuses rather than colliding when a ceiling at that grain already carries the leg", async () => {
    await seedCeiling(COLD, "500.0000000000", OFFER_A, null);
    await seedCeiling(COLD, "300.0000000000", OFFER_A, LEG_START);

    const outcome = await attributeCeilingLeg(orgId, brandId, target());

    expect(outcome).toEqual({
      applied: false,
      reason: `a ceiling at that grain already carries leg "${LEG_START}" — left alone`,
    });

    const stored = await readCeilings();
    expect(stored).toHaveLength(2);
    expect(stored.map((s) => s.daily_budget_cents).sort()).toEqual([
      "300.0000000000",
      "500.0000000000",
    ]);
  });
});
