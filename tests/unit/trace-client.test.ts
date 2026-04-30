import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { traceEvent } from "../../src/lib/trace-client.js";

describe("traceEvent", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.RUNS_SERVICE_URL = "http://localhost:9997";
    process.env.RUNS_SERVICE_API_KEY = "test-runs-key";
  });

  it("POSTs to /v1/runs/{runId}/events with event and detail", () => {
    mockFetch.mockResolvedValue({ ok: true });

    traceEvent({
      runId: "run-abc",
      orgId: "org-1",
      userId: "user-1",
      event: "provision.created",
      detail: { amount_cents: 500 },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:9997/v1/runs/run-abc/events");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.event).toBe("provision.created");
    expect(body.detail).toEqual({ amount_cents: 500 });
  });

  it("forwards identity and workflow headers", () => {
    mockFetch.mockResolvedValue({ ok: true });

    traceEvent({
      runId: "run-abc",
      orgId: "org-1",
      userId: "user-1",
      event: "provision.created",
      workflowHeaders: {
        "x-campaign-id": "camp-1",
        "x-brand-id": "brand-1,brand-2",
        "x-workflow-slug": "outreach",
        "x-feature-slug": "email-gen",
      },
    });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-campaign-id"]).toBe("camp-1");
    expect(headers["x-brand-id"]).toBe("brand-1,brand-2");
    expect(headers["x-workflow-slug"]).toBe("outreach");
    expect(headers["x-feature-slug"]).toBe("email-gen");
  });

  it("sends x-api-key from env", () => {
    mockFetch.mockResolvedValue({ ok: true });

    traceEvent({
      runId: "run-abc",
      orgId: "org-1",
      userId: "user-1",
      event: "test.event",
    });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("test-runs-key");
  });

  it("no-ops when RUNS_SERVICE_URL not configured", () => {
    delete process.env.RUNS_SERVICE_URL;

    traceEvent({
      runId: "run-abc",
      orgId: "org-1",
      userId: "user-1",
      event: "test.event",
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("no-ops when runId is missing", () => {
    traceEvent({
      runId: "",
      orgId: "org-1",
      userId: "user-1",
      event: "test.event",
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("swallows fetch errors without throwing", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    traceEvent({
      runId: "run-abc",
      orgId: "org-1",
      userId: "user-1",
      event: "test.event",
    });

    // Let the microtask (catch handler) run
    await new Promise((r) => setTimeout(r, 10));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[billing-service]"),
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });
});
