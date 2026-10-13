import { Decimal } from "decimal.js";
import { PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO } from "./platform-absorbed.js";
import { db } from "../db/index.js";
import { billingAccounts, platformOrgs } from "../db/schema.js";
import { fetchRunsNoCampaignMonthly } from "./runs-client.js";
import { fetchAcquiringFeesByOrgMonth } from "./stripe-service-client.js";
import { getOrgCash } from "./org-cash.js";
import { resolveOrgDisplayIdentity } from "./brand-service-client.js";

/**
 * The cost the platform ABSORBS, per customer and over time, for the staff
 * "Monitoring" page (owner 2026-10-13: « follow each customer: cost to us that we
 * don't fee … avg, avg over time since inception, distribution, cost per month,
 * cost per month per customer, snapshot and line chart since inception »).
 *
 * Absorbed = spend with NO campaign (runs-service: Copilot chat, onboarding, A/B work)
 * + card-acquiring fees (stripe-service, both acquirers). One basis since inception:
 * before `PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO` the figure is what WOULD have been
 * absorbed under the rule (the org was billed for it then); from it on, what was.
 *
 * Every figure the page draws is served here; the browser computes nothing.
 * Our own platform orgs are listed apart and kept out of every fleet statistic.
 * A source we could not read is a 502 upstream, never a zero.
 */

export interface SpendMonthRow {
  orgId: string;
  /** `YYYY-MM`, UTC. */
  month: string;
  /** Spend with no campaign, net, card-acquiring fees EXCLUDED (they come from the fee source). */
  noCampaignCents: string;
  /** Campaign spend the org was billed for that month (context). */
  campaignCents: string;
}

export interface FeeMonthRow {
  /** null = a fee stripe-service could not tie to an org. */
  orgId: string | null;
  month: string;
  /** Lowercase ISO currency. Only "usd" enters the USD figures; any other is served apart, never converted. */
  currency: string;
  feeCents: string;
}

export interface AccountContext {
  orgId: string;
  createdAt: Date;
  paymentMode: string;
  freeCreditOffer: string;
}

export interface CustomerIdentity {
  name: string | null;
  domain: string | null;
}

export interface AbsorbedInputs {
  spend: SpendMonthRow[];
  fees: FeeMonthRow[];
  accounts: AccountContext[];
  platformOrgIds: Set<string>;
  /** Cash the org paid (lib/org-cash), null = unreadable. Absent = not asked. */
  cashPaidCents: Map<string, string | null>;
  identities: Map<string, CustomerIdentity | null>;
  now: Date;
}

export const DISTRIBUTION_BUCKETS_CENTS: Array<{ label: string; min: number; max: number | null }> = [
  { label: "$0", min: 0, max: 0 },
  { label: "under $1", min: 0, max: 100 },
  { label: "$1 to $5", min: 100, max: 500 },
  { label: "$5 to $20", min: 500, max: 2000 },
  { label: "$20 to $50", min: 2000, max: 5000 },
  { label: "$50 to $100", min: 5000, max: 10000 },
  { label: "$100 to $500", min: 10000, max: 50000 },
  { label: "$500 and more", min: 50000, max: null },
];

const D = (v: string | number | Decimal) => new Decimal(v);
const fx = (d: Decimal) => d.toFixed(10);

function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

interface Cell { noCampaign: Decimal; fees: Decimal; campaign: Decimal; other: Map<string, Decimal> }
const zero = (): Cell => ({ noCampaign: D(0), fees: D(0), campaign: D(0), other: new Map() });

function addOther(into: Map<string, Decimal>, currency: string, cents: Decimal | string) {
  into.set(currency, (into.get(currency) ?? D(0)).plus(cents));
}
function otherWire(m: Map<string, Decimal>) {
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, c]) => ({ currency, feeCents: fx(c) }));
}

function bucketOf(cents: Decimal): number {
  if (cents.isZero()) return 0;
  for (let i = 1; i < DISTRIBUTION_BUCKETS_CENTS.length; i++) {
    const b = DISTRIBUTION_BUCKETS_CENTS[i];
    if (b.max === null || cents.lessThan(b.max)) return i;
  }
  return DISTRIBUTION_BUCKETS_CENTS.length - 1;
}

