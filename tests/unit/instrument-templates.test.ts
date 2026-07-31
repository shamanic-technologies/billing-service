import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  deployEmailTemplates,
  REGISTERED_TEMPLATE_NAMES,
} from "../../src/instrument.js";
import { BRAND_DAILY_BUDGET_CHANGED_EVENT } from "../../src/lib/brand-budget-notification.js";
import {
  REFERRAL_REWARD_OPENED_EVENT,
  REFERRAL_CREDITS_GRANTED_EVENT,
} from "../../src/lib/referral-notifications.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const ENV_URL = "TRANSACTIONAL_EMAIL_SERVICE_URL";
const ENV_KEY = "TRANSACTIONAL_EMAIL_SERVICE_API_KEY";

function lastBody(fetchMock: ReturnType<typeof vi.fn>): {
  templates: { name: string; subject: string; htmlBody: string; textBody?: string }[];
} {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("boot-time email template registration", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const savedUrl = process.env[ENV_URL];
  const savedKey = process.env[ENV_KEY];

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ templates: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env[ENV_URL] = "http://email.test";
    process.env[ENV_KEY] = "k";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (savedUrl === undefined) delete process.env[ENV_URL];
    else process.env[ENV_URL] = savedUrl;
    if (savedKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedKey;
  });

  // AC1 — the registration is actually WIRED into the server entrypoint. The
  // whole bug was a module nothing imported, so this asserts the call site
  // exists and sits after listen(), which no behavioural test can see.
  it("is invoked from the server entrypoint, after app.listen()", () => {
    const index = readFileSync(resolve(HERE, "../../src/index.ts"), "utf-8");

    expect(index).toContain('from "./instrument.js"');
    expect(index).toContain("deployEmailTemplates()");
    expect(index.indexOf("deployEmailTemplates()")).toBeGreaterThan(
      index.indexOf("app.listen("),
    );
    // Never awaited: a cold/unreachable email service must not delay boot.
    expect(index).not.toMatch(/await\s+deployEmailTemplates\(/);
  });

  it("upserts every template this service sends, with the service identity headers", async () => {
    const ok = await deployEmailTemplates();

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://email.test/templates");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["x-org-id"]).toBe("00000000-0000-0000-0000-000000000000");
    expect(headers["x-user-id"]).toBe("00000000-0000-0000-0000-000000000000");
    expect(headers["x-run-id"]).toBe("00000000-0000-0000-0000-000000000000");

    const names = lastBody(fetchMock).templates.map((t) => t.name);
    expect(names).toEqual([
      "credits-reload-failed",
      BRAND_DAILY_BUDGET_CHANGED_EVENT,
      REFERRAL_REWARD_OPENED_EVENT,
      REFERRAL_CREDITS_GRANTED_EVENT,
    ]);
    expect(names).toEqual(REGISTERED_TEMPLATE_NAMES);
  });

  // AC4 — no template for an event this service never sends. `credits-depleted`
  // was declared here for months with zero senders (the dunning engine sends
  // `credit-depleted`, singular, and the dashboard owns that template).
  it("registers nothing for an event no code path sends", async () => {
    await deployEmailTemplates();

    const names = lastBody(fetchMock).templates.map((t) => t.name);
    expect(names).not.toContain("credits-depleted");
    for (const name of names) expect(name.startsWith("credit-depleted")).toBe(false);
  });

  it("sends a non-empty subject and html body per template (the PUT rejects blanks)", async () => {
    await deployEmailTemplates();

    for (const t of lastBody(fetchMock).templates) {
      expect(t.subject.length).toBeGreaterThan(0);
      expect(t.htmlBody.length).toBeGreaterThan(0);
      expect((t.textBody ?? "").length).toBeGreaterThan(0);
    }
  });

  // AC3 — restart twice sends the identical payload; the receiving PUT upserts
  // by name, so there is no duplicate and no local "already registered" marker.
  it("is idempotent across restarts — same payload, no local marker state", async () => {
    await deployEmailTemplates();
    const first = lastBody(fetchMock);
    await deployEmailTemplates();
    const second = lastBody(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });

  // AC2 — every failure mode of the sibling is harmless to this process.
  it("never throws when the email service is unreachable", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause }));

    await expect(deployEmailTemplates()).resolves.toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it("never throws when the email service errors", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(deployEmailTemplates()).resolves.toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it("never throws when the call times out", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }),
    );

    await expect(deployEmailTemplates()).resolves.toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it("bounds the call with an abort signal so a hung sibling cannot leak", async () => {
    await deployEmailTemplates();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("warns loudly and skips when the email service is not configured", async () => {
    delete process.env[ENV_URL];

    await expect(deployEmailTemplates()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  // Guard: a template name must stay byte-equal to the eventType the sender
  // passes to transactional-email-service, which resolves by name == eventType.
  it("keeps every registered name byte-equal to a real sendEmail eventType", () => {
    const balance = readFileSync(
      resolve(HERE, "../../src/routes/customer_balance.ts"),
      "utf-8",
    );
    expect(balance).toContain('eventType: "credits-reload-failed"');
    expect(REGISTERED_TEMPLATE_NAMES).toContain(BRAND_DAILY_BUDGET_CHANGED_EVENT);
    // The referral senders import their names from the same constants the
    // templates are keyed on, so the row and the eventType cannot drift.
    expect(REGISTERED_TEMPLATE_NAMES).toContain(REFERRAL_REWARD_OPENED_EVENT);
    expect(REGISTERED_TEMPLATE_NAMES).toContain(REFERRAL_CREDITS_GRANTED_EVENT);
  });

  it("interpolates only variables the senders actually supply", async () => {
    // A template variable the sender never sets renders as a literal
    // `{{placeholder}}` in a customer's inbox. The referral senders build every
    // one of these, including the two that stand in for a failed identity
    // lookup, so the set here and the set they emit must match exactly.
    await deployEmailTemplates();
    const templates = lastBody(fetchMock).templates;
    const varsOf = (name: string) => {
      const t = templates.find((x) => x.name === name)!;
      return new Set(
        [...`${t.subject} ${t.htmlBody} ${t.textBody}`.matchAll(/\{\{(\w+)\}\}/g)].map(
          (m) => m[1],
        ),
      );
    };

    expect(varsOf(REFERRAL_REWARD_OPENED_EVENT)).toEqual(
      new Set(["amount", "unlockAt", "referredOrg"]),
    );
    // The landed message carries WHO converted inside {{reason}}, which the
    // sender composes: the two sides of a referral earned the same amount for
    // opposite reasons, and only one of them has a third party to name.
    expect(varsOf(REFERRAL_CREDITS_GRANTED_EVENT)).toEqual(
      new Set(["amount", "reason"]),
    );

    const sender = readFileSync(
      resolve(HERE, "../../src/lib/referral-notifications.ts"),
      "utf-8",
    );
    for (const v of ["amount", "unlockAt", "referredOrg", "reason"]) {
      expect(sender).toContain(`${v}:`);
    }
  });

  it("uses no em-dash in customer-facing referral copy", async () => {
    await deployEmailTemplates();
    for (const t of lastBody(fetchMock).templates) {
      if (!t.name.startsWith("referral")) continue;
      expect(t.subject).not.toContain("—");
      expect(t.textBody).not.toContain("—");
      expect(t.htmlBody).not.toContain("—");
    }
  });
});
