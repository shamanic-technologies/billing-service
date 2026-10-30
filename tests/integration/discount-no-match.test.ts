/**
 * DISCOUNT-NO-MATCH-1030: a usage discount and the welcome "$100 match" are NOT
 * cumulative (owner 2026-10-30: « le 50% de discount et le 100 match 100 ne sont pas
 * cumulables »). Own file: other suites close the shared connection (see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import {
  cleanTestData,
  closeDb,
  insertTestAccount,
  insertTestUsageDiscount,
} from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  freeCreditPromises,
  localPromoCodes,
  localPromos,
  orgUsageDiscounts,
} from "../../src/db/schema.js";
import { settleFreeCreditPromises } from "../../src/lib/free-credit-settlement.js";
import { WELCOME_COMPLETION_CODE } from "../../src/db/schema.js";

const discounted = "00000000-0000-0000-0000-0000000dc001";
const plain = "00000000-0000-0000-0000-0000000dc002";
const PAID_100 = "10000.0000000000";

async function newMatchOrg(orgId: string) {
  await insertTestAccount({
    orgId,
    freeCreditOffer: "match_100",
    freeCreditEntitlementCents: 10000,
    freeCreditPaidTriggerCents: 10000,
    welcomeCompletionEligible: true,
    createdAt: new Date(),
    paymentMode: "postpaid",
  });
}

async function matchGrants(orgId: string) {
  return db
    .select({ amount: localPromos.amountCents })
    .from(localPromos)
    .innerJoin(localPromoCodes, eq(localPromos.promoCodeId, localPromoCodes.id))
    .where(and(eq(localPromos.orgId, orgId), eq(localPromoCodes.code, WELCOME_COMPLETION_CODE)));
}

async function welcomePromise(orgId: string) {
  const [row] = await db
    .select()
    .from(freeCreditPromises)
    .where(and(eq(freeCreditPromises.orgId, orgId), eq(freeCreditPromises.kind, "welcome")));
  return row;
}

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("A usage discount and the welcome match never stack", () => {
  const app = createTestApp();

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();
  });

  it("an org WITHOUT a discount still gets its $100 match at $100 paid", async () => {
    await newMatchOrg(plain);
    const out = await settleFreeCreditPromises(plain, PAID_100);
    expect(out.welcome.reason).toBe("granted");
    expect((await matchGrants(plain)).map((r) => Number(r.amount))).toEqual([10000]);
  });

  it("a discount set BEFORE the rule (Beyond Logic): its pending match is withdrawn on settle, paying $100 grants nothing, the discount stays", async () => {
    await newMatchOrg(discounted);
    // Promise materialised while nothing forbade it (the prod state today).
    await settleFreeCreditPromises(discounted, "0.0000000000");
    expect((await welcomePromise(discounted)).amountCents).toBe(10000);
    await insertTestUsageDiscount({ orgId: discounted, discountPct: 50 });

    const out = await settleFreeCreditPromises(discounted, PAID_100);
    expect(out.welcome.reason).toBe("usage_discount");
    expect(out.grantedCents).toBe("0.0000000000");
    expect(await matchGrants(discounted)).toEqual([]);

    const promise = await welcomePromise(discounted);
    expect(promise.grantedAt).toBeNull();
    expect(promise.amountCents).toBe(0);
    expect(promise.withdrawnReason).toBe("usage_discount");
    expect(promise.withdrawnAmountCents).toBe(10000);
    expect(promise.withdrawnAt).not.toBeNull();

    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, discounted));
    expect(account.freeCreditEntitlementCents).toBe(0);
    expect(account.freeCreditOffer).toBe("match_100");
    expect(account.paymentMode).toBe("postpaid");

    const [discount] = await db
      .select()
      .from(orgUsageDiscounts)
      .where(eq(orgUsageDiscounts.orgId, discounted));
    expect(discount.discountPct).toBe(50);

    // A replay stays withdrawn and grants nothing.
    const again = await settleFreeCreditPromises(discounted, "20000.0000000000");
    expect(again.grantedCents).toBe("0.0000000000");
    expect(await matchGrants(discounted)).toEqual([]);
  });

  it("staff SETTING a discount withdraws the pending match at once (no settle needed)", async () => {
    await newMatchOrg(discounted);
    await settleFreeCreditPromises(discounted, "0.0000000000");

    const res = await request(app)
      .put("/v1/usage-discount")
      .set({
        "X-API-Key": "test-api-key",
        "x-org-id": discounted,
        "x-email": "staff@distribute.you",
        "Content-Type": "application/json",
      })
      .send({ discountPct: 50 });
    expect(res.status).toBe(200);
    expect(res.body.discountPct).toBe(50);

    const promise = await welcomePromise(discounted);
    expect(promise.amountCents).toBe(0);
    expect(promise.withdrawnReason).toBe("usage_discount");

    const out = await settleFreeCreditPromises(discounted, PAID_100);
    expect(out.grantedCents).toBe("0.0000000000");
    expect(await matchGrants(discounted)).toEqual([]);
  });

  it("a 0% discount is no discount: the match still lands", async () => {
    await newMatchOrg(plain);
    await insertTestUsageDiscount({ orgId: plain, discountPct: 0 });
    const out = await settleFreeCreditPromises(plain, PAID_100);
    expect(out.welcome.reason).toBe("granted");
  });

  it("an already GRANTED match is never taken back by a later discount", async () => {
    await newMatchOrg(plain);
    await settleFreeCreditPromises(plain, PAID_100);
    await insertTestUsageDiscount({ orgId: plain, discountPct: 50 });
    const out = await settleFreeCreditPromises(plain, PAID_100);
    expect(out.welcome.reason).toBe("usage_discount");
    expect((await matchGrants(plain)).map((r) => Number(r.amount))).toEqual([10000]);
    const promise = await welcomePromise(plain);
    expect(promise.grantedAt).not.toBeNull();
    expect(promise.withdrawnAt).toBeNull();
  });
});
