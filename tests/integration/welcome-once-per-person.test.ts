import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  welcomeRecipients,
  PLATFORM_USER_ID,
  TRIAL_SEED_CODE,
  TRIAL_SEED_TARGET_CENTS,
  WELCOME_PROMO_CODE,
} from "../../src/db/schema.js";

/**
 * The welcome gift is granted once per PERSON, not once per organisation.
 *
 * A person's first org gets it exactly as before; the same person's second org gets
 * none and its account reads zero free credit — including through the paths that
 * could otherwise hand it the gift later (the welcome completion on payment). The
 * anonymous seed → claim flow still yields exactly one welcome for that person.
 */
describe("welcome once per person", () => {
  const app = createTestApp();
  const person = "11111111-1111-4111-8111-111111111111";
  const otherPerson = "22222222-2222-4222-8222-222222222222";
  const firstOrg = "00000000-0000-0000-0000-0000000000c1";
  const secondOrg = "00000000-0000-0000-0000-0000000000c2";
  const thirdOrg = "00000000-0000-0000-0000-0000000000c3";
  const WELCOME = 3000;
  const ZERO = "0.0000000000";
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
    await db
      .update(localPromoCodes)
      .set({ amountCents: WELCOME })
      .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE));

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: firstOrg,
      spent_cents: ZERO,
      as_of: "2026-09-27T00:00:00.000Z",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: ZERO,
    } as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const account = (orgId: string, userId: string) =>
    request(app).get("/v1/accounts").set(getAuthHeaders(orgId, userId));

  const internal = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };
  const seed = (orgId: string) =>
    request(app).post(`/internal/accounts/by-org/${orgId}/trial-seed`).set(internal);
  const signup = (orgId: string, userId?: string) =>
    request(app)
      .post(`/internal/accounts/by-org/${orgId}/signup`)
      .set(userId ? { ...internal, "x-user-id": userId } : internal);

  async function ledger(orgId: string): Promise<Record<string, number>> {
    const rows = await db
      .select({ code: localPromoCodes.code, amountCents: localPromos.amountCents })
      .from(localPromos)
      .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
      .where(eq(localPromos.orgId, orgId));
    const out: Record<string, number> = {};
    for (const r of rows) out[r.code] = (out[r.code] ?? 0) + Number(r.amountCents);
    return out;
  }

  async function welcomeRowsFor(orgIds: string[]): Promise<number> {
    let n = 0;
    for (const orgId of orgIds) n += (await ledger(orgId))[WELCOME_PROMO_CODE] ? 1 : 0;
    return n;
  }

  async function offer(orgId: string) {
    const [row] = await db
      .select({
        entitlement: billingAccounts.freeCreditEntitlementCents,
        trigger: billingAccounts.freeCreditPaidTriggerCents,
      })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));
    return row;
  }

  it("a person's first org gets the welcome exactly as before", async () => {
    const res = await account(firstOrg, person);

    expect(res.status).toBe(200);
    expect(res.body.credited_gifted_cents).toBe("3000.0000000000");
    expect(res.body.balance_cents).toBe("3000.0000000000");
    expect(res.body.free_credit_spendable_cents).toBe("3000.0000000000");
    expect(await ledger(firstOrg)).toEqual({ [WELCOME_PROMO_CODE]: WELCOME });
    expect(await offer(firstOrg)).toEqual({ entitlement: 3000, trigger: 3000 });

    const [bound] = await db
      .select()
      .from(welcomeRecipients)
      .where(eq(welcomeRecipients.userId, person));
    expect(bound.orgId).toBe(firstOrg);
  });

  it("the same person's second org gets none and reads zero free credit", async () => {
    await account(firstOrg, person).expect(200);

    const res = await account(secondOrg, person);

    expect(res.status).toBe(200);
    expect(res.body.credited_gifted_cents).toBe(ZERO);
    expect(res.body.balance_cents).toBe(ZERO);
    expect(res.body.free_credit_spendable_cents).toBe(ZERO);
    expect(await ledger(secondOrg)).toEqual({});
    expect(await offer(secondOrg)).toEqual({ entitlement: 0, trigger: 0 });

    // Nothing moved on the first org — no clawback.
    expect(await ledger(firstOrg)).toEqual({ [WELCOME_PROMO_CODE]: WELCOME });
  });

  it("the second org cannot earn the gift later through a payment (welcome completion)", async () => {
    await account(firstOrg, person).expect(200);
    await account(secondOrg, person).expect(200);

    // The second org pays $50: under its own zero offer nothing is earned.
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("5000.0000000000");
    const res = await account(secondOrg, person);

    expect(res.status).toBe(200);
    expect(res.body.credited_gifted_cents).toBe(ZERO);
    expect(await ledger(secondOrg)).toEqual({});

    const promises = await request(app)
      .get("/v1/free-credit-promises")
      .set(getAuthHeaders(secondOrg, person));
    expect(promises.status).toBe(200);
    expect(Number(promises.body.outstanding_total_cents)).toBe(0);
  });

  it("a replay on the first org never grants twice, and a different person still gets their own", async () => {
    await account(firstOrg, person).expect(200);
    await account(firstOrg, person).expect(200);
    await account(secondOrg, otherPerson).expect(200);

    expect(await ledger(firstOrg)).toEqual({ [WELCOME_PROMO_CODE]: WELCOME });
    expect(await ledger(secondOrg)).toEqual({ [WELCOME_PROMO_CODE]: WELCOME });
  });

  it("two orgs racing for the same person's welcome: exactly one wins", async () => {
    const results = await Promise.all([
      account(firstOrg, person),
      account(secondOrg, person),
      account(thirdOrg, person),
    ]);
    for (const r of results) expect(r.status).toBe(200);

    expect(await welcomeRowsFor([firstOrg, secondOrg, thirdOrg])).toBe(1);
    const rows = await db.select().from(welcomeRecipients);
    expect(rows).toHaveLength(1);
  });

  it("a caller with no person (platform sentinel) keeps the per-org behaviour", async () => {
    await account(firstOrg, PLATFORM_USER_ID).expect(200);
    await account(secondOrg, PLATFORM_USER_ID).expect(200);

    expect(await welcomeRowsFor([firstOrg, secondOrg])).toBe(2);
    expect(await db.select().from(welcomeRecipients)).toHaveLength(0);
  });

  describe("anonymous seed → claim", () => {
    it("yields exactly one welcome for the person, and their next org gets none", async () => {
      await seed(firstOrg).expect(200);
      const settled = await signup(firstOrg, person);

      expect(settled.status).toBe(200);
      expect(settled.body.welcomeGrantedCents).toBe(WELCOME - TRIAL_SEED_TARGET_CENTS);
      expect(settled.body.welcomeReceivedElsewhere).toBe(false);
      expect(await ledger(firstOrg)).toEqual({
        [TRIAL_SEED_CODE]: TRIAL_SEED_TARGET_CENTS,
        [WELCOME_PROMO_CODE]: WELCOME - TRIAL_SEED_TARGET_CENTS,
      });

      // The welcome row carries the real person now, never the sentinel.
      const [row] = await db
        .select({ userId: localPromos.userId })
        .from(localPromos)
        .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
        .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE));
      expect(row.userId).toBe(person);

      // A replay grants nothing.
      const replay = await signup(firstOrg, person);
      expect(replay.body.welcomeGrantedCents).toBe(0);
      expect(replay.body.alreadySettled).toBe(true);

      // The same person creates another org from inside the dashboard.
      const res = await account(secondOrg, person);
      expect(res.body.credited_gifted_cents).toBe(ZERO);
      expect(res.body.free_credit_spendable_cents).toBe(ZERO);
    });

    it("a person who already has a welcome keeps only the seed on a newly claimed org", async () => {
      await account(firstOrg, person).expect(200);
      await seed(secondOrg).expect(200);

      const settled = await signup(secondOrg, person);

      expect(settled.status).toBe(200);
      expect(settled.body.welcomeGrantedCents).toBe(0);
      expect(settled.body.welcomeReceivedElsewhere).toBe(true);
      expect(settled.body.totalFreeCreditCents).toBe(TRIAL_SEED_TARGET_CENTS);
      // The seed is not clawed back; no welcome lands.
      expect(await ledger(secondOrg)).toEqual({ [TRIAL_SEED_CODE]: TRIAL_SEED_TARGET_CENTS });
      expect(await offer(secondOrg)).toEqual({ entitlement: 0, trigger: 0 });
    });

    it("a signup that carries no person keeps the historical per-org behaviour", async () => {
      await account(firstOrg, person).expect(200);
      await seed(secondOrg).expect(200);

      const settled = await signup(secondOrg);

      expect(settled.status).toBe(200);
      expect(settled.body.welcomeGrantedCents).toBe(WELCOME - TRIAL_SEED_TARGET_CENTS);
      expect(settled.body.welcomeReceivedElsewhere).toBe(false);
    });

    it("rejects a malformed x-user-id", async () => {
      const res = await signup(firstOrg, "not-a-uuid");
      expect(res.status).toBe(400);
    });
  });
});
