import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch BEFORE importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Now import the module — it will pick up the stubbed fetch
import { resolveAppKey } from "../../src/lib/key-client.js";

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
