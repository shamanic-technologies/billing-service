/**
 * Migration 0090 (CARD-HOLD-50-1022): every account ALREADY postpaid before the card
 * check keeps running as it did ('grandfathered'); every other account, and every new
 * one, must pass the $50 hold first ('required'). A re-apply moves nothing.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "fs";
import { eq } from "drizzle-orm";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db, sql } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";

const OLD_POSTPAID = "00000000-0000-0000-0000-000000009a01";
const OLD_PREPAID = "00000000-0000-0000-0000-000000009a02";
const NEW_POSTPAID = "00000000-0000-0000-0000-000000009a03";

const replay = async () => {
  const migration = readFileSync(new URL("../../drizzle/0090_postpaid_card_check.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    const body = statement.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    if (body) await sql.unsafe(body);
  }
};

const checkOf = async (orgId: string) =>
  (await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId)))[0].postpaidCardCheck;

describe("migration 0090: postpaid card check", () => {
  beforeEach(async () => {
    await cleanTestData();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("grandfathers only accounts postpaid before the ship; a new account must pass the hold; re-apply is a no-op", async () => {
    const before = new Date("2026-10-01T00:00:00Z");
    await db.insert(billingAccounts).values([
      { orgId: OLD_POSTPAID, paymentMode: "postpaid", createdAt: before },
      { orgId: OLD_PREPAID, paymentMode: "prepaid", createdAt: before },
      { orgId: NEW_POSTPAID, paymentMode: "postpaid", createdAt: new Date("2026-10-22T13:00:00Z") },
    ]);
    // A fresh account reads the column DEFAULT.
    expect(await checkOf(NEW_POSTPAID)).toBe("required");

    await replay();
    expect(await checkOf(OLD_POSTPAID)).toBe("grandfathered");
    expect(await checkOf(OLD_PREPAID)).toBe("required");
    expect(await checkOf(NEW_POSTPAID)).toBe("required");

    // A refused / passed verdict is never rewritten by a re-apply.
    await db.update(billingAccounts).set({ postpaidCardCheck: "refused" }).where(eq(billingAccounts.orgId, NEW_POSTPAID));
    await replay();
    expect(await checkOf(NEW_POSTPAID)).toBe("refused");
    expect(await checkOf(OLD_POSTPAID)).toBe("grandfathered");
  });
});
