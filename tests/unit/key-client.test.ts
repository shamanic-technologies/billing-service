import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch BEFORE importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Now import the module — it will pick up the stubbed fetch
import { resolvePlatformKey } from "../../src/lib/key-client.js";

const TEST_IDENTITY = { orgId: "org-123", userId: "user-456" };

describe("resolvePlatformKey", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("calls GET /keys/platform/{provider}/decrypt with no query params", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "stripe", key: "sk_test_123" }),
    });

    const result = await resolvePlatformKey("stripe", TEST_IDENTITY, {
      service: "billing",
      method: "GET",
      path: "/v1/accounts",
    });

    expect(result).toEqual({ provider: "stripe", key: "sk_test_123" });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/keys/platform/stripe/decrypt");
    expect(url).not.toContain("?"); // no query params
  });

  it("sends x-org-id and x-user-id headers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "stripe", key: "sk_test_123" }),
    });

    await resolvePlatformKey("stripe", TEST_IDENTITY);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-org-id": "org-123",
          "x-user-id": "user-456",
        }),
      })
    );
  });

  it("sends x-caller-service, x-caller-method, x-caller-path headers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "stripe", key: "sk_test_123" }),
    });

    await resolvePlatformKey("stripe", TEST_IDENTITY, {
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
      json: () => Promise.resolve({ provider: "stripe", key: "sk_test_456" }),
    });

    await resolvePlatformKey("stripe", TEST_IDENTITY);

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

    await expect(resolvePlatformKey("stripe", TEST_IDENTITY)).rejects.toThrow(
      "Failed to resolve platform key for stripe: 404"
    );
  });

  it("encodes provider name in URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "stripe-webhook", key: "whsec_123" }),
    });

    await resolvePlatformKey("stripe-webhook", TEST_IDENTITY);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/keys/platform/stripe-webhook/decrypt");
  });

  it("sends x-api-key header", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "stripe", key: "sk_test" }),
    });

    await resolvePlatformKey("stripe", TEST_IDENTITY);

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
