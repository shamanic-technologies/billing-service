import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getCardSetup,
  cardSetupPersonHeaders,
} from "../../src/lib/stripe-service-client.js";
import { PLATFORM_USER_ID } from "../../src/db/schema.js";

// stripe-service v0.54.0 makes whoever saves a card the Stripe customer's
// contact email, but only when the card-setup call NAMES that person. These
// pin that billing names a real user and never names the platform sentinel.

const ORG = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toContain(`/internal/card_setup/by-org/${ORG}`);
  return init.headers as Record<string, string>;
}

describe("getCardSetup names the person setting the card up", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.STRIPE_SERVICE_URL = "http://stripe-service.test";
    process.env.STRIPE_SERVICE_API_KEY = "test-key";
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: "card_setup", mode: "hosted_redirect" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards x-user-id when the inbound request carries a real user", async () => {
    await getCardSetup(ORG, "https://example.com/return", undefined, undefined, undefined, USER_B);
    expect(sentHeaders(fetchMock)["x-user-id"]).toBe(USER_B);
  });

  it("does not forward the platform sentinel as a person", async () => {
    await getCardSetup(ORG, "https://example.com/return", undefined, undefined, undefined, PLATFORM_USER_ID);
    expect(sentHeaders(fetchMock)).not.toHaveProperty("x-user-id");
  });

  it("sends no x-user-id when no user is on the request", async () => {
    await getCardSetup(ORG, "https://example.com/return");
    expect(sentHeaders(fetchMock)).not.toHaveProperty("x-user-id");
  });

  it("drops anything that is not a user id rather than inventing one", () => {
    expect(cardSetupPersonHeaders("")).toEqual({});
    expect(cardSetupPersonHeaders("not-a-uuid")).toEqual({});
    expect(cardSetupPersonHeaders(undefined)).toEqual({});
    expect(cardSetupPersonHeaders(USER_B)).toEqual({ "x-user-id": USER_B });
  });
});
