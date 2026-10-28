/**
 * ONE owner Telegram per client going through the card page, carrying everything
 * about that moment (owner 2026-10-27, OWNER-PING-BUDGET-1027): what the card page
 * showed them, every campaign budget they set (per sales funnel, plus the total),
 * their monthly charge limit, and what they accepted.
 *
 * WHY DEFERRED: the client states the budgets AFTER the card step. Beyond Logic
 * 2026-10-27: limit set 17:42:48, card check passed 17:44:11 (the old 💳 ping fired
 * there), the two funnel caps landed 17:44:13 and 17:44:28. A ping sent at the card
 * step cannot carry them. So the card step WRITES a pending row
 * (`owner_stripe_step_alerts`, due a minute later); each cap write while it is
 * pending pushes `due_at` to at least CAP_QUIET_MS after that write (never past
 * MAX_WAIT_MS after the card step); a sweep sends it once due, reading budgets and
 * limit as they stand THEN. Persisted, so a deploy between the card step and the
 * send loses nothing.
 *
 * Same rules as every owner alert (lib/owner-alerts `deliver`): never a staff
 * actor, never a staff test org or our own platform org, Telegram only, once per
 * `dedupKey` (claimed in `owner_alerts`). The actor is captured at the card step
 * (request context) and stored on the row, since the sweep has none.
 *
 * Changes nothing the client sees or pays: read-only over caps and the limit.
 */
import { Decimal } from "decimal.js";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { ownerStripeStepAlerts, salesFunnelCaps, type SalesFunnelCapRow } from "../db/schema.js";
import { currentActor, deliver, type AlertActor } from "./owner-alerts.js";
import { getMonthlyChargeLimit } from "./monthly-charge-limit.js";
import { getSalesFunnel, type SalesFunnel } from "./sales-funnel-catalogue.js";
import { volumeUnitFor, type CapPeriod, type VolumeUnit } from "./sales-funnel-caps.js";

/** Card step to send, when no budget lands meanwhile. */
export const STRIPE_STEP_SETTLE_MS = 60_000;
/** A prepaid card page is a payment the client still has to make: wait longer. */
export const PREPAID_CHECKOUT_SETTLE_MS = 3 * 60_000;
/** After each cap write, wait at least this long for the next one. */
export const CAP_QUIET_MS = 20_000;
/** Never later than this after the card step, however many caps keep landing. */
export const MAX_WAIT_MS = 10 * 60_000;
/** A send that keeps failing (Telegram down) is given up after this. */
const GIVE_UP_MS = 60 * 60_000;
const STALE_SENDING_MS = 5 * 60_000;
const TICK_MS = 15_000;
const FIRST_TICK_MS = 20_000;
const CATALOGUE_WAIT_MS = 3_000;

export interface StripeStepInput {
  orgId: string;
  /** Once-only key, also the `owner_alerts` claim. */
  dedupKey: string;
  /** What the card page showed, one plain line ("Card page: $0 today, card saved."). */
  stripeLine: string;
  /** What they accepted, one plain line, or null. */
  acceptedLine?: string | null;
  settleMs?: number;
  now?: Date;
  /** Defaults to the request's actor (lib/owner-alerts). */
  actor?: AlertActor;
}

/** Awaitable form (tests, callers that want it). Never throws. */
export async function scheduleStripeStepAlertNow(input: StripeStepInput): Promise<void> {
  const now = input.now ?? new Date();
  const actor = input.actor ?? currentActor();
  try {
    await db
      .insert(ownerStripeStepAlerts)
      .values({
        dedupKey: input.dedupKey,
        orgId: input.orgId,
        stripeLine: input.stripeLine,
        acceptedLine: input.acceptedLine ?? null,
        actorEmail: actor.email,
        actorUserId: actor.userId,
        dueAt: new Date(now.getTime() + (input.settleMs ?? STRIPE_STEP_SETTLE_MS)),
        createdAt: now,
      })
      .onConflictDoNothing();
  } catch (err) {
    console.error(`[billing-service] card step alert NOT scheduled for org ${input.orgId} (${input.dedupKey}):`, err);
  }
}

