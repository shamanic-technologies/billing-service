import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchWithRetry } from "../../src/lib/fetch-retry.js";

/** Build the error shape Node's fetch throws for a connect-phase reset. */
function fetchFailed(code: string): Error {
  const cause = Object.assign(new Error(`read ${code}`), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

/** happy-eyeballs AggregateError: code on the top error + per-address sub-errors. */
function aggregateTimeout(): Error {
  const sub = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  const agg = Object.assign(new AggregateError([sub], "fetch failed"), {
    code: "ETIMEDOUT",
  });
  return Object.assign(new TypeError("fetch failed"), { cause: agg });
}

function ok(): Response {
  return new Response("ok", { status: 200 });
}

describe("fetchWithRetry", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns the response without retry on first success", async () => {
    fetchMock.mockResolvedValue(ok());

    const res = await fetchWithRetry("http://x/y");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient ECONNRESET then succeeds", async () => {
    fetchMock
      .mockRejectedValueOnce(fetchFailed("ECONNRESET"))
      .mockResolvedValueOnce(ok());

    const p = fetchWithRetry("http://x/y");
    await vi.runAllTimersAsync();
    const res = await p;

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a happy-eyeballs AggregateError ETIMEDOUT", async () => {
    fetchMock.mockRejectedValueOnce(aggregateTimeout()).mockResolvedValueOnce(ok());

    const p = fetchWithRetry("http://x/y");
    await vi.runAllTimersAsync();
    const res = await p;

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 retries (4 attempts) and rethrows the transient error", async () => {
    fetchMock.mockRejectedValue(fetchFailed("ECONNREFUSED"));

    const p = fetchWithRetry("http://x/y");
    const assertion = expect(p).rejects.toThrow("fetch failed");
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does NOT retry a non-transient error", async () => {
    const boom = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }),
    });
    fetchMock.mockRejectedValue(boom);

    await expect(fetchWithRetry("http://x/y")).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a completed HTTP 5xx response (real answer, may have side-effected)", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 502 }));

    const res = await fetchWithRetry("http://x/y");

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
