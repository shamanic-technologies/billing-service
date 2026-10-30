/**
 * A customer's budget change, reported to crm-service (CLIENT-ACTIVITY-1030, owner
 * 2026-10-30: « ajouter une ligne quand un client update les budgets d'une de ses
 * campagnes … Aussi envoie un message TG »). crm-service files it as a line on the
 * client's staff Unibox thread and sends the owner ONE Telegram per fact; billing
 * sends no Telegram of its own for a budget change any more.
 *
 * Contract (crm-service `POST /internal/account-activity`, x-api-key): identity
 * headers forwarded (x-org-id required, x-user-id = who acted, x-email optional),
 * body `{producer, activityId, type, title, subject, changes, brandId, occurredAt}`,
 * idempotent on (producer, activityId).
 *
 * Rules:
 *  - Called AFTER the write committed, never awaited: `reportBudgetChange` returns at
 *    once and never throws, so crm-service down / slow / erroring cannot change the
 *    budget route's status, body or latency. Failures are logged loudly.
 *  - Only a PERSON's change: no x-user-id (a service write) or the platform sentinel
 *    reports nothing. Brand transfer, teardown and sweeps never reach this.
 *  - A no-op save (same caps) reports nothing: `budgetChangeLines` returns [].
 *  - No em / en dash in any text sent.
 */
import { Decimal } from "decimal.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { RFC_UUID } from "./client-service-client.js";
import type { CapPeriod } from "./sales-funnel-caps.js";

const PRODUCER = "billing-service";
const TIMEOUT_MS = 10_000;

export interface CapState {
  maxBudgetCents: string | null;
  maxBudgetPeriod: CapPeriod | string | null;
  maxVolume: number | null;
  maxVolumePeriod: CapPeriod | string | null;
}

export interface BudgetChangeLine {
  label: string;
  before: string;
  after: string;
}

const PERIOD_SUFFIX: Record<string, string> = {
  daily: "/day",
  weekly: "/week",
  monthly: "/month",
  one_off: " in total",
};

/** `$20`, `$0.30`, `$1,250.50`: cents kept only when the amount is not whole dollars. */
export function formatUsd(cents: string): string {
  const dollars = new Decimal(cents).dividedBy(100);
  const whole = dollars.isInteger();
  const fixed = whole ? dollars.toFixed(0) : dollars.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const [int, frac] = fixed.split(".");
  return `$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

function periodSuffix(period: string | null): string {
  return period ? (PERIOD_SUFFIX[period] ?? ` per ${period}`) : "";
}

function budgetText(s: CapState | null): string {
  if (!s || s.maxBudgetCents === null) return "none";
  return `${formatUsd(s.maxBudgetCents)}${periodSuffix(s.maxBudgetPeriod)}`;
}

function volumeText(s: CapState | null): string {
  if (!s || s.maxVolume === null) return "none";
  return `${s.maxVolume}${periodSuffix(s.maxVolumePeriod)}`;
}

/**
 * PURE: the lines a client reads for one caps write, before → after. [] = nothing
 * moved (a no-op save). A removed cap reads `after: "none"`.
 */
export function budgetChangeLines(before: CapState | null, after: CapState | null): BudgetChangeLine[] {
  const lines: BudgetChangeLine[] = [];
  const b = budgetText(before);
  const a = budgetText(after);
  if (b !== a) lines.push({ label: "Max budget", before: b, after: a });
  const vb = volumeText(before);
  const va = volumeText(after);
  if (vb !== va) lines.push({ label: "Max volume", before: vb, after: va });
  return lines;
}

export interface BudgetChangeReport {
  orgId: string;
  userId: string | null | undefined;
  email: string | null | undefined;
  /** Billing's own id for this fact (the change row), the idempotency key with the producer. */
  activityId: string;
  brandId: string;
  subject: { kind: string; id: string; name?: string | null };
  changes: BudgetChangeLine[];
  occurredAt: Date;
}

/** True when a person (not a service, not the platform sentinel) made the change. */
export function isPersonActor(userId: string | null | undefined): userId is string {
  return typeof userId === "string" && RFC_UUID.test(userId);
}

const stripDashes = (s: string) => s.replace(/[–—]/g, "-");

async function send(r: BudgetChangeReport & { userId: string }): Promise<void> {
  const url = process.env.CRM_SERVICE_URL;
  const apiKey = process.env.CRM_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.error(
      `[billing-service] [account-activity] CRM_SERVICE_URL / CRM_SERVICE_API_KEY not configured: budget change ${r.activityId} of org=${r.orgId} NOT reported`
    );
    return;
  }
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "content-type": "application/json",
    "x-org-id": r.orgId,
    "x-user-id": r.userId,
  };
  if (r.email && r.email.trim()) headers["x-email"] = r.email.trim();
  const body = {
    producer: PRODUCER,
    activityId: r.activityId,
    type: "campaign_budget_changed",
    title: "Budget changed",
    subject: {
      kind: r.subject.kind,
      id: r.subject.id,
      ...(r.subject.name ? { name: stripDashes(r.subject.name) } : {}),
    },
    changes: r.changes.map((c) => ({ label: stripDashes(c.label), before: stripDashes(c.before), after: stripDashes(c.after) })),
    brandId: r.brandId,
    occurredAt: r.occurredAt.toISOString(),
  };
  const res = await fetchWithRetry(`${url}/internal/account-activity`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`crm-service POST /internal/account-activity answered ${res.status} ${await res.text()}`);
  }
}

/**
 * Fire-and-forget: report one customer budget change to crm-service. Never throws,
 * never rejects; a service write, a sentinel actor or an empty change sends nothing.
 * `resolveName` (optional) names the subject; its failure only drops the name.
 */
export function reportBudgetChange(
  r: Omit<BudgetChangeReport, "subject"> & {
    subject: { kind: string; id: string };
    resolveName?: () => Promise<string | null>;
  }
): void {
  if (r.changes.length === 0) return;
  const userId = r.userId;
  if (!isPersonActor(userId)) return;
  void (async () => {
    let name: string | null = null;
    if (r.resolveName) {
      try {
        name = await r.resolveName();
      } catch (err) {
        console.error(`[billing-service] [account-activity] could not name ${r.subject.kind} ${r.subject.id}:`, err);
      }
    }
    await send({ ...r, userId, subject: { ...r.subject, name } });
  })().catch((err) => {
    console.error(
      `[billing-service] [account-activity] budget change ${r.activityId} of org=${r.orgId} NOT reported to crm-service:`,
      err
    );
  });
}
