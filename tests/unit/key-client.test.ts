import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch BEFORE importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Now import the module — it will pick up the stubbed fetch
import { resolveAppKey, resolveByokKey, resolvePlatformKey, resolveKey } from "../../src/lib/key-client.js";

describe("resolveAppKey", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends x-caller-service, x-caller-method, x-caller-path headers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "sk_test_123" }),
    });

    await resolveAppKey("stripe", "sales-cold-emails", {
      service: "billing",
      method: "GET",
      path: "/v1/accounts",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/internal/app-keys/stripe/decrypt?appId=sales-cold-emails"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-caller-service": "billing",
          "x-caller-method": "GET",
          "x-caller-path": "/v1/accounts",
        }),
      })
    );
  });

  it("uses default caller context when none provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "sk_test_456" }),
    });

    await resolveAppKey("stripe", "my-app");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("appId=my-app"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-caller-service": "billing",
          "x-caller-method": "GET",
          "x-caller-path": "/v1/accounts",
        }),
      })
    );
  });

  it("throws when key-service returns error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Key not found"),
    });

    await expect(resolveAppKey("stripe", "unknown-app")).rejects.toThrow(
      "Failed to resolve stripe key for app unknown-app: 404"
    );
  });
});

describe("resolveByokKey", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends correct URL with orgId and caller headers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "sk_byok_123" }),
    });

    const key = await resolveByokKey("stripe", "org-uuid-abc", {
      service: "billing",
      method: "POST",
      path: "/v1/credits/deduct",
    });

    expect(key).toBe("sk_byok_123");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/internal/keys/stripe/decrypt?orgId=org-uuid-abc"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-caller-service": "billing",
          "x-caller-method": "POST",
          "x-caller-path": "/v1/credits/deduct",
        }),
      })
    );
  });

  it("throws when key-service returns error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Key not found"),
    });

    await expect(resolveByokKey("stripe", "org-unknown")).rejects.toThrow(
      "Failed to resolve stripe BYOK key for org org-unknown: 404"
    );
  });
});

describe("resolvePlatformKey", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends correct URL with no appId/orgId query param", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "sk_platform_123" }),
    });

    const key = await resolvePlatformKey("stripe", {
      service: "billing",
      method: "GET",
      path: "/v1/accounts",
    });

    expect(key).toBe("sk_platform_123");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/internal/platform-keys/stripe/decrypt"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-caller-service": "billing",
        }),
      })
    );
    // No query params
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain("appId=");
    expect(url).not.toContain("orgId=");
  });

  it("throws when key-service returns error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Key not found"),
    });

    await expect(resolvePlatformKey("stripe")).rejects.toThrow(
      "Failed to resolve stripe platform key: 404"
    );
  });
});

describe("resolveKey (dispatcher)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "sk_resolved" }),
    });
  });

  it("dispatches to app-keys path for keySource 'app'", async () => {
    await resolveKey("stripe", "app", { appId: "my-app" });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/internal/app-keys/stripe/decrypt?appId=my-app");
  });

  it("dispatches to byok path for keySource 'byok'", async () => {
    await resolveKey("stripe", "byok", { orgId: "org-123" });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/internal/keys/stripe/decrypt?orgId=org-123");
  });

  it("dispatches to platform path for keySource 'platform'", async () => {
    await resolveKey("stripe", "platform", {});
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/internal/platform-keys/stripe/decrypt");
  });

  it("throws when keySource is 'app' but appId is missing", async () => {
    await expect(resolveKey("stripe", "app", {})).rejects.toThrow(
      "appId is required for keySource 'app'"
    );
  });

  it("throws when keySource is 'byok' but orgId is missing", async () => {
    await expect(resolveKey("stripe", "byok", {})).rejects.toThrow(
      "orgId is required for keySource 'byok'"
    );
  });
});
