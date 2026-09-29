/**
 * Compose the staff `brand_daily_budget_changed` email. Pure: every source has
 * already been read (or failed to), so this only decides the words.
 *
 * WHAT A READER MUST GET IN FIVE SECONDS: which mission moved and by how much,
 * and what the brand now spends per day. The previous email summed every
 * ceiling into one "Running" figure: on 2026-09-29 NOVEMIQ's Herald went
 * $10 → $7/day and staff read "$13/day → $10/day", because Pilot's $3 (a
 * REACTIVE cap that only spends when a positive reply triggers it) was folded in.
 *
 * THREE RULES THIS MODULE HOLDS:
 *  - One line per mission this write changed, named by its crew, channel,
 *    outcome and offer — never a brand-wide sum standing in for them.
 *  - The daily total counts ONLY running entry-leg missions (they spend every
 *    day). A reactive leg's figure is a CAP and is listed on its own, never
 *    added. A mission we cannot classify is listed apart and never added either.
 *  - A source that could not be read is SAID, for the part it feeds. No figure
 *    is guessed and none is merged to cover for a gap.
 *
 * A PAUSE OR RESTART IS THE SAME EMAIL. Pausing a mission (campaign-service owns
 * the status) moves the brand's real daily spend exactly as lowering its ceiling
 * does, so staff get the same composition: the mission and its move under "What
 * changed", then the daily total, reactive caps and paused missions as they
 * stand AFTER the move. A status change carries no amount change, so its line
 * states the ceiling the mission keeps.
 */

import { Decimal } from "decimal.js";
import type { CrewCatalogue, OrgIdentity } from "./budget-change-context.js";
import type { SpendableBudget } from "./campaign-service-client.js";

export const ADMIN_CONSOLE_URL = "https://admin.distribute.you";

/** A ceiling as the write left it (or a change's grain). */
export interface MissionGrain {
  featureSlug: string | null;
  offerId: string | null;
  legKey: string | null;
}

export interface MissionCeiling extends MissionGrain {
  dailyBudgetCents: string;
}

export interface MissionChange extends MissionGrain {
  previousDailyBudgetCents: string;
  newDailyBudgetCents: string;
}

/** A person paused or restarted a mission (campaign-service's status). */
export type MissionStatusMove = "paused" | "restarted";

export interface MissionStatusChange extends MissionGrain {
  move: MissionStatusMove;
}

export interface BudgetChangeEmailInput {
  brandId: string;
  orgId: string;
  /** The brand never had a budget before this write. */
  firstBudget: boolean;
  changes: MissionChange[];
  /** Missions a person paused or restarted; empty for a budget write. */
  statusChanges?: MissionStatusChange[];
  /** Every ceiling as it stands AFTER the write. */
  ceilings: MissionCeiling[];
  /** billing's own ceiling read failed (status notification only): no amount is stated. */
  ceilingsUnavailable?: boolean;
  brandName: string | null;
  org: OrgIdentity | null;
  offerNames: Map<string, string> | null;
  catalogue: CrewCatalogue | null;
  /** campaign-service's answer; null when it could not be read. */
  spendable: SpendableBudget | null;
}

export interface BudgetChangeEmail {
  /** What the person did, for the template's first line ("{{email}} {{action}}."). */
  action: string;
  subject: string;
  summaryHtml: string;
  summaryText: string;
}

/** daily = entry leg; reactive = starts from a step (a cap); brand = the brand-wide scalar; unknown = unclassifiable. */
export type MissionKind = "daily" | "reactive" | "brand" | "unknown";