/** Fire-and-forget: never delays or fails the billing write that reports it. */
export function scheduleStripeStepAlert(input: StripeStepInput): void {
  const actor = input.actor ?? currentActor();
  void scheduleStripeStepAlertNow({ ...input, actor });
}

/** A cap was written for this org: a pending card-step ping waits for the next one. Never throws. */
export async function deferStripeStepAlertOnCapWrite(orgId: string, now: Date = new Date()): Promise<void> {
  try {
    const quiet = new Date(now.getTime() + CAP_QUIET_MS);
    await db
      .update(ownerStripeStepAlerts)
      .set({
        dueAt: sql`LEAST(${ownerStripeStepAlerts.createdAt} + make_interval(secs => ${MAX_WAIT_MS / 1000}), GREATEST(${ownerStripeStepAlerts.dueAt}, ${quiet.toISOString()}::timestamptz))`,
      })
      .where(and(eq(ownerStripeStepAlerts.orgId, orgId), isNull(ownerStripeStepAlerts.settledAt)));
  } catch (err) {
    console.error(`[billing-service] card step alert: deferring on a cap write failed for org ${orgId}:`, err);
  }
}

// --- composition -------------------------------------------------------------

export interface BudgetLine {
  /** The funnel's served name; null when the catalogue could not say. */
  funnelName: string | null;
  /** Served trigger name of a reactive funnel ("Positive reply"); null otherwise. */
  triggerName: string | null;
  amountCents: string | null;
  period: CapPeriod | null;
  volume: { count: number; period: CapPeriod; unit: VolumeUnit | null } | null;
}

const PER: Record<CapPeriod, string> = { monthly: "/month", weekly: "/week", daily: "/day", one_off: " one time" };
const PERIOD_ORDER: CapPeriod[] = ["monthly", "weekly", "daily", "one_off"];
const UNIT_WORDS: Record<VolumeUnit, string> = {
  first_contacts: "first contacts",
  prospects_handled: "prospects handled",
  outcomes_produced: "outcomes produced",
};

/** `$10`, `$10.50`, `$9,000` from cents. */
export function dollars(cents: string | number | Decimal): string {
  const d = new Decimal(cents).dividedBy(100);
  const whole = d.isInteger();
  return `$${d.toNumber().toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  })}`;
}

function budgetLineText(b: BudgetLine): string {
  const name = b.funnelName ?? "A funnel the catalogue could not name";
  const label = b.triggerName ? `${name}, on each ${b.triggerName.toLowerCase()}` : name;
  const parts: string[] = [];
  if (b.amountCents != null && b.period) parts.push(`${dollars(b.amountCents)}${PER[b.period]}`);
  if (b.volume) {
    const unit = b.volume.unit ? ` ${UNIT_WORDS[b.volume.unit]}` : "";
    parts.push(`up to ${b.volume.count.toLocaleString("en-US")}${unit}${PER[b.volume.period]}`);
  }
  return `• ${label}: ${parts.join(", ")}`;
}

/** PURE: the whole message body (the org header and id line are added by `deliver`). */
export function composeStripeStepText(input: {
  stripeLine: string;
  acceptedLine: string | null;
  budgets: BudgetLine[];
  monthlyLimitCents: number | null;
}): string {
  const lines = [input.stripeLine];
  if (input.acceptedLine) lines.push(input.acceptedLine);
  if (input.budgets.length === 0) {
    lines.push("Campaign budgets: none set yet.");
  } else {
    lines.push("Campaign budgets:");
    for (const b of input.budgets) lines.push(budgetLineText(b));
    const totals = new Map<CapPeriod, Decimal>();
    for (const b of input.budgets) {
      if (b.amountCents == null || !b.period) continue;
      totals.set(b.period, (totals.get(b.period) ?? new Decimal(0)).plus(b.amountCents));
    }
    const total = PERIOD_ORDER.filter((p) => totals.has(p)).map((p) => `${dollars(totals.get(p)!)}${PER[p]}`);
    if (total.length > 0) lines.push(`Total: ${total.join(" + ")}`);
  }
  lines.push(
    input.monthlyLimitCents != null
      ? `Monthly charge limit: ${dollars(input.monthlyLimitCents)}`
      : "Monthly charge limit: none"
  );
  return lines.join("\n");
}

