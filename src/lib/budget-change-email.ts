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
 *  - Every mission this write changed is named, by channel (and outcome when
 *    two share a channel) and offer, with its own before and after; never a
 *    brand-wide sum standing in for them. (Crew names were retired 2026-10-04.)
 *  - The daily total counts ONLY running entry-leg missions (they spend every
 *    day). A reactive leg's figure is a CAP and is listed on its own, never
 *    added. A mission we cannot classify is listed apart and never added either.
 *  - A source that could not be read is SAID, for the part it feeds. No figure
 *    is guessed and none is merged to cover for a gap.
 *
 * A PAUSE OR RESTART IS THE SAME EMAIL. Pausing a mission (campaign-service owns
 * the status) moves the brand's real daily spend exactly as lowering its ceiling
 * does, so staff get the same composition, with every figure read AFTER the move.
 * A paused mission's amount is stated as "kept" only when billing still holds
 * it: a subscriber's plan reallocation DELETES an OFF campaign's row in the same
 * second (Legistai, 2026-10-06: "$3/day kept" for a row already gone), so the
 * route reallocates FIRST and composes after (routes/brand_budgets.ts).
 *
 * SHAPE (owner 2026-10-06, "wrong AND too messy"): the template's first line is
 * the action with the mission in it ("<actor> paused sales cold email outreach
 * (offer LegistAI)."), then one plain line per fact: "Spending now: $0/day.",
 * "Still on: AI meeting booking, up to $0.30/day, only when someone replies
 * they're interested.", a paused-and-kept line when any. EACH MISSION APPEARS
 * ONCE: a mission named in the action line is left out of the lines below it.
 * No section headings, no arrows, no em dashes. Sub-dollar amounts keep their
 * cents ($0.30); a non-zero amount never prints as $0.
 *
 * Channel names are the catalogue's `name` lowercased (acronyms kept: "AI
 * meeting booking"). features-service publishes no short channel name yet, so
 * "sales cold email outreach" is as short as we can say without hard-coding.
 */

import { Decimal } from "decimal.js";
import type { ChannelCatalogue, OrgIdentity } from "./budget-change-context.js";
import type { SpendableBudget } from "./campaign-service-client.js";
import { canonicalLegKey } from "./leg-identity.js";

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
  catalogue: ChannelCatalogue | null;
  /** campaign-service's answer; null when it could not be read. */
  spendable: SpendableBudget | null;
  /**
   * SALES FUNNEL campaigns of the brand that hold a RECURRING max budget
   * (lib/funnel-campaigns.ts): `running` = the `ongoing` ones, each counted in
   * "Spending now" at its cap per day. null = the brand has such caps but the
   * funnel campaigns could not be read (said in words, never counted as 0).
   * Absent = the brand has no recurring funnel cap.
   */
  funnels?: { running: FunnelSpend[] } | null;
}

/** A running sales funnel campaign and its recurring MAX BUDGET. */
export interface FunnelSpend {
  /** features-service's funnel name (`Victory`), else its id. */
  name: string;
  offerId: string;
  /** The cap per day (weekly / 7, monthly / 30). */
  dailyBudgetCents: string;
  /** The cap as stated, for the words (`$70/week`). */
  amountCents: string;
  period: "daily" | "weekly" | "monthly";
}

export interface BudgetChangeEmail {
  /** What the person did, for the template's first line ("{{email}} {{action}}."). Names the mission. */
  action: string;
  /** The same, HTML-escaped: it carries customer-typed names (offer, brand). */
  actionHtml: string;
  subject: string;
  summaryHtml: string;
  summaryText: string;
}

/** daily = entry leg; reactive = starts from a step (a cap); brand = the brand-wide scalar; unknown = unclassifiable. */
export type MissionKind = "daily" | "reactive" | "brand" | "unknown";

interface Mission {
  key: string;
  grain: MissionGrain;
  kind: MissionKind;
  /** `sales cold email outreach`, plus the outcome when the channel+offer is ambiguous here. */
  channel: string;
  /** Distinguishing outcome (`positive reply`), only when two missions share channel and offer. */
  outcome: string | null;
  /** `offer LegistAI` / `offer e59646e4, name unavailable` / null (no offer). */
  offer: string | null;
  /** Reactive only: `only when someone replies they're interested`. */
  trigger: string | null;
  /** The leg could not be named from the catalogue: `leg start_to_x, not in the channel catalogue`. */
  legNote: string | null;
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
  const leg = g.legKey === null ? "" : canonicalLegKey(g.featureSlug, g.legKey);
  return [g.featureSlug ?? "", (g.offerId ?? "").toLowerCase(), leg].join(
    "\u0000"
  );
}

