/**
 * The floors table is a local copy of features-service's list, so it goes stale
 * the moment that service publishes a channel nobody mirrors here. The refusal
 * stays loud; what this adds is that the gap is REPORTED on boot instead of
 * discovered by the customer who tried to fund the channel.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import {
  unpricedChannelSlugs,
  auditChannelCoverage,
} from "../../src/lib/channel-coverage.js";
import { ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS } from "../../src/lib/brand-funnel-budgets.js";

const priced = Object.keys(ACQUISITION_CHANNEL_MIN_DAILY_BUDGET_CENTS);

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FEATURES_SERVICE_URL;
});

describe("published acquisition-channel coverage", () => {
  it("names every published slug this service prices no floor for", () => {
    expect(
      unpricedChannelSlugs([
        { slug: priced[0] },
        { slug: "zeppelin-outreach" },
        { slug: "carrier-pigeon-outreach" },
      ])
    ).toEqual(["carrier-pigeon-outreach", "zeppelin-outreach"]);
  });

  it("reports nothing when the whole published catalogue is priced", () => {
    expect(unpricedChannelSlugs(priced.map((slug) => ({ slug })))).toEqual([]);
  });

  it("logs the gap loudly and returns it, without changing any refusal", async () => {
    process.env.FEATURES_SERVICE_URL = "http://features-service:8080";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            channels: [{ slug: priced[0] }, { slug: "zeppelin-outreach" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    await expect(auditChannelCoverage()).resolves.toEqual([
      "zeppelin-outreach",
    ]);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("zeppelin-outreach")
    );
  });

  it("returns null — NOT 'nothing unpriced' — when the catalogue cannot be read", async () => {
    process.env.FEATURES_SERVICE_URL = "http://features-service:8080";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("features-service unreachable");
      })
    );

    await expect(auditChannelCoverage()).resolves.toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it("says so rather than staying silent when it is not configured to audit", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(auditChannelCoverage()).resolves.toBeNull();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("FEATURES_SERVICE_URL")
    );
  });

  it("is fired from boot AFTER the port is bound, and never awaited", () => {
    // A behavioural test cannot see "nobody calls this module" — which is the
    // bug that left the email-template registration dead for months.
    const index = readFileSync("src/index.ts", "utf-8");
    const listenAt = index.indexOf("app.listen(");
    const callAt = index.indexOf("auditChannelCoverage()");
    expect(listenAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(listenAt);
    expect(index).toContain("void auditChannelCoverage();");
    expect(index).not.toContain("await auditChannelCoverage()");
  });
});