interface Described {
  crew: string;
  label: string;
  kind: MissionKind;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function key(g: MissionGrain): string {
  return [g.featureSlug ?? "", (g.offerId ?? "").toLowerCase(), g.legKey ?? ""].join(
    "\u0000"
  );
}

function wholeDollars(cents: Decimal): string {
  return cents.dividedBy(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

/** `$7/day`, `$3 cap`, or a plain `$3` when we cannot say which. */
export function formatAmount(cents: string | Decimal, kind: MissionKind): string {
  const d = new Decimal(cents);
  const dollars = `$${wholeDollars(d)}`;
  if (kind === "reactive") return `${dollars} cap`;
  if (kind === "unknown") return dollars;
  return `${dollars}/day`;
}

export function describeMission(
  g: MissionGrain,
  catalogue: CrewCatalogue | null,
  offerNames: Map<string, string> | null
): Described {
  if (g.featureSlug === null) {
    return {
      crew: "Brand-wide budget",
      label: "Brand-wide budget (no mission)",
      kind: "brand",
    };
  }
  const channel = catalogue?.get(g.featureSlug) ?? null;
  const leg = g.legKey && channel ? (channel.legs.get(g.legKey) ?? null) : null;
  const channelName = channel?.name ?? g.featureSlug;

  let kind: MissionKind = "unknown";
  if (leg) kind = leg.fromLabel === null ? "daily" : "reactive";

  const crew = leg
    ? (leg.crewName ?? "Unnamed crew")
    : catalogue === null
      ? "Crew unavailable"
      : "Unknown crew";

  const outcome = leg
    ? leg.fromLabel
      ? `${leg.fromLabel} → ${leg.toLabel ?? "?"}`
      : (leg.toLabel ?? "?")
    : g.legKey
      ? `leg ${g.legKey} (not in the crew catalogue)`
      : "no leg stated";

  let offer: string;
  if (g.offerId === null) offer = "no offer";
  else if (offerNames === null) offer = `offer name unavailable (${g.offerId.slice(0, 8)})`;
  else {
    const name = offerNames.get(g.offerId.toLowerCase());
    offer = name ? `offer "${name}"` : `unknown offer (${g.offerId.slice(0, 8)})`;
  }

  return { crew, label: `${crew} · ${channelName} · ${outcome} · ${offer}`, kind };
}

/** `$10/day → $7/day (−$3, −30%)`. */
export function formatChange(change: MissionChange, kind: MissionKind): string {
  const before = new Decimal(change.previousDailyBudgetCents);
  const after = new Decimal(change.newDailyBudgetCents);
  const from = before.isZero() ? "$0" : formatAmount(before, kind);
  const to = after.isZero() ? "paused ($0)" : formatAmount(after, kind);
  const delta = after.minus(before);
  const sign = delta.isNegative() ? "−" : "+";
  const deltaText = `${sign}$${wholeDollars(delta.abs())}`;
  const pct = before.isZero()
    ? "new"
    : `${sign}${delta.abs().dividedBy(before).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0)}%`;
  return `${from} → ${to} (${deltaText}, ${pct})`;
}

type Direction = "raised" | "lowered" | "paused" | "reallocated";

function directionOf(changes: MissionChange[]): Direction {
  let up = 0;
  let down = 0;
  let zeroed = 0;
  for (const c of changes) {
    const cmp = new Decimal(c.newDailyBudgetCents).comparedTo(c.previousDailyBudgetCents);
    if (cmp > 0) up++;
    else if (cmp < 0) {
      down++;
      if (new Decimal(c.newDailyBudgetCents).isZero()) zeroed++;
    }
  }
  if (up > 0 && down > 0) return "reallocated";
  if (up > 0) return "raised";
  if (down > 0 && zeroed === down) return "paused";
  return "lowered";
}

function joinNames(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? "a mission";
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

/** The ceiling a mission holds after the write, as `$7/day` / `$3 cap`; null when none is stated. */
function ceilingOf(
  g: MissionGrain,
  ceilings: MissionCeiling[],
  kind: MissionKind
): string | null {
  const row = ceilings.find((c) => key(c) === key(g));
  if (!row || new Decimal(row.dailyBudgetCents).isZero()) return null;
  return formatAmount(row.dailyBudgetCents, kind);
}

/** `paused ($7/day kept)` / `restarted ($7/day)` / `paused (no budget set)`. */
export function formatStatusMove(move: MissionStatusMove, amount: string | null): string {
  if (move === "paused") return amount ? `paused (${amount} kept)` : "paused (no budget set)";
  return amount ? `restarted (${amount})` : "restarted (no budget set, so it cannot spend)";
}

export function buildBudgetChangeEmail(input: BudgetChangeEmailInput): BudgetChangeEmail {
  const { catalogue, offerNames, spendable } = input;
  const brand = input.brandName ?? "A brand";
  const describe = (g: MissionGrain) => describeMission(g, catalogue, offerNames);
  const statusDescribed = (input.statusChanges ?? []).map((s) => {
    const d = describe(s);
    return { s, d, amount: ceilingOf(s, input.ceilings, d.kind) };
  });

  // --- subject: direction + brand + crew -------------------------------------
  const described = input.changes.map((c) => ({ change: c, d: describe(c) }));
  const crews = joinNames(described.map((x) => x.d.crew));
  let subject: string;
  let action = "changed a daily budget";
  if (input.changes.length === 0 && statusDescribed.length > 0) {
    const moves = new Set(statusDescribed.map((x) => x.s.move));
    const move = moves.size === 1 ? [...moves][0] : null;
    action = move === "paused" ? "paused a mission" : move === "restarted" ? "restarted a mission" : "paused and restarted missions";
    const who = joinNames(statusDescribed.map((x) => x.d.crew));
    if (statusDescribed.length === 1) {
      const { s, amount } = statusDescribed[0];
      subject = `${brand} ${formatStatusMove(s.move, amount).replace(/^(\w+)/, `$1 ${who}`)}`;
    } else {
      subject = `${brand} ${move ?? "paused and restarted"} ${who}`;
    }
  } else if (input.firstBudget) {
    const set = described
      .filter((x) => !new Decimal(x.change.newDailyBudgetCents).isZero())
      .map((x) => `${x.d.crew} ${formatAmount(x.change.newDailyBudgetCents, x.d.kind)}`);
    subject = `${brand} set a first budget: ${set.join(", ") || crews}`;
  } else {
    const direction = directionOf(input.changes);
    if (described.length === 1) {
      const { change, d } = described[0];
      subject =
        direction === "paused"
          ? `${brand} paused ${d.crew} ($0)`
          : `${brand} ${direction} ${d.crew}: ${formatChange(change, d.kind).replace(/ \(.*\)$/, "")}`;
    } else {
      subject =
        direction === "paused"
          ? `${brand} paused ${crews} ($0)`
          : `${brand} ${direction} ${crews}`;
    }
  }

  // --- what changed ------------------------------------------------------------
  const changedLines = [
    ...described.map(({ change, d }) => `${d.label}: ${formatChange(change, d.kind)}`),
    ...statusDescribed.map(({ s, d, amount }) => `${d.label}: ${formatStatusMove(s.move, amount)}`),
  ];

  // --- what the brand now runs -------------------------------------------------
  const runningOf = (g: MissionGrain): boolean | null => {
    if (!spendable) return null;
    const row = spendable.rows.find((r) => key(r) === key(g));
    return row ? row.running : false;
  };

  const daily: string[] = [];
  const reactive: string[] = [];
  const paused: string[] = [];
  const unclassified: string[] = [];
  const statusUnknown: string[] = [];
  let dailyTotal = new Decimal(0);
  let runningUnclassified = 0;

  for (const ceiling of input.ceilings) {
    const amount = new Decimal(ceiling.dailyBudgetCents);
    if (amount.isZero()) continue;
    const d = describe(ceiling);
    const line = `${d.label}: ${formatAmount(amount, d.kind)}`;
    const running = runningOf(ceiling);
    if (running === null) {
      statusUnknown.push(line);
      continue;
    }
    if (!running) {
      paused.push(`${line} kept`);
      continue;
    }
    if (d.kind === "daily" || d.kind === "brand") {
      daily.push(line);
      dailyTotal = dailyTotal.plus(amount);
    } else if (d.kind === "reactive") {
      reactive.push(line);
    } else {
      unclassified.push(line);
      runningUnclassified++;
    }
  }

  let dailyHeadline: string;
  const notes: string[] = [];
  if (!spendable) {
    dailyHeadline = "Daily spend now: unavailable";
    notes.push(
      "Campaign statuses could not be read from campaign-service, so we cannot say which missions are running. Every funded mission is listed below with its amount, and no total is stated."
    );
  } else {
    dailyHeadline = `Daily spend now: ${formatAmount(dailyTotal, "daily")}`;
    if (daily.length === 0) dailyHeadline += " (no daily mission is running)";
    if (runningUnclassified > 0) {
      dailyHeadline += `, not counting ${runningUnclassified} running mission${runningUnclassified > 1 ? "s" : ""} we could not classify`;
    }
  }
  if (!catalogue) {
    notes.push(
      "The crew catalogue (features-service) could not be read, so crews are unnamed and daily missions cannot be told apart from reactive caps."
    );
  }
  if (input.ceilingsUnavailable) {
    notes.push(
      "The mission budgets could not be read from billing, so no amount or daily total below is complete."
    );
  }
  if (!offerNames) notes.push("Offer names could not be read from brand-service.");
  if (!input.brandName) notes.push("The brand name could not be read from brand-service.");
  if (!input.org?.name) notes.push("The org name could not be read.");

  const orgName = input.org?.name ?? "unknown org";
  const adminUrl = input.org?.externalId
    ? `${ADMIN_CONSOLE_URL}/orgs/${input.org.externalId}/brands/${input.brandId}`
    : null;
  if (!adminUrl) notes.push("No admin console link: the org's Clerk id could not be read.");

  const sections: Array<{ title: string; lines: string[] }> = [
    { title: "What changed", lines: changedLines },
    { title: dailyHeadline, lines: daily },
    {
      title: "Reactive caps (spend only when triggered, never part of the daily total)",
      lines: reactive,
    },
    { title: "Running, not classified (not part of the daily total)", lines: unclassified },
    { title: "Paused (amount kept, not spending)", lines: paused },
    { title: "Funded, status unknown", lines: statusUnknown },
  ].filter((s, i) => i <= 1 || s.lines.length > 0);

  const intro = `${brand} (org ${orgName})`;

  const html: string[] = [`<p><strong>${escapeHtml(intro)}</strong></p>`];
  for (const s of sections) {
    html.push(`<p><strong>${escapeHtml(s.title)}</strong></p>`);
    if (s.lines.length > 0) {
      html.push(`<ul>${s.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`);
    }
  }
  for (const n of notes) html.push(`<p>${escapeHtml(n)}</p>`);
  if (adminUrl) {
    html.push(`<p><a href="${escapeHtml(adminUrl)}">Open ${escapeHtml(brand)} in the admin console</a></p>`);
  }
  html.push(
    `<p style="color:#888;font-size:12px">Brand id ${escapeHtml(input.brandId)} · Org id ${escapeHtml(input.orgId)}</p>`
  );

  const text: string[] = [intro, ""];
  for (const s of sections) {
    text.push(s.title);
    for (const l of s.lines) text.push(`- ${l}`);
    text.push("");
  }
  for (const n of notes) text.push(n);
  if (adminUrl) text.push(`Admin console: ${adminUrl}`);
  text.push(`Brand id ${input.brandId} · Org id ${input.orgId}`);

  return {
    action,
    subject,
    summaryHtml: html.join("\n"),
    summaryText: text.join("\n"),
  };
}