export function composeAbsorbedCosts(inp: AbsorbedInputs) {
  const cells = new Map<string, Map<string, Cell>>(); // org -> month -> cell
  const cell = (org: string, month: string) => {
    let byMonth = cells.get(org);
    if (!byMonth) { byMonth = new Map(); cells.set(org, byMonth); }
    let c = byMonth.get(month);
    if (!c) { c = zero(); byMonth.set(month, c); }
    return c;
  };
  const unattributedFees = new Map<string, Decimal>();
  const unattributedOther = new Map<string, Map<string, Decimal>>();
  const allMonths = new Set<string>();
  for (const r of inp.spend) {
    const c = cell(r.orgId, r.month);
    c.noCampaign = c.noCampaign.plus(r.noCampaignCents);
    c.campaign = c.campaign.plus(r.campaignCents);
    allMonths.add(r.month);
  }
  for (const r of inp.fees) {
    allMonths.add(r.month);
    const usd = r.currency === "usd";
    if (r.orgId === null) {
      if (usd) unattributedFees.set(r.month, (unattributedFees.get(r.month) ?? D(0)).plus(r.feeCents));
      else {
        const m = unattributedOther.get(r.month) ?? new Map<string, Decimal>();
        addOther(m, r.currency, r.feeCents);
        unattributedOther.set(r.month, m);
      }
      continue;
    }
    const c = cell(r.orgId, r.month);
    if (usd) c.fees = c.fees.plus(r.feeCents);
    else addOther(c.other, r.currency, r.feeCents);
  }
  const accountByOrg = new Map(inp.accounts.map((a) => [a.orgId, a]));
  for (const a of inp.accounts) allMonths.add(monthOf(a.createdAt));
  const sorted = [...allMonths].sort();
  const months = sorted.length ? monthsBetween(sorted[0], monthOf(inp.now) > sorted[sorted.length - 1] ? monthOf(inp.now) : sorted[sorted.length - 1]) : [];

  const orgIds = new Set<string>([...cells.keys(), ...inp.accounts.map((a) => a.orgId)]);
  const customers = [...orgIds].map((orgId) => {
    const byMonth = cells.get(orgId) ?? new Map<string, Cell>();
    const acc = accountByOrg.get(orgId) ?? null;
    const cash = inp.cashPaidCents.has(orgId) ? inp.cashPaidCents.get(orgId)! : null;
    const total = zero();
    const series = months
      .filter((m) => byMonth.has(m))
      .map((m) => {
        const c = byMonth.get(m)!;
        total.noCampaign = total.noCampaign.plus(c.noCampaign);
        total.fees = total.fees.plus(c.fees);
        total.campaign = total.campaign.plus(c.campaign);
        for (const [cur, v] of c.other) addOther(total.other, cur, v);
        return {
          month: m,
          absorbedCents: fx(c.noCampaign.plus(c.fees)),
          noCampaignSpendCents: fx(c.noCampaign),
          cardFeesCents: fx(c.fees),
          cardFeesOtherCurrencies: otherWire(c.other),
          campaignSpendCents: fx(c.campaign),
        };
      });
    const absorbed = total.noCampaign.plus(total.fees);
    const identity = inp.identities.get(orgId) ?? null;
    return {
      orgId,
      orgName: identity?.name ?? null,
      orgDomain: identity?.domain ?? null,
      platformOrg: inp.platformOrgIds.has(orgId),
      hasBillingAccount: acc !== null,
      createdAt: acc ? acc.createdAt.toISOString() : null,
      paymentMode: acc?.paymentMode ?? null,
      freeCreditOffer: acc?.freeCreditOffer ?? null,
      cashPaidCents: cash,
      /** null = cash unreadable (never read as "never paid"). */
      paying: cash === null ? null : D(cash).greaterThan(0),
      absorbedCents: fx(absorbed),
      noCampaignSpendCents: fx(total.noCampaign),
      cardFeesCents: fx(total.fees),
      cardFeesOtherCurrencies: otherWire(total.other),
      campaignSpendCents: fx(total.campaign),
      firstAbsorbedMonth: series.find((s) => D(s.absorbedCents).greaterThan(0))?.month ?? null,
      byMonth: series,
      _absorbed: absorbed,
    };
  });
  customers.sort((a, b) => b._absorbed.comparedTo(a._absorbed) || a.orgId.localeCompare(b.orgId));

  const counted = customers.filter((c) => !c.platformOrg);
  const groupStats = (group: typeof counted) => {
    const withCost = group.filter((c) => c._absorbed.greaterThan(0));
    const total = withCost.reduce((s, c) => s.plus(c._absorbed), D(0));
    return {
      customers: group.length,
      customersWithAbsorbedCost: withCost.length,
      absorbedCents: fx(total),
      averagePerCustomerCents: group.length ? fx(total.div(group.length)) : null,
      averagePerCustomerWithCostCents: withCost.length ? fx(total.div(withCost.length)) : null,
      medianPerCustomerWithCostCents: withCost.length ? fx(median(withCost.map((c) => c._absorbed))) : null,
    };
  };

  // Per month, fleet: the month's absorbed cost, the customers who cost something that
  // month, and the running since-inception average per customer (cumulative absorbed ÷
  // customers who had cost anything by then).
  const seen = new Set<string>();
  let cumulative = D(0);
  const fleetByMonth = months.map((m) => {
    let noCampaign = D(0), fees = D(0), campaign = D(0), payingAbs = D(0), neverPaidAbs = D(0);
    const other = new Map<string, Decimal>();
    let n = 0, nPaying = 0, nNeverPaid = 0;
    for (const c of counted) {
      const cm = c.byMonth.find((s) => s.month === m);
      if (!cm) continue;
      noCampaign = noCampaign.plus(cm.noCampaignSpendCents);
      fees = fees.plus(cm.cardFeesCents);
      for (const o of cm.cardFeesOtherCurrencies) addOther(other, o.currency, o.feeCents);
      campaign = campaign.plus(cm.campaignSpendCents);
      const abs = D(cm.absorbedCents);
      if (abs.greaterThan(0)) {
        n += 1;
        seen.add(c.orgId);
        if (c.paying === true) { nPaying += 1; payingAbs = payingAbs.plus(abs); }
        if (c.paying === false) { nNeverPaid += 1; neverPaidAbs = neverPaidAbs.plus(abs); }
      }
    }
    const unattr = unattributedFees.get(m) ?? D(0);
    const absorbed = noCampaign.plus(fees);
    cumulative = cumulative.plus(absorbed);
    return {
      month: m,
      absorbedCents: fx(absorbed),
      noCampaignSpendCents: fx(noCampaign),
      cardFeesCents: fx(fees),
      /** Fees stripe-service could not tie to an org: absorbed too, never dropped, kept out of per-customer figures. */
      unattributedCardFeesCents: fx(unattr),
      /** Fees in another currency (EUR before 2026-08-14): served apart, never converted, not in absorbedCents. */
      cardFeesOtherCurrencies: otherWire(other),
      unattributedCardFeesOtherCurrencies: otherWire(unattributedOther.get(m) ?? new Map()),
      campaignSpendCents: fx(campaign),
      customersWithAbsorbedCost: n,
      averagePerCustomerCents: n ? fx(absorbed.div(n)) : null,
      payingCustomersWithAbsorbedCost: nPaying,
      averagePerPayingCustomerCents: nPaying ? fx(payingAbs.div(nPaying)) : null,
      neverPaidCustomersWithAbsorbedCost: nNeverPaid,
      averagePerNeverPaidCustomerCents: nNeverPaid ? fx(neverPaidAbs.div(nNeverPaid)) : null,
      cumulativeAbsorbedCents: fx(cumulative),
      cumulativeCustomersWithAbsorbedCost: seen.size,
      averagePerCustomerSinceInceptionCents: seen.size ? fx(cumulative.div(seen.size)) : null,
    };
  });

  const distribution = DISTRIBUTION_BUCKETS_CENTS.map((b) => ({
    label: b.label,
    minCents: b.min,
    maxCents: b.max,
    customers: 0,
    paying: 0,
    neverPaid: 0,
    payingUnknown: 0,
  }));
  for (const c of counted) {
    const b = distribution[bucketOf(c._absorbed)];
    b.customers += 1;
    if (c.paying === true) b.paying += 1;
    else if (c.paying === false) b.neverPaid += 1;
    else b.payingUnknown += 1;
  }

  const unattributedTotal = [...unattributedFees.values()].reduce((s, v) => s.plus(v), D(0));
  const fleetOther = new Map<string, Decimal>();
  for (const c of counted) for (const o of c.cardFeesOtherCurrencies) addOther(fleetOther, o.currency, o.feeCents);
  const unattributedOtherTotal = new Map<string, Decimal>();
  for (const m of unattributedOther.values()) for (const [cur, v] of m) addOther(unattributedOtherTotal, cur, v);
  const fleetAbsorbed = counted.reduce((s, c) => s.plus(c._absorbed), D(0));

  return {
    basis: {
      ruleSince: PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO,
      absorbed: "spend with no campaign + card-acquiring fees (Stripe and Revolut)",
      beforeRuleSince:
        "what WOULD have been absorbed under the rule (the org was billed for it then), so the history since inception reads on one basis",
      amounts:
        "USD cents, net of any usage discount, as priced in the cost records; card fees are what the acquirer took",
      otherCurrencies:
        "card fees the acquirer took in another currency (the Stripe account settled in EUR until 2026-08-13) are served in cardFeesOtherCurrencies, never converted, and are NOT in any USD figure",
      excluded: "our own platform orgs (listed with platformOrg: true, kept out of every fleet figure)",
    },
    firstMonth: months[0] ?? null,
    lastMonth: months[months.length - 1] ?? null,
    months,
    fleet: {
      ...groupStats(counted),
      absorbedCents: fx(fleetAbsorbed),
      noCampaignSpendCents: fx(counted.reduce((s, c) => s.plus(c.noCampaignSpendCents), D(0))),
      cardFeesCents: fx(counted.reduce((s, c) => s.plus(c.cardFeesCents), D(0))),
      unattributedCardFeesCents: fx(unattributedTotal),
      cardFeesOtherCurrencies: otherWire(fleetOther),
      unattributedCardFeesOtherCurrencies: otherWire(unattributedOtherTotal),
      campaignSpendCents: fx(counted.reduce((s, c) => s.plus(c.campaignSpendCents), D(0))),
      paying: groupStats(counted.filter((c) => c.paying === true)),
      neverPaid: groupStats(counted.filter((c) => c.paying === false)),
      payingUnknown: counted.filter((c) => c.paying === null).length,
    },
    fleetByMonth,
    distribution,
    customers: customers.map(({ _absorbed, ...c }) => c),
  };
}

