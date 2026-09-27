/**
 * Staff debits: a staff member takes credit OFF an org's balance, with a note.
 *
 * The mirror of the staff grant (`POST /v1/credits/grant`). Stored in its own
 * table (`staff_debits`, migration 0053), never as a negative `local_promos` row:
 * that ledger feeds the welcome remainder, the free-credit entitlement, the
 * referral ladder and `credited_gifted_cents`, and a negative gift would reach
 * every one of them (a debit would ENLARGE a welcome remainder).
 *
 * A debit lands on the USAGE side of the balance, through the same choke point
 * as the brand-transfer correction (lib/transfer-usage.ts), so every balance
 * composition — authorize, affordability, dunning, the account read — lowers by
 * exactly the debited amount, like spend would. `credited_cents` does not move,
 * which keeps the dunning-recovery baseline ("credited rose") and the card-verdict
 * release ("credited moved") meaning what they mean. It is exposed as its own
 * line (`debited_cents` on GET /v1/accounts, GET /v1/credits/debits) and taken
 * back OUT of `usage_cents`, so it is never presented as campaign usage.
 *
 * Nothing here charges a card or talks to Stripe.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { staffDebits } from "../db/schema.js";
import { cmpCents } from "./cents.js";

export interface StaffDebitItem {
  id: string;
  orgId: string;
  amountCents: string;
  note: string;
  debitedBy: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface StaffDebitResult {
  debit: StaffDebitItem;
  /** True when this idempotencyKey had already debited the org — nothing new was taken. */
  alreadyDebited: boolean;
}

/** A retry reused an idempotencyKey with a DIFFERENT amount — refused, never guessed. */
export class StaffDebitKeyConflictError extends Error {}

function toItem(row: typeof staffDebits.$inferSelect): StaffDebitItem {
  return {
    id: row.id,
    orgId: row.orgId,
    amountCents: row.amountCents,
    note: row.note,
    debitedBy: row.debitedBy,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Debit `amountCents` from the org's balance. A retry with the same
 * `idempotencyKey` is a no-op returning the original row; the same key with a
 * different amount throws StaffDebitKeyConflictError (the caller meant two
 * different debits, or made a mistake — either way not ours to pick).
 */
export async function debitOrg(params: {
  orgId: string;
  amountCents: number;
  note: string;
  debitedBy: string;
  idempotencyKey: string;
}): Promise<StaffDebitResult> {
  const { orgId, amountCents, note, debitedBy, idempotencyKey } = params;
  const inserted = await db
    .insert(staffDebits)
    .values({ orgId, amountCents: String(amountCents), note, debitedBy, idempotencyKey })
    .onConflictDoNothing({ target: [staffDebits.orgId, staffDebits.idempotencyKey] })
    .returning();
  if (inserted.length > 0) return { debit: toItem(inserted[0]), alreadyDebited: false };

  const [existing] = await db
    .select()
    .from(staffDebits)
    .where(and(eq(staffDebits.orgId, orgId), eq(staffDebits.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (cmpCents(existing.amountCents, String(amountCents)) !== 0) {
    throw new StaffDebitKeyConflictError(
      `idempotencyKey "${idempotencyKey}" already debited ${existing.amountCents} cents from this org; refusing a different amount (${amountCents}) under the same key`
    );
  }
  return { debit: toItem(existing), alreadyDebited: true };
}

/** Total staff debits for one org (decimal string, "0" when none). */
export async function sumStaffDebitsForOrg(orgId: string): Promise<string> {
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${staffDebits.amountCents}), 0)::text` })
    .from(staffDebits)
    .where(eq(staffDebits.orgId, orgId));
  return rows[0].total;
}

/** One org's debits, newest first. */
export async function listDebitsForOrg(orgId: string): Promise<StaffDebitItem[]> {
  const rows = await db
    .select()
    .from(staffDebits)
    .where(eq(staffDebits.orgId, orgId))
    .orderBy(desc(staffDebits.createdAt));
  return rows.map(toItem);
}

/** Every org's debits, newest first (platform-wide oversight ledger). */
export async function listAllDebits(): Promise<StaffDebitItem[]> {
  const rows = await db.select().from(staffDebits).orderBy(desc(staffDebits.createdAt));
  return rows.map(toItem);
}
