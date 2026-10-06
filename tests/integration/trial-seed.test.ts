import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, useLegacyOfferDefaults, restoreCurrentOfferDefaults } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromoCodes,
  localPromos,
  TRIAL_SEED_CODE,
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

  // Written against what a freshly created account got before migration 0066
  // (a legacy account): see useLegacyOfferDefaults.
  beforeAll(async () => {
    await useLegacyOfferDefaults();
  });

  afterAll(async () => {
    await restoreCurrentOfferDefaults();
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
    expect(res.body.seededCents).toBe(3000);
    expect(res.body.alreadySeeded).toBe(false);

    // The ledger shows it as a trial seed. There is no welcome row yet — that lands
    // at signup, and it is the one the customer eventually sees by name.
    expect(await ledger(seededOrg)).toEqual({ [TRIAL_SEED_CODE]: 3000 });
  });

  it("seeding twice does not double the seed", async () => {
    await setWelcomeAmount(3000);

    await seed(seededOrg).expect(200);
    const second = await seed(seededOrg);

    expect(second.status).toBe(200);
    expect(second.body.alreadySeeded).toBe(true);
    expect(await totalFreeCredit(seededOrg)).toBe(3000);

    const rows = await db
      .select({ id: localPromos.id })
      .from(localPromos)
      .where(eq(localPromos.orgId, seededOrg));
    expect(rows).toHaveLength(1);
  });

  it("a seeded org holds the WHOLE welcome up front, and signup adds nothing on top", async () => {
    await setWelcomeAmount(3000);
    await seed(seededOrg).expect(200);
    expect(await totalFreeCredit(seededOrg)).toBe(3000);

    const res = await signup(seededOrg);

    expect(res.status).toBe(200);
    expect(res.body.trialSeedCents).toBe(3000);
    expect(res.body.welcomeGrantedCents).toBe(0);
    expect(res.body.totalFreeCreditCents).toBe(3000);

    // Verified against the ledger, not the response: the $30 seed and nothing else.
    expect(await ledger(seededOrg)).toEqual({ [TRIAL_SEED_CODE]: 3000 });
    expect(await totalFreeCredit(seededOrg)).toBe(await welcomeAmount());
  });

  // Orgs seeded under the earlier $5 / $12 slices and not yet signed up still get
  // their own remainder, so their total is the welcome amount too.
  it("an org seeded under the earlier $12 slice receives its remainder at signup", async () => {
    await setWelcomeAmount(3000);
    const [seedCode] = await db
      .select()
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, TRIAL_SEED_CODE));
    await db.insert(billingAccounts).values({ orgId: seededOrg }).onConflictDoNothing();
    await db.insert(localPromos).values({
      orgId: seededOrg,
      userId: "00000000-0000-0000-0000-000000000000",
      amountCents: "1200",
      promoCodeId: seedCode.id,
      description: "Trial seed: $12.00",
    });

    const res = await signup(seededOrg).expect(200);

    expect(res.body.welcomeGrantedCents).toBe(1800);
    expect(await ledger(seededOrg)).toEqual({
      [TRIAL_SEED_CODE]: 1200,
      [WELCOME_PROMO_CODE]: 1800,
    });
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
    expect(Number(trialRow.amountCents)).toBe(3000);

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

  // Moving the welcome amount moves the seed with it: the seed IS the live welcome
  // figure and the signup grant is the (zero) remainder, so the total holds by
  // construction at any price.
  it.each([
    [3000, 3000, 0],
    [2000, 2000, 0],
    [10000, 10000, 0],
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
    await findOrCreateAccount(seededOrg, plainOrg);

    expect(await ledger(seededOrg)).toEqual({ [TRIAL_SEED_CODE]: 3000 });
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