async function funnelSoft(id: string): Promise<SalesFunnel | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      getSalesFunnel(id),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CATALOGUE_WAIT_MS);
      }),
    ]);
  } catch (err) {
    console.error(`[billing-service] card step alert: funnel ${id} unreadable:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Every stated cap of the org, in plain words, oldest first. */
export async function readOrgBudgetLines(orgId: string): Promise<BudgetLine[]> {
  const rows: SalesFunnelCapRow[] = await db
    .select()
    .from(salesFunnelCaps)
    .where(eq(salesFunnelCaps.orgId, orgId))
    .orderBy(salesFunnelCaps.createdAt);
  const out: BudgetLine[] = [];
  for (const row of rows) {
    if (row.maxBudgetCents == null && row.maxVolume == null) continue;
    const funnel = await funnelSoft(row.salesFunnelId);
    const reactive = (funnel?.type ?? row.salesFunnelType) === "reactive";
    out.push({
      funnelName: funnel?.name ?? null,
      triggerName: reactive ? (funnel?.triggerName ?? null) : null,
      amountCents: row.maxBudgetCents,
      period: (row.maxBudgetPeriod as CapPeriod | null) ?? null,
      volume:
        row.maxVolume != null && row.maxVolumePeriod
          ? { count: row.maxVolume, period: row.maxVolumePeriod as CapPeriod, unit: funnel ? await volumeUnitFor(funnel) : null }
          : null,
    });
  }
  return out;
}

// --- the sweep ---------------------------------------------------------------

export async function runStripeStepAlertSweep(now: Date = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
  // Claim due rows atomically: a second sweep (or replica) never sends one twice.
  const claimed = await db
    .update(ownerStripeStepAlerts)
    .set({ settledAt: now, outcome: "sending" })
    .where(
      or(
        and(isNull(ownerStripeStepAlerts.settledAt), lte(ownerStripeStepAlerts.dueAt, now)),
        // A send cut by a restart mid-way is taken again (claimed > 5 min ago, never settled).
        and(
          eq(ownerStripeStepAlerts.outcome, "sending"),
          lte(ownerStripeStepAlerts.settledAt, new Date(now.getTime() - STALE_SENDING_MS))
        )
      )
    )
    .returning();
  const r = { sent: 0, skipped: 0, failed: 0 };
  for (const row of claimed) {
    let outcome: "sent" | "skipped" | "failed";
    try {
      const [budgets, limit] = await Promise.all([readOrgBudgetLines(row.orgId), getMonthlyChargeLimit(row.orgId)]);
      const text = composeStripeStepText({
        stripeLine: row.stripeLine,
        acceptedLine: row.acceptedLine,
        budgets,
        monthlyLimitCents: limit?.limitCents ?? null,
      });
      outcome = await deliver(
        { orgId: row.orgId, emoji: "💳", text, dedupKey: row.dedupKey },
        { email: row.actorEmail, userId: row.actorUserId }
      );
    } catch (err) {
      console.error(`[billing-service] card step alert failed for org ${row.orgId} (${row.dedupKey}):`, err);
      outcome = "failed";
    }
    r[outcome]++;
    if (outcome === "failed" && now.getTime() - row.createdAt.getTime() < GIVE_UP_MS) {
      // Released for the next tick.
      await db
        .update(ownerStripeStepAlerts)
        .set({ settledAt: null, outcome: null })
        .where(eq(ownerStripeStepAlerts.dedupKey, row.dedupKey));
    } else {
      await db
        .update(ownerStripeStepAlerts)
        .set({ outcome: outcome === "failed" ? "given_up" : outcome })
        .where(eq(ownerStripeStepAlerts.dedupKey, row.dedupKey));
    }
  }
  return r;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startStripeStepAlertScheduler(): void {
  const tick = async () => {
    if (!running) {
      running = true;
      try {
        const r = await runStripeStepAlertSweep();
        if (r.sent + r.skipped + r.failed > 0) {
          console.log(`[billing-service] card step alerts: sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`);
        }
      } catch (err) {
        console.error("[billing-service] card step alert sweep failed:", err);
      } finally {
        running = false;
      }
    }
    timer = setTimeout(tick, TICK_MS);
  };
  timer = setTimeout(tick, FIRST_TICK_MS);
}

export function stopStripeStepAlertScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