function median(values: Decimal[]): Decimal {
  const s = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : s[mid - 1].plus(s[mid]).div(2);
}

// ── Sources ─────────────────────────────────────────────────────────────────────


/** Card-acquiring fee cost names: their history comes from stripe-service, never twice. */
export const ACQUIRING_FEE_COST_NAMES = new Set([
  "stripe-processing-fee",
  "stripe-refund-fee",
  "stripe-dispute-fee",
  "stripe-payout-failure-fee",
  "revolut-acquiring-fee",
]);

const CONCURRENCY = 8;

async function mapPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/**
 * Spend rows from runs-service with the acquiring-fee cost names taken OUT of the
 * no-campaign figure (they come from stripe-service). A row with spend of UNKNOWN
 * campaign status is not absorbed nor billed for sure: it throws, never guessed.
 */
export function spendRowsFromRuns(
  orgs: Awaited<ReturnType<typeof fetchRunsNoCampaignMonthly>>["orgs"]
): SpendMonthRow[] {
  return orgs.map((o) => {
    if (D(o.netUnknownCostInUsdCents ?? "0").greaterThan(0)) {
      throw new Error(
        `[billing-service] runs-service reports spend of unknown campaign status for org ${o.orgId} in ${o.month}`
      );
    }
    const fees = (o.noCampaignByCostName ?? [])
      .filter((c) => ACQUIRING_FEE_COST_NAMES.has(c.costName))
      .reduce((s, c) => s.plus(c.netNoCampaignCostInUsdCents), D(0));
    return {
      orgId: o.orgId,
      month: o.month,
      noCampaignCents: fx(D(o.netNoCampaignCostInUsdCents).minus(fees)),
      campaignCents: fx(D(o.netCampaignCostInUsdCents)),
    };
  });
}

