import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  TRIAL_SEED_CODE,
  TRIAL_SEED_TARGET_CENTS,
  WELCOME_PROMO_CODE,
} from "../../src/db/schema.js";
import { resolveTrialSeedAmountCents } from "../../src/lib/trial-seed.js";

/**
 * The unauthenticated trial: an org spends before anyone has signed up, and signing
 * up lands its TOTAL free credit on exactly the welcome amount — never the welcome
 * amount PLUS what it was seeded with.
 */
describe("trial seed → signup", () => {
  const app = createTestApp();
  const seededOrg = "00000000-0000-0000-0000-0000000000a1";
  const plainOrg = "00000000-0000-0000-0000-0000000000a2";

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  const headers = { "X-API-Key": "test-api-key", "Content-Type": "application/json" };

  async function setWelcomeAmount(amountCents: number) {
    await db
      .update(localPromoCodes)
      .set({ amountCents })
      .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE));
  }

  async function welcomeAmount(): Promise<number> {
    const [row] = await db
      .select()
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, WELCOME_PROMO_CODE))
      .limit(1);
    return row.amountCents;
  }

  /** Every free-credit row this org holds, by ledger key. */
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

  async function totalFreeCredit(orgId: string): Promise<number> {
    const byCode = await ledger(orgId);
    return Object.values(byCode).reduce((a, b) => a + b, 0);
  }

  const seed = (orgId: string) =>
    request(app).post(`/internal/accounts/by-org/${orgId}/trial-seed`).set(headers);
  const signup = (orgId: string) =>
    request(app).post(`/internal/accounts/by-org/${orgId}/signup`).set(headers);

  it("seeds an org that has not signed up, recorded as a trial and NOT as the welcome gift", async () => {
    await setWelcomeAmount(3000);

    const res = await seed(seededOrg);

    expect(res.status).toBe(200);
    expect(res.body.seededCents).toBe(TRIAL_SEED_TARGET_CENTS);
    expect(res.body.alreadySeeded).toBe(false);

    // The ledger shows it as a trial seed. There is no welcome row yet — that lands
    // at signup, and it is the one the customer eventually sees by name.
    expect(await ledger(seededOrg)).toEqual({ [TRIAL_SEED_CODE]: 500 });
  });

  it("seeding twice does not double the seed", async () => {
    await setWelcomeAmount(3000);

    await seed(seededOrg).expect(200);
    const second = await seed(seededOrg);

    expect(second.status).toBe(200);
    expect(second.body.alreadySeeded).toBe(true);
    expect(await totalFreeCredit(seededOrg)).toBe(TRIAL_SEED_TARGET_CENTS);

    const rows = await db
      .select({ id: localPromos.id })
      .from(localPromos)
      .where(eq(localPromos.orgId, seededOrg));
    expect(rows).toHaveLength(1);
  });

  it("a seeded org that signs up ends with free credit totalling exactly the welcome amount", async () => {
    await setWelcomeAmount(3000);
    await seed(seededOrg).expect(200);

    const res = await signup(seededOrg);

    expect(res.status).toBe(200);
    expect(res.body.trialSeedCents).toBe(500);
    expect(res.body.welcomeGrantedCents).toBe(2500);
    expect(res.body.totalFreeCreditCents).toBe(3000);

    // Verified against the ledger, not the response: $5 trial + $25 welcome = $30.
    expect(await ledger(seededOrg)).toEqual({
      [TRIAL_SEED_CODE]: 500,
      [WELCOME_PROMO_CODE]: 2500,
    });
    expect(await totalFreeCredit(seededOrg)).toBe(await welcomeAmount());
  });

  it("an unseeded org that signs up receives the WHOLE welcome offer", async () => {
    await setWelcomeAmount(3000);

    const res = await signup(plainOrg);

    expect(res.status).toBe(200);
    expect(res.body.trialSeedCents).toBe(0);
    expect(res.body.welcomeGrantedCents).toBe(3000);
    expect(await ledger(plainOrg)).toEqual({ [WELCOME_PROMO_CODE]: 3000 });
  });

  it("signing up twice grants nothing the second time", async () => {
    await setWelcomeAmount(3000);
    await seed(seededOrg).expect(200);
    await signup(seededOrg).expect(200);

    const replay = await signup(seededOrg);

    expect(replay.status).toBe(200);
    expect(replay.body.welcomeGrantedCents).toBe(0);
    expect(replay.body.alreadySettled).toBe(true);
    expect(await totalFreeCredit(seededOrg)).toBe(3000);
  });

  it("unspent seed is NOT clawed back — what is fixed is the total, not the remainder", async () => {
    await setWelcomeAmount(3000);
    await seed(seededOrg).expect(200);
    await signup(seededOrg).expect(200);

    // The trial row is untouched by the signup, whatever the visitor consumed of it.
    const [trialRow] = await db
      .select({ amountCents: localPromos.amountCents })
      .from(localPromos)
      .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
      .where(
        and(
          eq(localPromos.orgId, seededOrg),
          eq(localPromoCodes.code, TRIAL_SEED_CODE)
        )
      );
    expect(Number(trialRow.amountCents)).toBe(500);

    // Nothing negative was ever written.
    const rows = await db
      .select({ amountCents: localPromos.amountCents })
      .from(localPromos)
      .where(eq(localPromos.orgId, seededOrg));
    for (const r of rows) expect(Number(r.amountCents)).toBeGreaterThan(0);
  });

  it("refuses to seed an org that already holds the welcome gift", async () => {
    await setWelcomeAmount(3000);
    await signup(seededOrg).expect(200);

    const res = await seed(seededOrg);

    expect(res.status).toBe(409);
    expect(await totalFreeCredit(seededOrg)).toBe(3000);
  });

  // Moving the welcome amount must not leave the two figures summing to anything
  // else. Nobody re-prices the seed: it is derived from the live welcome figure, and
  // the signup grant is the remainder, so the invariant holds by construction.
  it.each([
    [3000, 500, 2500],
    [1000, 500, 500],
    [10000, 500, 9500],
    // Welcome priced at or below the seed: the seed is clamped to it and the
    // remainder is zero — still exactly the welcome amount, never a negative grant.
    [500, 500, 0],
    [300, 300, 0],
  ])(
    "welcome at %i cents → seed %i + welcome %i, totalling exactly the welcome amount",
    async (welcomeCents, expectedSeed, expectedRemainder) => {
      const orgId = `00000000-0000-0000-0000-0000000${String(welcomeCents).padStart(
        5,
        "0"
      )}`;
      await setWelcomeAmount(welcomeCents);

      expect(resolveTrialSeedAmountCents(welcomeCents)).toBe(expectedSeed);

      const seeded = await seed(orgId).expect(200);
      expect(seeded.body.seededCents).toBe(expectedSeed);

      const signedUp = await signup(orgId).expect(200);
      expect(signedUp.body.welcomeGrantedCents).toBe(expectedRemainder);

      expect(await totalFreeCredit(orgId)).toBe(welcomeCents);
    }
  );

  // The seed creates the account itself, so the welcome-redeem branch is normally
  // unreachable for a seeded org. This closes the race where a first spend and the
  // seed arrive together, in the only safe direction: never a full welcome on top.
  it("a spend on a seeded org does NOT grant it the welcome gift", async () => {
    await setWelcomeAmount(3000);
    await seed(seededOrg).expect(200);

    const ssClient = await import("../../src/lib/stripe-service-client.js");
    vi.spyOn(ssClient, "ensureCustomer").mockResolvedValue(undefined as never);

    const { findOrCreateAccount } = await import("../../src/lib/account.js");
    await db.delete(billingAccounts).where(eq(billingAccounts.orgId, seededOrg));
    await findOrCreateAccount(seededOrg, plainOrg, {});

    expect(await ledger(seededOrg)).toEqual({ [TRIAL_SEED_CODE]: 500 });
    vi.restoreAllMocks();
  });

  it("rejects a non-UUID orgId on both surfaces", async () => {
    await request(app)
      .post("/internal/accounts/by-org/not-a-uuid/trial-seed")
      .set(headers)
      .expect(400);
    await request(app)
      .post("/internal/accounts/by-org/not-a-uuid/signup")
      .set(headers)
      .expect(400);
  });
});