/**
 * `$7`, `$0.30`, `$3.25`. Whole dollars print without cents, anything else with
 * two decimals, and a non-zero amount that rounds to nothing says so: never
 * `$0` for money that exists (Legistai's 30-cent cap printed "$0 cap").
 */
export function formatMoney(cents: string | Decimal): string {
  const dollars = new Decimal(cents).dividedBy(100);
  if (dollars.isZero()) return "$0";
  const rounded = dollars.abs().toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const sign = dollars.isNegative() ? "-" : "";
  if (rounded.isZero()) return `${sign}under $0.01`;
  return `${sign}$${rounded.isInteger() ? rounded.toFixed(0) : rounded.toFixed(2)}`;
}

export function perDay(cents: string | Decimal): string {
  return `${formatMoney(cents)}/day`;
}

/** `Sales Cold Email Outreach` → `sales cold email outreach`; acronyms stay (`AI meeting booking`). */
export function shortChannelName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w) ? w : w.toLowerCase()))
    .join(" ");
}

function lowerFirst(s: string): string {
  return s.length > 1 && s[1] === s[1].toUpperCase() && /[A-Z]/.test(s[1]) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function offerPhrase(offerId: string | null, offerNames: Map<string, string> | null): string | null {
  if (offerId === null) return null;
  if (offerNames === null) return `offer ${offerId.slice(0, 8)}, name unavailable`;
  const name = offerNames.get(offerId.toLowerCase());
  return name ? `offer ${name}` : `unknown offer ${offerId.slice(0, 8)}`;
}

/** Name every mission this email mentions, disambiguating only where needed. */
function describeAll(
  grains: MissionGrain[],
  catalogue: ChannelCatalogue | null,
  offerNames: Map<string, string> | null
): Map<string, Mission> {
  const out = new Map<string, Mission>();
  for (const g of grains) {
    const k = key(g);
    if (out.has(k)) continue;
    if (g.featureSlug === null) {
      out.set(k, { key: k, grain: g, kind: "brand", channel: "the brand-wide budget", outcome: null, offer: null, trigger: null, legNote: null });
      continue;
    }
    const channel = catalogue?.get(g.featureSlug) ?? null;
    const leg = g.legKey && channel ? (channel.legs.get(canonicalLegKey(g.featureSlug, g.legKey)) ?? null) : null;
    const name = channel?.name ? shortChannelName(channel.name) : g.featureSlug;
    const legNote = leg
      ? null
      : g.legKey
        ? catalogue === null
          ? `leg ${g.legKey}`
          : `leg ${g.legKey}, not in the channel catalogue`
        : "no leg stated";
    const reactive = leg ? (leg.reactive ?? leg.fromLabel !== null) : null;
    const kind: MissionKind = leg ? (reactive ? "reactive" : "daily") : "unknown";
    const trigger =
      kind === "reactive" && leg
        ? leg.fromShortDescription
          ? `only when someone ${lowerFirst(leg.fromShortDescription)}`
          : `only after a ${(leg.fromLabel ?? "trigger").toLowerCase()}`
        : null;
    out.set(k, {
      key: k,
      grain: g,
      kind,
      channel: name,
      outcome: leg?.toLabel ? leg.toLabel.toLowerCase() : null,
      offer: offerPhrase(g.offerId, offerNames),
      trigger,
      legNote,
    });
  }
  // Two missions on one channel and offer (two entry legs): name the outcome.
  const byChannelOffer = new Map<string, Mission[]>();
  for (const m of out.values()) {
    const k = `${m.grain.featureSlug}\u0000${(m.grain.offerId ?? "").toLowerCase()}`;
    byChannelOffer.set(k, [...(byChannelOffer.get(k) ?? []), m]);
  }
  for (const group of byChannelOffer.values()) {
    if (group.length < 2) for (const m of group) m.outcome = null;
  }
  return out;
}

/** `sales cold email outreach (offer LegistAI)`; the offer only when asked for. */
function nameOf(m: Mission, withOffer: boolean): string {
  const quals = [m.outcome, m.legNote, withOffer ? m.offer : null].filter((q): q is string => !!q);
  return quals.length ? `${m.channel} (${quals.join(", ")})` : m.channel;
}

/** `$7/day`, or `up to $0.30/day` for a reactive cap, or a plain `$3` when we cannot say which. */
function amountOf(cents: string | Decimal, kind: MissionKind): string {
  if (kind === "reactive") return `up to ${perDay(cents)}`;
  if (kind === "unknown") return formatMoney(cents);
  return perDay(cents);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function buildBudgetChangeEmail(input: BudgetChangeEmailInput): BudgetChangeEmail {
  const { catalogue, offerNames, spendable } = input;
  const brand = input.brandName ?? "A brand";
  const statusChanges = input.statusChanges ?? [];
  const ceilings = input.ceilings.filter((c) => !new Decimal(c.dailyBudgetCents).isZero());
  const missions = describeAll(
    [...input.changes, ...statusChanges, ...ceilings],
    catalogue,
    offerNames
  );
  const mission = (g: MissionGrain) => missions.get(key(g))!;
  const ceilingOf = (g: MissionGrain) => ceilings.find((c) => key(c) === key(g)) ?? null;
  // The lines under the action name the offer only when the brand has several.
  const offers = new Set([...missions.values()].map((m) => (m.grain.offerId ?? "").toLowerCase()));
  const offerInState = offers.size > 1;

  // --- the action (template line 1) and the subject ---------------------------
  const actionParts: string[] = [];
  const subjectParts: Array<{ name: string; verb: string; tail: string }> = [];
  for (const c of input.changes) {
    const m = mission(c);
    const before = new Decimal(c.previousDailyBudgetCents);
    const after = new Decimal(c.newDailyBudgetCents);
    const to = amountOf(after, m.kind);
    if (input.firstBudget || before.isZero()) {
      actionParts.push(`set ${nameOf(m, true)} to ${to}`);
      subjectParts.push({ name: nameOf(m, false), verb: "set", tail: ` to ${to}` });
    } else {
      const verb = after.greaterThan(before) ? "raised" : "lowered";
      actionParts.push(`${verb} ${nameOf(m, true)} from ${amountOf(before, m.kind)} to ${to}`);
      subjectParts.push({ name: nameOf(m, false), verb, tail: ` to ${to}` });
    }
  }
  for (const s of statusChanges) {
    const m = mission(s);
    const row = ceilingOf(s);
    if (s.move === "paused") {
      actionParts.push(
        `paused ${nameOf(m, true)}${row ? `, ${amountOf(row.dailyBudgetCents, m.kind)} budget kept` : ""}`
      );
    } else {
      actionParts.push(
        `restarted ${nameOf(m, true)}${
          row
            ? ` at ${amountOf(row.dailyBudgetCents, m.kind)}`
            : input.ceilingsUnavailable
              ? ""
              : ", with no budget set so it cannot spend"
        }`
      );
    }
    subjectParts.push({ name: nameOf(m, false), verb: s.move, tail: "" });
  }
  const action = actionParts.join("; ") || "changed a daily budget";

  let subject: string;
  if (subjectParts.length === 1) {
    const [p] = subjectParts;
    subject = input.firstBudget
      ? `${brand}: first budget, ${p.name}${p.tail}`
      : `${brand}: ${p.name} ${p.verb}${p.tail}`;
  } else {
    const verbs = new Set(subjectParts.map((p) => p.verb));
    const verb = input.firstBudget ? "first budgets set" : verbs.size === 1 ? [...verbs][0] : "changed";
    subject = `${brand}: ${joinList([...new Set(subjectParts.map((p) => p.name))])} ${verb}`;
  }

  // --- the state after the move, each mission once -----------------------------
  const moved = new Set([...input.changes, ...statusChanges].map(key));
  const runningOf = (g: MissionGrain): boolean | null => {
    if (!spendable) return null;
    const row = spendable.rows.find((r) => key(r) === key(g));
    return row ? row.running : false;
  };

  let dailyTotal = new Decimal(0);
  let movedCountsDaily = false;
  const otherDaily: string[] = [];
  const stillOn: string[] = [];
  const paused: string[] = [];
  const unclassified: string[] = [];
  let movedUnclassified = false;
  const statusUnknown: string[] = [];

  for (const ceiling of ceilings) {
    const m = mission(ceiling);
    const amount = new Decimal(ceiling.dailyBudgetCents);
    const isMoved = moved.has(m.key);
    const running = runningOf(ceiling);
    if (running === null) {
      if (!isMoved) statusUnknown.push(`${nameOf(m, offerInState)} ${amountOf(amount, m.kind)}`);
      continue;
    }
    if (!running) {
      if (!isMoved) paused.push(`${nameOf(m, offerInState)} ${amountOf(amount, m.kind)}`);
      continue;
    }
    if (m.kind === "daily" || m.kind === "brand") {
      dailyTotal = dailyTotal.plus(amount);
      if (isMoved) movedCountsDaily = true;
      else otherDaily.push(`${nameOf(m, offerInState)} at ${perDay(amount)}`);
    } else if (m.kind === "reactive") {
      if (!isMoved) {
        stillOn.push(`Still on: ${nameOf(m, offerInState)}, ${amountOf(amount, m.kind)}, ${m.trigger}.`);
      }
    } else if (!isMoved) {
      unclassified.push(`${nameOf(m, offerInState)} ${amountOf(amount, m.kind)}`);
    } else {
      movedUnclassified = true;
    }
  }

  const lines: string[] = [];
  if (!spendable) {
    lines.push("Spending now: unknown, campaign statuses could not be read.");
    if (statusUnknown.length > 0) lines.push(`Budgets set, status unknown: ${statusUnknown.join("; ")}.`);
  } else {
    // Running SALES FUNNEL campaigns spend up to their recurring max budget.
    for (const f of input.funnels?.running ?? []) {
      dailyTotal = dailyTotal.plus(f.dailyBudgetCents);
      const offer = offerPhrase(f.offerId, offerNames);
      const stated = f.period === "daily" ? "" : ` (${formatMoney(f.amountCents)}/${f.period === "weekly" ? "week" : "month"})`;
      otherDaily.push(`sales funnel ${f.name}${offer ? ` (${offer})` : ""} at ${perDay(f.dailyBudgetCents)}${stated}`);
    }
    let spending = `Spending now: ${perDay(dailyTotal)}`;
    if (otherDaily.length > 0) {
      spending += movedCountsDaily ? `, with ${joinList(otherDaily)}` : ` on ${joinList(otherDaily)}`;
    }
    if (unclassified.length > 0) {
      spending += `, not counting ${joinList(unclassified)} (running, could not be classified)`;
    }
    if (input.funnels === null) {
      spending += ", not counting sales funnel campaigns (they could not be read)";
    }
    if (movedUnclassified) {
      spending += `, not counting the mission${actionParts.length > 1 ? "s" : ""} above (running, could not be classified)`;
    }
    lines.push(`${spending}.`);
    lines.push(...stillOn);
    if (paused.length > 0) lines.push(`Paused, budget kept: ${paused.join("; ")}.`);
  }
  if (!catalogue) {
    lines.push("The channel catalogue could not be read, so channels show by slug and nothing is counted as daily spend.");
  }
  if (input.ceilingsUnavailable) {
    lines.push("The budgets could not be read from billing, so no amount here is complete.");
  }
  if (!input.brandName) lines.push("The brand name could not be read.");

  const adminUrl = input.org?.externalId
    ? `${ADMIN_CONSOLE_URL}/orgs/${input.org.externalId}/brands/${input.brandId}`
    : null;
  if (!adminUrl) lines.push("No admin link: the org's Clerk id could not be read.");
  const footer = `Org ${input.org?.name ?? "name unavailable"} · Brand id ${input.brandId} · Org id ${input.orgId}`;

  const html: string[] = lines.map((l) => `<p>${escapeHtml(l)}</p>`);
  if (adminUrl) html.push(`<p><a href="${escapeHtml(adminUrl)}">Open in admin</a></p>`);
  html.push(`<p style="color:#888;font-size:12px">${escapeHtml(footer)}</p>`);

  const text: string[] = [...lines, ""];
  if (adminUrl) text.push(`Open in admin: ${adminUrl}`);
  text.push(footer);

  return {
    action,
    actionHtml: escapeHtml(action),
    subject,
    summaryHtml: html.join("\n"),
    summaryText: text.join("\n"),
  };
}
