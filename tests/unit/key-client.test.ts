import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch BEFORE importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Now import the module — it will pick up the stubbed fetch
import { resolveProviderKey } from "../../src/lib/key-client.js";

describe("resolveProviderKey", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends correct URL with orgId and userId query params", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "sk_test_123", keySource: "platform" }),
    });

    const result = await resolveProviderKey("stripe", "org-uuid-abc", "user-uuid-123", {
      service: "billing",
      method: "GET",
      path: "/v1/accounts",
    });

    expect(result).toEqual({ key: "sk_test_123", keySource: "platform" });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/keys/stripe/decrypt?");
    expect(url).toContain("orgId=org-uuid-abc");
    expect(url).toContain("userId=user-uuid-123");
  });

  it("sends x-caller-service, x-caller-method, x-caller-path headers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "sk_test_123", keySource: "org" }),
    });

    await resolveProviderKey("stripe", "org-123", "user-456", {
      service: "billing",
      method: "POST",
      path: "/v1/credits/deduct",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-caller-service": "billing",
          "x-caller-method": "POST",
          "x-caller-path": "/v1/credits/deduct",
        }),
      })
    );
  });

  it("uses default caller context when none provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "sk_test_456", keySource: "platform" }),
    });

    await resolveProviderKey("stripe", "org-123", "user-456");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
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

    await expect(resolveProviderKey("stripe", "org-unknown", "user-123")).rejects.toThrow(
      "Failed to resolve stripe key for org org-unknown: 404"
    );
  });

  it("returns keySource 'org' when org key is used", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "sk_org_key", keySource: "org" }),
    });

    const result = await resolveProviderKey("stripe", "org-123", "user-456");
    expect(result.keySource).toBe("org");
  });

  it("encodes provider name in URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "whsec_123", keySource: "platform" }),
    });

    await resolveProviderKey("stripe-webhook", "org-123", "user-456");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/keys/stripe-webhook/decrypt?");
  });

  it("sends x-api-key header", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "sk_test", keySource: "platform" }),
    });

    await resolveProviderKey("stripe", "org-123", "user-456");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "test-key-service-key",
        }),
      })
    );
  });
});
