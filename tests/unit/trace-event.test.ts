import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { traceEvent } from "../../src/lib/trace-event.js";

describe("traceEvent", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.RUNS_SERVICE_URL = "http://runs:3000";
    process.env.RUNS_SERVICE_API_KEY = "runs-key";
  });

  afterEach(() => {
    process.env.RUNS_SERVICE_URL = ORIG_ENV.RUNS_SERVICE_URL;
    process.env.RUNS_SERVICE_API_KEY = ORIG_ENV.RUNS_SERVICE_API_KEY;
  });

  it("POSTs to /v1/runs/{runId}/events with correct body", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await traceEvent(
      "run-123",
      { service: "billing-service", event: "credits.deducted", detail: "50 cents" },
      { "x-org-id": "org-1", "x-user-id": "user-1" }
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://runs:3000/v1/runs/run-123/events");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      service: "billing-service",
      event: "credits.deducted",
      detail: "50 cents",
    });
  });

  it("forwards all identity headers", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await traceEvent(
      "run-123",
      { service: "billing-service", event: "test" },
      {
        "x-org-id": "org-1",
        "x-user-id": "user-1",
        "x-brand-id": "brand-1",
        "x-campaign-id": "camp-1",
        "x-workflow-slug": "wf-slug",
        "x-feature-slug": "feat-slug",
      }
    );

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("runs-key");
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-brand-id"]).toBe("brand-1");
    expect(headers["x-campaign-id"]).toBe("camp-1");
    expect(headers["x-workflow-slug"]).toBe("wf-slug");
    expect(headers["x-feature-slug"]).toBe("feat-slug");
  });

  it("omits undefined identity headers", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await traceEvent(
      "run-123",
      { service: "billing-service", event: "test" },
      { "x-org-id": "org-1" }
    );

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers).not.toHaveProperty("x-user-id");
    expect(headers).not.toHaveProperty("x-brand-id");
  });

  it("skips silently when RUNS_SERVICE_URL is not set", async () => {
    delete process.env.RUNS_SERVICE_URL;

    await traceEvent(
      "run-123",
      { service: "billing-service", event: "test" },
      {}
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips silently when RUNS_SERVICE_API_KEY is not set", async () => {
    delete process.env.RUNS_SERVICE_API_KEY;

    await traceEvent(
      "run-123",
      { service: "billing-service", event: "test" },
      {}
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never throws even when fetch rejects", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));

    await expect(
      traceEvent(
        "run-123",
        { service: "billing-service", event: "test" },
        {}
      )
    ).resolves.toBeUndefined();
  });

  it("sends level and data when provided", async () => {
    mockFetch.mockResolvedValue({ ok: true });

    await traceEvent(
      "run-123",
      {
        service: "billing-service",
        event: "reload.failed",
        level: "error",
        data: { amount: 500 },
      },
      { "x-org-id": "org-1" }
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.level).toBe("error");
    expect(body.data).toEqual({ amount: 500 });
  });
});
