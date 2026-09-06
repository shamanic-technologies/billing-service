/**
 * A daily ceiling per (funnel, ACQUISITION-CHANNEL feature slug).
 *
 * The same sales funnel can be worked through two offers at once, each its own
 * campaign, so each is funded on its own money. What every existing consumer
 * reads — the brand-wide figure and the per-funnel figure — keeps its shape and
 * answers the SUM of what sits underneath.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const orgId = "00000000-0000-0000-0000-00000000cc01";
const userId = "00000000-0000-0000-0000-00000000cc99";
const runId = "00000000-0000-0000-0000-00000000ccbb";
const brandId = "00000000-0000-0000-0000-0000000ccb01";

const COLD = "sales-cold-email-outreach";
const CRM = "sales-crm-email-outreach";
const FEEDBACK = "feedback-request-cold-email-outreach";

const internalHeaders = { "X-API-Key": "test-api-key", "x-org-id": orgId };
const brandReadPath = `/internal/brands/${brandId}/daily-budget`;
const funnelReadPath = `/internal/brands/${brandId}/funnel-budgets`;
const funnelSetPath = `/v1/brands/${brandId}/funnel-budgets`;
const funnelOnePath = (key: string) =>
  `/v1/brands/${brandId}/funnel-budgets/${key}`;

type FunnelRow = { funnelKey: string; dailyBudgetCents: string };
type ChannelRow = FunnelRow & { featureSlug: string };

const app = createTestApp();

async function read() {
  const res = await request(app).get(funnelReadPath).set(internalHeaders);
  return {
    brandTotal: res.body.dailyBudgetCents as string | null,
    funnels: (res.body.funnels as FunnelRow[]).map(
      (f) => [f.funnelKey, f.dailyBudgetCents] as const
    ),
    channels: (res.body.channels as ChannelRow[]).map(
      (c) => [c.funnelKey, c.featureSlug, c.dailyBudgetCents] as const
    ),
  };
}

describe("per-acquisition-channel daily ceilings", () => {
  const authHeaders = getAuthHeaders(orgId, userId, runId);

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  // --- Several channels under one funnel ---

  it("funds one funnel through two channels and answers their sum", async () => {
    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 3000,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: FEEDBACK,
            dailyBudgetCents: 2000,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("5000.0000000000");

    const stored = await read();
    expect(stored.funnels).toEqual([["reply_meeting", "5000.0000000000"]]);
    expect(stored.channels).toEqual([
      ["reply_meeting", FEEDBACK, "2000.0000000000"],
      ["reply_meeting", COLD, "3000.0000000000"],
    ]);

    // The brand-wide read every consumer already uses is the same total.
    const brandRead = await request(app)
      .get(brandReadPath)
      .set(internalHeaders);
    expect(brandRead.body.dailyBudgetCents).toBe("5000.0000000000");
  });

  it("sums across funnels AND channels for the brand-wide figure", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 2400,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: CRM,
            dailyBudgetCents: 1000,
          },
          {
            funnelKey: "visit_form",
            featureSlug: COLD,
            dailyBudgetCents: 800,
          },
        ],
      });

    const stored = await read();
    expect(stored.brandTotal).toBe("4200.0000000000");
    expect(stored.funnels).toEqual([
      ["reply_meeting", "3400.0000000000"],
      ["visit_form", "800.0000000000"],
    ]);
  });

  it("states one pair without disturbing its siblings", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 3000,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: FEEDBACK,
            dailyBudgetCents: 2000,
          },
        ],
      });

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: FEEDBACK, dailyBudgetCents: 900 });
    expect(res.status).toBe(200);

    const stored = await read();
    expect(stored.channels).toEqual([
      ["reply_meeting", FEEDBACK, "900.0000000000"],
      ["reply_meeting", COLD, "3000.0000000000"],
    ]);
    expect(stored.funnels).toEqual([["reply_meeting", "3900.0000000000"]]);
  });

  it("0 is legal at the channel grain, and a wholly-zero set is a pause", async () => {
    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "reply_meeting", featureSlug: COLD, dailyBudgetCents: 0 },
          {
            funnelKey: "reply_meeting",
            featureSlug: FEEDBACK,
            dailyBudgetCents: 0,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("0.0000000000");

    const one = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: FEEDBACK, dailyBudgetCents: 0 });
    expect(one.status).toBe(200);
  });

  it("the whole-set write removes a channel absent from the body", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 3000,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: FEEDBACK,
            dailyBudgetCents: 2000,
          },
        ],
      });

    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 3000,
          },
        ],
      });

    const stored = await read();
    expect(stored.channels).toEqual([["reply_meeting", COLD, "3000.0000000000"]]);
    expect(stored.funnels).toEqual([["reply_meeting", "3000.0000000000"]]);
  });

  // --- Callers that speak per funnel only (everything before this shipped) ---

  it("a first-ever funnel-grain write lands on the default channel", async () => {
    const res = await request(app)
      .patch(funnelOnePath("visit_form"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 800 });
    expect(res.status).toBe(200);

    const stored = await read();
    expect(stored.channels).toEqual([["visit_form", COLD, "800.0000000000"]]);
  });

  it("a funnel-grain write re-funds the channel the funnel already runs", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_signup", featureSlug: CRM, dailyBudgetCents: 800 },
        ],
      });

    const res = await request(app)
      .patch(funnelOnePath("visit_signup"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 900 });
    expect(res.status).toBe(200);

    // No second channel opened, and the money stayed on the CRM offer.
    const stored = await read();
    expect(stored.channels).toEqual([["visit_signup", CRM, "900.0000000000"]]);
  });

  it("refuses (409) a funnel-grain write against a funnel split across channels", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 3000,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: FEEDBACK,
            dailyBudgetCents: 2000,
          },
        ],
      });

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ dailyBudgetCents: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(COLD);

    // Nothing moved.
    const stored = await read();
    expect(stored.funnels).toEqual([["reply_meeting", "5000.0000000000"]]);
  });

  it("rejects one funnel stated both with and without a channel in one set", async () => {
    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 3000,
          },
          { funnelKey: "reply_meeting", dailyBudgetCents: 2000 },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("rejects the same pair twice in one set, and accepts the same channel on two funnels", async () => {
    const dup = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: COLD, dailyBudgetCents: 100 },
          { funnelKey: "visit_form", featureSlug: COLD, dailyBudgetCents: 200 },
        ],
      });
    expect(dup.status).toBe(400);

    const ok = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "visit_form", featureSlug: COLD, dailyBudgetCents: 800 },
          {
            funnelKey: "visit_signup",
            featureSlug: COLD,
            dailyBudgetCents: 800,
          },
        ],
      });
    expect(ok.status).toBe(200);
    expect(ok.body.dailyBudgetCents).toBe("1600.0000000000");
  });

  // --- The minimum binds the (funnel, CHANNEL) TOTAL ---

  it("accepts a split across two channels, each clearing its own floor", async () => {
    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 1200,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: FEEDBACK,
            dailyBudgetCents: 1200,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("2400.0000000000");
  });

  it("refuses the one channel under ITS floor, whatever its siblings fund", async () => {
    // Cold email clears its $8/day; the feedback channel at $5/day does not, and
    // a sibling channel's money cannot excuse it — the two never pool.
    const res = await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 5000,
          },
          {
            funnelKey: "reply_meeting",
            featureSlug: FEEDBACK,
            dailyBudgetCents: 500,
          },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(FEEDBACK);
    expect(res.body.error).toContain("$8/day");
  });

  it("splits a funded funnel in two without tripping the minimum", async () => {
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          {
            funnelKey: "reply_meeting",
            featureSlug: COLD,
            dailyBudgetCents: 5000,
          },
        ],
      });

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: FEEDBACK, dailyBudgetCents: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.dailyBudgetCents).toBe("6000.0000000000");
  });

  it("refuses adding a channel funded under its own floor", async () => {
    // The channel is judged alone: $5/day is under cold email's $8/day floor,
    // and the sibling channel sitting at 0 has nothing to lend it.
    await request(app)
      .put(funnelSetPath)
      .set(authHeaders)
      .send({
        funnels: [
          { funnelKey: "reply_meeting", featureSlug: COLD, dailyBudgetCents: 0 },
        ],
      });

    const res = await request(app)
      .patch(funnelOnePath("reply_meeting"))
      .set(authHeaders)
      .send({ featureSlug: FEEDBACK, dailyBudgetCents: 500 });
    expect(res.status).toBe(400);
  });
});