let cache: { at: number; value: ReturnType<typeof composeAbsorbedCosts> } | null = null;
const CACHE_MS = 5 * 60_000;

/** The staff read. Cached 5 minutes: it fans out one cash read per customer. */
export async function getAbsorbedCosts(now: Date = new Date(), fresh = false) {
  if (!fresh && cache && now.getTime() - cache.at < CACHE_MS) return cache.value;
  const [runs, fees, accounts, platform] = await Promise.all([
    fetchRunsNoCampaignMonthly(),
    fetchAcquiringFeesByOrgMonth(),
    db
      .select({
        orgId: billingAccounts.orgId,
        createdAt: billingAccounts.createdAt,
        paymentMode: billingAccounts.paymentMode,
        freeCreditOffer: billingAccounts.freeCreditOffer,
      })
      .from(billingAccounts),
    db.select({ orgId: platformOrgs.orgId }).from(platformOrgs),
  ]);
  const spend = spendRowsFromRuns(runs.orgs);
  const orgIds = [...new Set([...accounts.map((a) => a.orgId), ...spend.map((s) => s.orgId), ...fees.flatMap((f) => (f.orgId ? [f.orgId] : []))])];
  const cash = new Map<string, string | null>();
  const identities = new Map<string, CustomerIdentity | null>();
  await mapPool(orgIds, CONCURRENCY, async (orgId) => {
    const [c, id] = await Promise.all([
      getOrgCash(orgId).then(
        (r) => r.cashPaidCents,
        (err) => {
          console.error(`[billing-service] absorbed costs: cash unreadable for org ${orgId}:`, err);
          return null;
        }
      ),
      resolveOrgDisplayIdentity(orgId).catch(() => null),
    ]);
    cash.set(orgId, c);
    identities.set(orgId, id ? { name: id.name ?? null, domain: id.domain ?? null } : null);
  });
  const value = composeAbsorbedCosts({
    spend,
    fees,
    accounts,
    platformOrgIds: new Set(platform.map((p) => p.orgId)),
    cashPaidCents: cash,
    identities,
    now,
  });
  cache = { at: now.getTime(), value };
  return value;
}
