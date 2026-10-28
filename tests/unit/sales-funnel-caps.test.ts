import { describe, it, expect } from "vitest";
import {
  isOutcomePipe,
  itemTaskOf,
  ITEM_TASKS,
  periodWindow,
  REACTIVE_ITEM_TASKS,
  volumeUnitOf,
} from "../../src/lib/sales-funnel-caps.js";
import {
  salesFunnelFromDetail,
  SalesFunnelCatalogueUnavailableError,
} from "../../src/lib/sales-funnel-catalogue.js";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe("periodWindow (UTC)", () => {
  const since = new Date("2026-09-20T08:00:00.000Z");

  it("daily = the UTC calendar day", () => {
    const w = periodWindow("daily", since, new Date("2026-10-10T13:45:00.000Z"));
    expect([iso(w.start), iso(w.end)]).toEqual(["2026-10-10T00:00:00.000Z", "2026-10-11T00:00:00.000Z"]);
  });

  it("weekly starts Monday 00:00 (a Saturday, a Sunday, a Monday)", () => {
    // 2026-10-10 is a Saturday.
    const sat = periodWindow("weekly", since, new Date("2026-10-10T13:45:00.000Z"));
    expect([iso(sat.start), iso(sat.end)]).toEqual(["2026-10-05T00:00:00.000Z", "2026-10-12T00:00:00.000Z"]);
    const sun = periodWindow("weekly", since, new Date("2026-10-11T23:59:59.000Z"));
    expect(iso(sun.start)).toBe("2026-10-05T00:00:00.000Z");
    const mon = periodWindow("weekly", since, new Date("2026-10-12T00:00:00.000Z"));
    expect([iso(mon.start), iso(mon.end)]).toEqual(["2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z"]);
  });

  it("monthly = the UTC calendar month", () => {
    const w = periodWindow("monthly", since, new Date("2026-12-31T23:00:00.000Z"));
    expect([iso(w.start), iso(w.end)]).toEqual(["2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
  });

  it("one_off counts from when the cap was stated and never ends", () => {
    const w = periodWindow("one_off", since, new Date("2026-10-10T13:45:00.000Z"));
    expect([iso(w.start), iso(w.end)]).toEqual(["2026-09-20T08:00:00.000Z", null]);
  });
});

describe("salesFunnelFromDetail", () => {
  // Shaped exactly like features-service's prod answer (2026-10-10, "Epiphany").
  const epiphany = {
    object: "sales_funnel",
    id: "lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client",
    name: "Epiphany",
    legs: [
      {
        legKey: "lead_found_to_website_visit",
        pipe: { id: "sales-cold-email-outreach|lead_found_to_website_visit", name: "Lumen", mode: "proactive" },
      },
      { legKey: "website_visit_to_purchase", pipe: null },
      { legKey: "purchase_to_paid_client", pipe: null },
    ],
  };

  it("reads the pipes, skipping legs nothing of ours performs", () => {
    expect(salesFunnelFromDetail(epiphany.id, epiphany)).toEqual({
      id: epiphany.id,
      name: "Epiphany",
      type: null,
      pipes: [
        {
          pipeId: "sales-cold-email-outreach|lead_found_to_website_visit",
          channelSlug: "sales-cold-email-outreach",
          legKey: "lead_found_to_website_visit",
          strategyId: null,
          mode: "proactive",
          toStep: null,
        },
      ],
      triggerSlug: null,
      triggerName: null,
    });
  });

  it("reads a non-default PLAY's pipe on its bare leg, the strategy apart (Doc Dinners Catalyze)", () => {
    const catalyze = {
      ...epiphany,
      id: "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach~valid-catch-all+conversation_to_paid_client",
      legs: [
        { legKey: "start_to_lead_found", pipe: { id: "lead-sourcing|start_to_lead_found", mode: "proactive" } },
        {
          legKey: "lead_found_to_conversation",
          pipe: { id: "sales-cold-email-outreach|lead_found_to_conversation~valid-catch-all", mode: "proactive" },
        },
      ],
    };
    const pipes = salesFunnelFromDetail(catalyze.id, catalyze).pipes;
    expect(pipes[0]).toMatchObject({ legKey: "start_to_lead_found", strategyId: null });
    expect(pipes[1]).toEqual({
      pipeId: "sales-cold-email-outreach|lead_found_to_conversation~valid-catch-all",
      channelSlug: "sales-cold-email-outreach",
      legKey: "lead_found_to_conversation",
      strategyId: "valid-catch-all",
      mode: "proactive",
      toStep: null,
    });
    expect(() =>
      salesFunnelFromDetail("f", { ...epiphany, legs: [{ legKey: "x", pipe: { id: "a|~s", mode: "proactive" } }] })
    ).toThrow(SalesFunnelCatalogueUnavailableError);
  });

  it("relays the served type; anything else is null (never derived from pipe modes)", () => {
    expect(salesFunnelFromDetail(epiphany.id, { ...epiphany, type: "proactive" }).type).toBe("proactive");
    expect(salesFunnelFromDetail(epiphany.id, { ...epiphany, type: "reactive" }).type).toBe("reactive");
    // A reactive label on a funnel with a proactive pipe is relayed as served, not re-graded.
    expect(salesFunnelFromDetail(epiphany.id, { ...epiphany, type: "Proactive" }).type).toBeNull();
  });

  it("volumeUnitOf: first contacts with a proactive pipe, prospects handled when all reactive", () => {
    const pipe = (mode: "proactive" | "reactive") => ({ pipeId: "a|b", channelSlug: "a", legKey: "b", strategyId: null, mode });
    expect(volumeUnitOf({ pipes: [pipe("reactive"), pipe("proactive")] })).toBe("first_contacts");
    expect(volumeUnitOf({ pipes: [pipe("reactive")] })).toBe("prospects_handled");
  });

  it("volumeUnitOf / isOutcomePipe: outcomes produced only when every proactive pipe is a Start outcome pipe", () => {
    const p = (channelSlug: string, legKey: string, toStep: string | null, mode: "proactive" | "reactive" = "proactive") => ({
      pipeId: `${channelSlug}|${legKey}`,
      channelSlug,
      legKey,
      strategyId: null,
      mode,
      toStep,
    });
    const threads = p("threads-post", "start_to_post_published", "post_published");
    const team = { ...p("your-team-closing-calls", "post_published_to_paid_client", "paid_client"), runByUs: false };
    expect(isOutcomePipe(threads)).toBe(true);
    expect(isOutcomePipe(p("social-post", "start_to_industry_update_video", "industry_update_video"))).toBe(true);
    // The customer's own team pipe (served proactive, runByUs false) is never counted.
    expect(volumeUnitOf({ pipes: [threads, team] })).toBe("outcomes_produced");
    expect(volumeUnitOf({ pipes: [threads, { ...team, runByUs: undefined }] })).toBe("first_contacts");
    // Not a Start pipe, a step no producer is verified on, reactive, or a channel with a run task: never.
    expect(isOutcomePipe(p("cold-whatsapp-outreach", "lead_found_to_conversation", "conversation"))).toBe(false);
    expect(isOutcomePipe(p("cold-x-outreach", "post_published_to_conversation", "post_published"))).toBe(false);
    expect(isOutcomePipe(p("google-ads", "start_to_website_visit", "website_visit"))).toBe(false);
    expect(isOutcomePipe({ ...threads, mode: "reactive" })).toBe(false);
    expect(isOutcomePipe(p("sales-cold-email-outreach", "start_to_post_published", "post_published"))).toBe(false);
    // Mixed with a contact or source pipe: first contacts, as before.
    const source = p("sourcing-apollo-cold-filters", "start_to_lead_found", "lead_found");
    expect(volumeUnitOf({ pipes: [threads, source] })).toBe("first_contacts");
    expect(volumeUnitOf({ pipes: [threads, p("sales-cold-email-outreach", "lead_found_to_conversation", "conversation")] })).toBe(
      "first_contacts"
    );
  });

  it("refuses a pipe id without <channel>|<leg>, a missing mode, or no legs", () => {
    const bad = (pipe: unknown) => ({ ...epiphany, legs: [{ legKey: "x", pipe }] });
    expect(() => salesFunnelFromDetail("f", bad({ id: "no-bar", mode: "proactive" }))).toThrow(
      SalesFunnelCatalogueUnavailableError
    );
    expect(() => salesFunnelFromDetail("f", bad({ id: "a|b" }))).toThrow(SalesFunnelCatalogueUnavailableError);
    expect(() => salesFunnelFromDetail("f", { id: "f" })).toThrow(SalesFunnelCatalogueUnavailableError);
  });
});

describe("itemTaskOf: a pipe's volume measure, declared by step or trigger, never per slug", () => {
  it("a leg ending on email_sent is measured by one instantly email-send-step-1 run, with no channel entry", () => {
    expect(REACTIVE_ITEM_TASKS["email-sending"]).toBeUndefined();
    expect(itemTaskOf({ channelSlug: "email-sending", toStep: "email_sent" }, REACTIVE_ITEM_TASKS, null)).toEqual({
      serviceName: "instantly-service",
      taskName: "email-send-step-1",
    });
  });

  it("a reactive funnel on email_pushed_via_api counts each email sent, whatever step its leg ends on (Email Sending moved to start_to_conversation)", () => {
    expect(itemTaskOf({ channelSlug: "email-sending", toStep: "conversation" }, REACTIVE_ITEM_TASKS, "email_pushed_via_api")).toEqual({
      serviceName: "instantly-service",
      taskName: "email-send-step-1",
    });
  });

  it("a channel entry wins over its step and trigger (cold email's first contact is not its reply)", () => {
    expect(itemTaskOf({ channelSlug: "sales-cold-email-outreach", toStep: "conversation" }, ITEM_TASKS, null)).toBe(
      ITEM_TASKS["sales-cold-email-outreach"]
    );
    expect(
      itemTaskOf({ channelSlug: "ai-meeting-booking", toStep: "meeting_booked" }, REACTIVE_ITEM_TASKS, "positive_reply_received")
    ).toBe(REACTIVE_ITEM_TASKS["ai-meeting-booking"]);
  });

  it("no measure (null, never a guess): a step and a trigger no run is declared for, or nothing served", () => {
    expect(itemTaskOf({ channelSlug: "ai-instant-call", toStep: "meeting_booked" }, REACTIVE_ITEM_TASKS, "form_submitted")).toBeNull();
    expect(itemTaskOf({ channelSlug: "google-ads", toStep: "website_visit" }, ITEM_TASKS, null)).toBeNull();
    expect(itemTaskOf({ channelSlug: "email-sending", toStep: null }, REACTIVE_ITEM_TASKS, null)).toBeNull();
  });
});

describe("salesFunnelFromDetail: the leg's outcome step and the funnel's trigger", () => {
  it("reads legs[].toStep onto the pipe and trigger.slug onto the funnel (prod detail 2026-10-14)", () => {
    const f = salesFunnelFromDetail("start_to_email_sent@email-sending", {
      id: "start_to_email_sent@email-sending",
      name: "Concord",
      type: "reactive",
      trigger: { slug: "email_pushed_via_api", name: "Email Pushed Via API" },
      legs: [
        {
          legKey: "start_to_email_sent",
          fromStep: null,
          toStep: "email_sent",
          pipe: { id: "email-sending|start_to_email_sent", mode: "reactive" },
        },
      ],
    });
    expect(f.triggerSlug).toBe("email_pushed_via_api");
    expect(f.pipes[0].toStep).toBe("email_sent");
  });

  it("absent = null, never invented", () => {
    const f = salesFunnelFromDetail("x", { legs: [{ pipe: { id: "a|b", mode: "reactive" } }] });
    expect(f.triggerSlug).toBeNull();
    expect(f.pipes[0].toStep).toBeNull();
  });
});
