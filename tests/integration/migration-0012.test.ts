import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { eq, and, sql as rawSql } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { transactions } from "../../src/db/schema.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";

// Verifies the 0012 SQL migration on a synthetic snapshot of legacy rows:
//   - 'deduct'   debit confirmed         -> renamed to 'charge'
//   - 'provision' debit confirmed/cancelled/pending -> renamed to 'charge'
//   - 'provision_cancel' credit confirmed (paired with cancelled debit parent)  -> deleted
//   - 'provision_adjust' credit confirmed (paired with confirmed debit parent)  -> collapsed into a fresh 'charge' row at $Y, parent reverted to $X cancelled
// After running the migration, we re-check totals from the public-stats query semantics
// and the per-row invariants required by AC-A* / AC-B*.

const MIGRATION_PATH = resolve(__dirname, "..", "..", "drizzle", "0012_transactions_rename.sql");

async function runMigrationFresh() {
  // Drizzle's migrator splits the file on `--> statement-breakpoint` and runs each chunk
  // as one statement. Postgres treats lines starting with `--` as comments inside the chunk.
  const raw = readFileSync(MIGRATION_PATH, "utf-8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await db.execute(rawSql.raw(statement));
  }
}

describe("Migration 0012: transactions rename + source unification", () => {
  const orgId = "00000000-0000-0000-0000-0000000aabb1";
  const userId = "00000000-0000-0000-0000-000000000099";

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("is a no-op when run on already-canonical data", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 1000 });

    await db.insert(transactions).values([
      {
        orgId,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 100,
        source: "charge",
        description: "already canonical",
      },
      {
        orgId,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 1000,
        source: "reload",
        description: "already canonical",
      },
    ]);

    await runMigrationFresh();

    const all = await db.select().from(transactions).where(eq(transactions.orgId, orgId));
    expect(all).toHaveLength(2);
    for (const row of all) {
      expect(["charge", "reload", "welcome", "promo", "refund"]).toContain(row.source);
    }
  });

  it("renames source 'deduct' -> 'charge'", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 0 });

    await db.insert(transactions).values({
      orgId,
      userId,
      type: "debit",
      status: "confirmed",
      amountCents: 50,
      source: "deduct",
      description: "legacy deduct",
    });

    await runMigrationFresh();

    const rows = await db.select().from(transactions).where(eq(transactions.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("charge");
    expect(rows[0].amountCents).toBe(50);
  });

  it("renames source 'provision' -> 'charge' for all statuses", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 0 });

    await db.insert(transactions).values([
      {
        orgId,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 100,
        source: "provision",
        description: "confirmed provision",
      },
      {
        orgId,
        userId,
        type: "debit",
        status: "pending",
        amountCents: 200,
        source: "provision",
        description: "pending provision",
      },
      {
        orgId,
        userId,
        type: "debit",
        status: "cancelled",
        amountCents: 300,
        source: "provision",
        description: "cancelled provision",
      },
    ]);

    await runMigrationFresh();

    const rows = await db.select().from(transactions).where(eq(transactions.orgId, orgId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.source).toBe("charge");
    }
  });

  it("deletes provision_cancel rows and keeps the cancelled-debit parent intact", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 0 });

    const [parent] = await db
      .insert(transactions)
      .values({
        orgId,
        userId,
        type: "debit",
        status: "cancelled",
        amountCents: 100,
        source: "provision",
        description: "original hold",
      })
      .returning();

    await db.insert(transactions).values({
      orgId,
      userId,
      type: "credit",
      status: "confirmed",
      amountCents: 100,
      source: "provision_cancel",
      description: `Provision ${parent.id} cancelled — refund`,
    });

    await runMigrationFresh();

    const rows = await db.select().from(transactions).where(eq(transactions.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(parent.id);
    expect(rows[0].status).toBe("cancelled");
    expect(rows[0].source).toBe("charge");
  });

  it("collapses provision_adjust (over-provisioned) into a fresh charge at $Y; parent reverts to $X cancelled", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 0 });

    // Original $X = 100, actual $Y = 60. Over-provisioned, adjust is a credit of 40.
    const [parent] = await db
      .insert(transactions)
      .values({
        orgId,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 60, // current $Y — confirm() updated it
        source: "provision",
        description: "over-provisioned hold",
      })
      .returning();

    await db.insert(transactions).values({
      orgId,
      userId,
      type: "credit",
      status: "confirmed",
      amountCents: 40, // |delta|
      source: "provision_adjust",
      description: `Provision ${parent.id} adjustment: +40 cents`,
    });

    await runMigrationFresh();

    // Parent reverted to $X = 100, status cancelled.
    const [parentAfter] = await db.select().from(transactions).where(eq(transactions.id, parent.id));
    expect(parentAfter.status).toBe("cancelled");
    expect(parentAfter.amountCents).toBe(100);
    expect(parentAfter.source).toBe("charge");

    // Adjust row deleted.
    const adjusts = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.orgId, orgId), eq(transactions.source, "provision_adjust")));
    expect(adjusts).toHaveLength(0);

    // New charge row at $Y = 60.
    const charges = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.orgId, orgId),
          eq(transactions.source, "charge"),
          eq(transactions.status, "confirmed")
        )
      );
    expect(charges).toHaveLength(1);
    expect(charges[0].amountCents).toBe(60);

    // Net balance contribution preserved: pre = -60 (parent) + 40 (adjust) = -20.
    // post = 0 (cancelled parent) - 60 (new charge) = -60.
    // Mismatch is expected and intentional: pre-migration the cache reflected -60 (the actual
    // money owed), but the ledger summed to -20 due to the adjust bug. Post-migration, the
    // ledger correctly sums to -60 = cache. This test asserts the post-state, not pre-equality.
    const [{ ledgerSum }] = (await db.execute(rawSql`
      SELECT COALESCE(SUM(
        CASE
          WHEN type = 'credit' AND status = 'confirmed' THEN amount_cents
          WHEN type = 'debit' AND status IN ('confirmed','pending') THEN -amount_cents
          ELSE 0
        END
      ), 0)::int AS "ledgerSum"
      FROM transactions WHERE org_id = ${orgId}
    `)) as unknown as { ledgerSum: number }[];
    expect(ledgerSum).toBe(-60);
  });

  it("collapses provision_adjust (under-provisioned) into a fresh charge at $Y; parent reverts to $X cancelled", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 0 });

    // Original $X = 100, actual $Y = 150. Under-provisioned, adjust is a debit of 50.
    const [parent] = await db
      .insert(transactions)
      .values({
        orgId,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 150,
        source: "provision",
        description: "under-provisioned hold",
      })
      .returning();

    await db.insert(transactions).values({
      orgId,
      userId,
      type: "debit",
      status: "confirmed",
      amountCents: 50,
      source: "provision_adjust",
      description: `Provision ${parent.id} adjustment: -50 cents`,
    });

    await runMigrationFresh();

    const [parentAfter] = await db.select().from(transactions).where(eq(transactions.id, parent.id));
    expect(parentAfter.status).toBe("cancelled");
    expect(parentAfter.amountCents).toBe(100);

    const charges = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.orgId, orgId),
          eq(transactions.source, "charge"),
          eq(transactions.status, "confirmed")
        )
      );
    expect(charges).toHaveLength(1);
    expect(charges[0].amountCents).toBe(150);
  });

  it("aborts when a provision_cancel row has no matching parent", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 0 });

    await db.insert(transactions).values({
      orgId,
      userId,
      type: "credit",
      status: "confirmed",
      amountCents: 100,
      source: "provision_cancel",
      description: "Provision 00000000-0000-0000-0000-000000abcdef cancelled — refund",
    });

    await expect(runMigrationFresh()).rejects.toThrow(/provision_cancel orphans/);

    // Row still present after failed migration.
    const rows = await db.select().from(transactions).where(eq(transactions.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("provision_cancel");
  });

  it("leaves only canonical sources after running on a mixed-state dataset", async () => {
    await insertTestAccount({ orgId, creditBalanceCents: 0 });

    const [parentForCancel] = await db
      .insert(transactions)
      .values({
        orgId,
        userId,
        type: "debit",
        status: "cancelled",
        amountCents: 25,
        source: "provision",
        description: "for cancel pairing",
      })
      .returning();

    const [parentForAdjust] = await db
      .insert(transactions)
      .values({
        orgId,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 80,
        source: "provision",
        description: "for adjust pairing",
      })
      .returning();

    await db.insert(transactions).values([
      {
        orgId,
        userId,
        type: "debit",
        status: "confirmed",
        amountCents: 5,
        source: "deduct",
        description: "legacy deduct",
      },
      {
        orgId,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 1000,
        source: "reload",
        description: "real reload",
      },
      {
        orgId,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 200,
        source: "welcome",
        description: "welcome credit",
      },
      {
        orgId,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 25,
        source: "provision_cancel",
        description: `Provision ${parentForCancel.id} cancelled — refund`,
      },
      {
        orgId,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: 20,
        source: "provision_adjust",
        description: `Provision ${parentForAdjust.id} adjustment: +20 cents`,
      },
    ]);

    await runMigrationFresh();

    const rows = await db.select().from(transactions).where(eq(transactions.orgId, orgId));
    for (const row of rows) {
      expect(["charge", "reload", "welcome", "promo", "refund"]).toContain(row.source);
    }
    // Originals: parentForCancel (charge cancelled), parentForAdjust (charge cancelled), deduct→charge,
    // reload, welcome. Plus one new charge from adjust. Total 6.
    expect(rows).toHaveLength(6);
  });
});
