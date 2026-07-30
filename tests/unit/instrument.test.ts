import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  BILLING_EMAIL_TEMPLATE_NAMES,
  deployEmailTemplates,
} from "../../src/instrument.js";

const URL_VAR = "TRANSACTIONAL_EMAIL_SERVICE_URL";
const KEY_VAR = "TRANSACTIONAL_EMAIL_SERVICE_API_KEY";

function configure() {
  process.env[URL_VAR] = "http://localhost:9995";
  process.env[KEY_VAR] = "test-email-service-key";
}

describe("boot-time email template registration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env[URL_VAR];
    delete process.env[KEY_VAR];
  });

  afterEach(() => {
    delete process.env[URL_VAR];
    delete process.env[KEY_VAR];
  });

  // The whole point of this module: it was an orphan for months, so billing had
  // registered nothing and every send 404'd in the email service.
  it("is wired into the boot path", () => {
    const boot = readFileSync(resolve(__dirname, "../../src/index.ts"), "utf-8");
    expect(boot).toContain('from "./instrument.js"');
    expect(boot).toContain("deployEmailTemplates()");
  });

  it("registers the staff daily-budget template under the exact event key", async () => {
    configure();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await deployEmailTemplates();

    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // The api-key-only cold-start route — no fake all-zero user identity.
    expect(url).toBe("http://localhost:9995/platform-templates");
    expect(options.method).toBe("PUT");
    expect(
      (options.headers as Record<string, string>)["x-user-id"]
    ).toBeUndefined();

    const { templates } = JSON.parse(options.body as string);
    const budget = templates.find(
      (t: { name: string }) => t.name === "brand_daily_budget_changed"
    );
    expect(budget).toBeDefined();
    for (const field of ["subject", "htmlBody", "textBody"] as const) {
      expect(typeof budget[field]).toBe("string");
      expect(budget[field].length).toBeGreaterThan(0);
    }
  });

  it("registers every event billing actually sends, and nothing dead", async () => {
    // credits-depleted was dropped: no sender remains (dunning sends the
    // dashboard-owned credit-depleted family instead).
    expect(BILLING_EMAIL_TEMPLATE_NAMES).toEqual([
      "credits-reload-failed",
      "brand_daily_budget_changed",
    ]);
  });

  it("skips silently when the email service is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(deployEmailTemplates()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws when the email service rejects or errors", async () => {
    configure();

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(deployEmailTemplates()).resolves.toBeUndefined();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("boom", { status: 500 })
    );
    await expect(deployEmailTemplates()).resolves.toBeUndefined();
  });
});
