/**
 * WHICH referral earned this $500.
 *
 * A referrer holding three pending referral promises otherwise reads three identical
 * rows. billing is the only service that knows the referral relationship exists, so
 * it is the only one that can legitimately turn the other org's id into something a
 * person recognises — and it reveals a name and a domain, nothing else.
 *
 * Own file, not a `describe` appended to referral-promises.test.ts: that suite closes
 * the shared postgres.js connection in `afterAll` (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestPromoGrant,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import * as runsClient from "../../src/lib/runs-client.js";
import * as brandClient from "../../src/lib/brand-service-client.js";
import { claimReferral } from "../../src/lib/free-credit-promises.js";

const inviter = "00000000-0000-0000-0000-0000000006a1";
const invitee = "00000000-0000-0000-0000-0000000006a2";
const invitee2 = "00000000-0000-0000-0000-0000000006a3";
const userId = "00000000-0000-0000-0000-0000000006a9";

const cents = (n: number) => `${n}.0000000000`;

async function newSignup(orgId: string) {
  await insertTestAccount({
    orgId,
    welcomeCompletionEligible: true,
    freeCreditEntitlementCents: 40000,
    freeCreditPaidTriggerCents: 40000,
  });
  await insertTestPromoGrant({ orgId, userId, amountCents: 500, promoCode: "welcome" });
}

/** An inviter holding two pending $500s, one per referred org. */
async function inviterWithTwoConvertedReferrals() {
  await newSignup(inviter);
  await claimReferral(invitee, inviter);
  await claimReferral(invitee2, inviter);
}

describe("referral promises carry the referred org's display identity", () => {
  const app = createTestApp();
  let ssMocks: ReturnType<typeof setupStripeMocks>;
  let resolveIdentity: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
    resolveIdentity = vi
      .spyOn(brandClient, "resolveOrgDisplayIdentity")
      .mockResolvedValue(null);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("names each pending $500 after the referral that earned it, with a domain for the logo", async () => {
    await inviterWithTwoConvertedReferrals();
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(45000));
    resolveIdentity.mockImplementation(async (orgId: string) =>
      orgId === invitee
        ? { name: "Acme", domain: "acme.com" }
        : { name: "Globex", domain: "globex.io" }
    );

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(inviter));

    expect(res.status).toBe(200);
    const referrals = res.body.promises.filter(
      (p: { kind: string }) => p.kind === "referral"
    );
    expect(
      referrals.map((p: Record<string, unknown>) => [
        p.referred_org_id,
        p.referred_org_name,
        p.referred_org_domain,
      ])
    ).toEqual([
      [invitee, "Acme", "acme.com"],
      [invitee2, "Globex", "globex.io"],
    ]);
  });

  it("resolves each distinct org exactly once, whatever the promise count", async () => {
    await inviterWithTwoConvertedReferrals();
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(45000));

    await request(app).get("/v1/free-credit-promises").set(getAuthHeaders(inviter));

    expect(resolveIdentity).toHaveBeenCalledTimes(2);
    expect(resolveIdentity.mock.calls.map((c) => c[0]).sort()).toEqual(
      [invitee, invitee2].sort()
    );
  });

  it("still serves the promise, amounts intact, when the identity cannot be resolved", async () => {
    await newSignup(inviter);
    await claimReferral(invitee, inviter);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(25000));
    resolveIdentity.mockResolvedValue(null);

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(inviter));

    expect(res.status).toBe(200);
    const [promise] = res.body.promises.filter(
      (p: { kind: string }) => p.kind === "referral"
    );
    expect(promise.amount_cents).toBe(cents(50000));
    expect(promise.paid_trigger_cents).toBe(cents(50000));
    expect(promise.progress_pct).toBe(50);
    // Null, never a name invented from the UUID.
    expect(promise.referred_org_name).toBeNull();
    expect(promise.referred_org_domain).toBeNull();
  });

  it("a promise with no referral counterpart carries nothing new", async () => {
    await newSignup(invitee);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(10000));

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(invitee));

    expect(res.status).toBe(200);
    const [welcome] = res.body.promises;
    expect(welcome.kind).toBe("welcome");
    expect(welcome.referred_org_id).toBeNull();
    expect(welcome).not.toHaveProperty("referred_org_name");
    expect(welcome).not.toHaveProperty("referred_org_domain");
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("the referee holds no referral promise, so nobody is looked up for it", async () => {
    await newSignup(invitee);
    await claimReferral(invitee, inviter);
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue(cents(10000));

    const res = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(invitee));

    expect(
      res.body.promises.filter((p: { kind: string }) => p.kind === "referral")
    ).toEqual([]);
    expect(resolveIdentity).not.toHaveBeenCalled();
  });
});
