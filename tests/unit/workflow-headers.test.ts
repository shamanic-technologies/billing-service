import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { getWorkflowHeaders, forwardWorkflowHeaders } from "../../src/middleware/auth.js";

function reqWith(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

describe("workflow tracking headers (audience attribution)", () => {
  it("reads x-audience-id inbound alongside the other tracking headers", () => {
    const wf = getWorkflowHeaders(
      reqWith({
        "x-campaign-id": "camp-1",
        "x-brand-id": "brand-1,brand-2",
        "x-workflow-slug": "wf-slug",
        "x-feature-slug": "feat-slug",
        "x-audience-id": "aud-1",
      })
    );

    expect(wf.campaignId).toBe("camp-1");
    expect(wf.brandIds).toEqual(["brand-1", "brand-2"]);
    expect(wf.workflowSlug).toBe("wf-slug");
    expect(wf.featureSlug).toBe("feat-slug");
    expect(wf.audienceId).toBe("aud-1");
  });

  it("forwards x-audience-id on the downstream tracking block", () => {
    const forwarded = forwardWorkflowHeaders({
      campaignId: "camp-1",
      brandIds: ["brand-1"],
      workflowSlug: "wf-slug",
      featureSlug: "feat-slug",
      audienceId: "aud-1",
    });

    expect(forwarded["x-audience-id"]).toBe("aud-1");
    // full block forwarded, not cherry-picked
    expect(forwarded["x-campaign-id"]).toBe("camp-1");
    expect(forwarded["x-brand-id"]).toBe("brand-1");
    expect(forwarded["x-workflow-slug"]).toBe("wf-slug");
    expect(forwarded["x-feature-slug"]).toBe("feat-slug");
  });

  it("inbound x-audience-id round-trips to the egress tracking block", () => {
    const forwarded = forwardWorkflowHeaders(
      getWorkflowHeaders(reqWith({ "x-audience-id": "aud-9" }))
    );
    expect(forwarded["x-audience-id"]).toBe("aud-9");
  });

  it("omits x-audience-id when absent (non-campaign flows), never throws", () => {
    const forwarded = forwardWorkflowHeaders(getWorkflowHeaders(reqWith({})));
    expect(forwarded).not.toHaveProperty("x-audience-id");
  });
});
