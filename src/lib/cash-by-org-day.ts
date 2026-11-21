import { addCents, cmpCents, ZERO_CENTS } from "./cents.js";
import type { FleetOffPlatformPayment } from "./off-platform-payments.js";

/**
 * Cash per org per UTC day, fleet-wide, since inception (SAAS-CASH-1121).
 *
 * Owner 2026-11-21: « Revenue bruts m'intéresse le plus. En dessous on pourra noter les
 * revenues net ». Two figures per (org, day), never one swapped for the other:
 *  - GROSS = money received that day (every acquirer + stripe-service direct payments
 *    + billing's off-platform payments on their paid day), BEFORE any return;
 *  - NET = gross minus the refunds / lost disputes that HAPPENED that day (a return is
 *    dated on its own day, never back-dated to the payment it reverses).
 * So NET <= GROSS on every row (returned >= 0), and a row can carry gross 0 with a
 * negative net (a return on a day nothing was paid).
 *
 * stripe-service owns the acquirer half; billing adds ONLY its off-platform payments,
 * exactly as `GET /public/stats/billing` does (foldOffPlatformPayments), so:
 *   Σ rows gross == total_gross_cents == /public/stats/billing total_paid_cents
 *   Σ rows net   == total_net_cents   == /public/stats/billing total_revenue_cents
 * Both identities are CHECKED here; a mismatch throws (the route answers 502).
 *
 * AGENCY money (owner's 3rd series « revenue avec agency ») is served APART, never
 * inside gross/net: `agency_gross_cents` / `agency_net_cents` = completed Revolut
 * payment requests (payment links staff send by hand) and their refunds, as
 * stripe-service serves them (v0.59.19). It never feeds /public/stats/billing nor any
 * org credit. Off-platform payments are SaaS cash (they credit the org), never agency.
 */

/** One (org, day) row as stripe-service serves it, in billing's words. */
export interface StripeCashDayRow {
  orgId: string | null;
  day: string;
  grossCents: string;
  netCents: string;
  agencyGrossCents: string;
  agencyNetCents: string;
}

export interface StripeCashByOrgDay {
  asOf: string;
  totalGrossCents: string;
  totalNetCents: string;
  totalAgencyGrossCents: string;
  totalAgencyNetCents: string;
  rows: StripeCashDayRow[];
}

export interface CashByOrgDayRow {
  org_id: string | null;
  day: string;
  gross_cents: string;
  net_cents: string;
  agency_gross_cents: string;
  agency_net_cents: string;
}

export interface CashByOrgDay {
  as_of: string;
  total_gross_cents: string;
  total_net_cents: string;
  total_agency_gross_cents: string;
  total_agency_net_cents: string;
  rows: CashByOrgDayRow[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC calendar day of an instant. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Pure: stripe-service's rows + billing's off-platform payments → the served body. */
export function foldCashByOrgDay(
  stripe: StripeCashByOrgDay,
  offPlatform: FleetOffPlatformPayment[]
): CashByOrgDay {
  const byKey = new Map<string, CashByOrgDayRow>();
  const keyOf = (orgId: string | null, day: string) => `${orgId ?? ""}|${day}`;
  const rowFor = (orgId: string | null, day: string): CashByOrgDayRow => {
    const key = keyOf(orgId, day);
    let row = byKey.get(key);
    if (!row) {
      row = {
        org_id: orgId,
        day,
        gross_cents: ZERO_CENTS,
        net_cents: ZERO_CENTS,
        agency_gross_cents: ZERO_CENTS,
        agency_net_cents: ZERO_CENTS,
      };
      byKey.set(key, row);
    }
    return row;
  };

  for (const r of stripe.rows) {
    if (!DAY_RE.test(r.day)) throw new Error(`stripe-service cash row has a malformed day: ${r.day}`);
    const row = rowFor(r.orgId, r.day);
    row.gross_cents = addCents(row.gross_cents, r.grossCents);
    row.net_cents = addCents(row.net_cents, r.netCents);
    row.agency_gross_cents = addCents(row.agency_gross_cents, r.agencyGrossCents);
    row.agency_net_cents = addCents(row.agency_net_cents, r.agencyNetCents);
  }

  let totalGross = addCents(ZERO_CENTS, stripe.totalGrossCents);
  let totalNet = addCents(ZERO_CENTS, stripe.totalNetCents);
  for (const p of offPlatform) {
    const row = rowFor(p.orgId, utcDay(p.paidAt));
    row.gross_cents = addCents(row.gross_cents, p.amountCents);
    row.net_cents = addCents(row.net_cents, p.amountCents);
    totalGross = addCents(totalGross, p.amountCents);
    totalNet = addCents(totalNet, p.amountCents);
  }

  const rows = [...byKey.values()].sort((a, b) =>
    a.day === b.day ? (a.org_id ?? "").localeCompare(b.org_id ?? "") : a.day.localeCompare(b.day)
  );

  let sumGross = ZERO_CENTS;
  let sumNet = ZERO_CENTS;
  let sumAgencyGross = ZERO_CENTS;
  let sumAgencyNet = ZERO_CENTS;
  for (const row of rows) {
    if (cmpCents(row.net_cents, row.gross_cents) > 0) {
      throw new Error(
        `cash row org ${row.org_id ?? "null"} day ${row.day}: net ${row.net_cents} above gross ${row.gross_cents}`
      );
    }
    if (cmpCents(row.agency_net_cents, row.agency_gross_cents) > 0) {
      throw new Error(
        `cash row org ${row.org_id ?? "null"} day ${row.day}: agency net ${row.agency_net_cents} above agency gross ${row.agency_gross_cents}`
      );
    }
    sumGross = addCents(sumGross, row.gross_cents);
    sumNet = addCents(sumNet, row.net_cents);
    sumAgencyGross = addCents(sumAgencyGross, row.agency_gross_cents);
    sumAgencyNet = addCents(sumAgencyNet, row.agency_net_cents);
  }
  const totalAgencyGross = addCents(ZERO_CENTS, stripe.totalAgencyGrossCents);
  const totalAgencyNet = addCents(ZERO_CENTS, stripe.totalAgencyNetCents);
  if (cmpCents(sumAgencyGross, totalAgencyGross) !== 0) {
    throw new Error(`cash rows agency gross ${sumAgencyGross} != total agency gross ${totalAgencyGross}`);
  }
  if (cmpCents(sumAgencyNet, totalAgencyNet) !== 0) {
    throw new Error(`cash rows agency net ${sumAgencyNet} != total agency net ${totalAgencyNet}`);
  }
  if (cmpCents(sumGross, totalGross) !== 0) {
    throw new Error(`cash rows gross ${sumGross} != total gross ${totalGross}`);
  }
  if (cmpCents(sumNet, totalNet) !== 0) {
    throw new Error(`cash rows net ${sumNet} != total net ${totalNet}`);
  }

  return {
    as_of: stripe.asOf,
    total_gross_cents: totalGross,
    total_net_cents: totalNet,
    total_agency_gross_cents: totalAgencyGross,
    total_agency_net_cents: totalAgencyNet,
    rows,
  };
}
