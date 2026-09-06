/**
 * The floors are READ from features-service's published channel catalogue and
 * copied into no table here. A catalogue that cannot be read is not "no floor" —
 * it refuses the write, and a channel whose floor we already knew never loses
 * it because a later refresh failed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  channelMinimumsFrom,
  getChannelMinimums,
  ChannelTermsUnavailableError,
  UnknownAcquisitionChannelError,
  __primeChannelMinimums,
  __resetChannelMinimums,
} from "../../src/lib/channel-terms.js";
import {
  publishedChannelsBody,
  publishedChannelMinimums,
} from "../helpers/channel-catalogue.js";

const realFetch = globalThis.fetch;
const url = "http://localhost:9995";

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe("resolving floors from published terms", () => {
  it("takes the daily operating cost verbatim", () => {
    const minimums = channelMinimumsFrom(publishedChannelsBody().channels);
    expect(minimums.get("sales-cold-email-outreach")).toBe(800);
    expect(minimums.get("google-ads")).toBe(500);
  });

  it("keeps a stated 0 and drops a channel that states nothing", () => {
    const minimums = channelMinimumsFrom([
      { slug: "your-team-closing-calls", terms: { dailyOperatingCostCents: 0 } },
      { slug: "no-terms" },
      { slug: "null-cost", terms: { dailyOperatingCostCents: null } },
      { slug: "", terms: { dailyOperatingCostCents: 100 } },
      { slug: "negative", terms: { dailyOperatingCostCents: -1 } },
    ]);
    expect(minimums.get("your-team-closing-calls")).toBe(0);
    expect(minimums.has("no-terms")).toBe(false);
    expect(minimums.has("null-cost")).toBe(false);
    expect(minimums.has("")).toBe(false);
    expect(minimums.has("negative")).toBe(false);
  });
});

describe("reading the catalogue", () => {
  beforeEach(() => {
    __resetChannelMinimums();
    process.env.FEATURES_SERVICE_URL = url;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetChannelMinimums();
    process.env.FEATURES_SERVICE_URL = url;
    // Leave the suite's own catalogue in place for every later file.
    __primeChannelMinimums(publishedChannelMinimums());
  });

  it("reads the published channels and prices them", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(okResponse(publishedChannelsBody())) as never;
    const minimums = await getChannelMinimums();
    expect(minimums.minimumFor("sales-cold-email-outreach")).toBe(800);
    expect(minimums.slugs()).toContain("google-ads");
  });

  it("throws when features-service is not configured", async () => {
    delete process.env.FEATURES_SERVICE_URL;
    await expect(getChannelMinimums()).rejects.toBeInstanceOf(
      ChannelTermsUnavailableError
    );
  });

  it("throws when the catalogue answers an error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503 } as Response) as never;
    await expect(getChannelMinimums()).rejects.toBeInstanceOf(
      ChannelTermsUnavailableError
    );
  });

  it("throws when the catalogue is unreachable", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as never;
    await expect(getChannelMinimums()).rejects.toBeInstanceOf(
      ChannelTermsUnavailableError
    );
  });

  it("throws when the catalogue carries no priced channel", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(okResponse({ channels: [{ slug: "x" }] })) as never;
    await expect(getChannelMinimums()).rejects.toBeInstanceOf(
      ChannelTermsUnavailableError
    );
  });

  it("refuses a channel the catalogue does not carry, without inventing a floor", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(okResponse(publishedChannelsBody())) as never;
    const minimums = await getChannelMinimums();
    expect(() => minimums.minimumFor("carrier-pigeon-outreach")).toThrow(
      UnknownAcquisitionChannelError
    );
  });

  it("never LOSES a floor it already knew when a refresh fails", async () => {
    __primeChannelMinimums(new Map([["sales-cold-email-outreach", 800]]));
    // The seeded snapshot never expires, so force the refresh path.
    __resetChannelMinimums();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(okResponse(publishedChannelsBody()))
      .mockRejectedValue(new Error("features-service down")) as never;
    await getChannelMinimums();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const stale = await getChannelMinimums();
    expect(stale.minimumFor("sales-cold-email-outreach")).toBe(800);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    vi.useRealTimers();
  });
});
