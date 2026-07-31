/**
 * The referral display-identity lookup.
 *
 * Two invariants carry the whole feature: it never throws (a promise is the
 * money-bearing information and must survive a failed lookup) and it never
 * fabricates (a placeholder name is worse than no name).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveOrgDisplayIdentity } from "../../src/lib/brand-service-client.js";

const ORG = "00000000-0000-0000-0000-0000000009a1";

function brandsResponse(brands: unknown[]): Response {
  return new Response(JSON.stringify({ brands }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveOrgDisplayIdentity", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("BRAND_SERVICE_URL", "http://brand.internal");
    vi.stubEnv("BRAND_SERVICE_API_KEY", "brand-key");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads the org's own brands with service auth and the org id — no user sentinel", async () => {
    fetchMock.mockResolvedValue(
      brandsResponse([
        { id: "b1", name: "Acme", domain: "acme.com", createdAt: "2026-01-01T00:00:00Z" },
      ])
    );

    const identity = await resolveOrgDisplayIdentity(ORG);

    expect(identity).toEqual({ name: "Acme", domain: "acme.com" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://brand.internal/orgs/brands");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("brand-key");
    expect(headers["x-org-id"]).toBe(ORG);
    expect(headers["x-user-id"]).toBeUndefined();
  });

  it("prefers a brand with a domain, and among those the oldest — so the row does not rename itself", async () => {
    fetchMock.mockResolvedValue(
      brandsResponse([
        { id: "b3", name: "Newest", domain: "newest.com", createdAt: "2026-06-01T00:00:00Z" },
        { id: "b1", name: "Founding", domain: "founding.com", createdAt: "2026-01-01T00:00:00Z" },
        { id: "b2", name: "Older no-site", domain: null, createdAt: "2025-01-01T00:00:00Z" },
      ])
    );

    expect(await resolveOrgDisplayIdentity(ORG)).toEqual({
      name: "Founding",
      domain: "founding.com",
    });
  });

  it("falls back to the oldest brand overall so a no-website org still gets its name", async () => {
    fetchMock.mockResolvedValue(
      brandsResponse([
        { id: "b2", name: "Later", domain: null, createdAt: "2026-05-01T00:00:00Z" },
        { id: "b1", name: "First", domain: null, createdAt: "2026-01-01T00:00:00Z" },
      ])
    );

    expect(await resolveOrgDisplayIdentity(ORG)).toEqual({ name: "First", domain: null });
  });

  it("returns null rather than an empty identity when the brand has neither name nor domain", async () => {
    fetchMock.mockResolvedValue(
      brandsResponse([{ id: "b1", name: "  ", domain: "", createdAt: null }])
    );

    expect(await resolveOrgDisplayIdentity(ORG)).toBeNull();
  });

  it("returns null when the org has no brand at all — never a fabricated placeholder", async () => {
    fetchMock.mockResolvedValue(brandsResponse([]));

    expect(await resolveOrgDisplayIdentity(ORG)).toBeNull();
  });

  it("returns null on a brand-service error status instead of throwing", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(resolveOrgDisplayIdentity(ORG)).resolves.toBeNull();
  });

  it("returns null when brand-service is unreachable instead of throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(resolveOrgDisplayIdentity(ORG)).resolves.toBeNull();
  });

  it("returns null, and calls nothing, when brand-service is not configured", async () => {
    vi.stubEnv("BRAND_SERVICE_URL", "");
    vi.stubEnv("BRAND_SERVICE_API_KEY", "");

    expect(await resolveOrgDisplayIdentity(ORG)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
