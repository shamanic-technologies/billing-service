/**
 * The runway reads campaign-service's spendable budget from the last answer and
 * refreshes it behind the read (MON-PAGE-SPEED-1111). Prod 2026-11-12: that one
 * sibling read cost 0.24-2 s on every dashboard page.
 *
 * Pinned: a stored answer is served without asking campaign-service; any write to
 * billing's own budget rows makes it unservable (the read goes live); a failed
 * read is never stored; an old answer is served and refreshed behind; the runway
 * figures are the same as a live read's.
 *
 * Own file (CLAUDE.md: one describe per file that closes the DB).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { billingAccounts, brandSalesBudgets, campaignSpendableSnapshots } from "../../src/db/schema.js";
import * as campaignClient from "../../src/lib/campaign-service-client.js";
import type { SpendableBudget } from "../../src/lib/campaign-service-client.js";
import {
  REFRESH_AFTER_MS,
  snapshotSpendableBudgetReader,
} from "../../src/lib/spendable-budget-snapshots.js";
import { resolveBudgets } from "../../src/lib/payment-outlook.js";
import { getRunway } from "../../src/lib/runway.js";

const orgId = "00000000-0000-4000-8000-0000000098a1";
const brandId = "00000000-0000-4000-8000-0000000098b1";

function answer(running: number): SpendableBudget {
  return {
    orgId,
    brandId,
    grain: "campaign",
    configuredDailyBudgetCents: 3000,
    runningDailyBudgetCents: running,
    campaigns: [],
    rows: [],
  };
}

async function storedRow() {
  const [row] = await db
    .select()
    .from(campaignSpendableSnapshots)
    .where(and(eq(campaignSpendableSnapshots.orgId, orgId), eq(campaignSpendableSnapshots.brandId, brandId)));
  return row ?? null;
}

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("spendable-budget snapshots (runway)", () => {
  let live: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    live = vi.spyOn(campaignClient, "fetchSpendableBudget").mockResolvedValue(answer(1200.5));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanTestData();
    await closeDb();
  });

  it("a brand never read waits for campaign-service and stores the answer", async () => {
    const read = snapshotSpendableBudgetReader();
    expect(await read(orgId, brandId)).toEqual(answer(1200.5));
    expect(live).toHaveBeenCalledTimes(1);
    expect((await storedRow())?.body).toEqual(answer(1200.5));
  });

  it("a fresh stored answer is served without asking campaign-service", async () => {
    await snapshotSpendableBudgetReader()(orgId, brandId);
    live.mockResolvedValue(answer(9999));
    expect(await snapshotSpendableBudgetReader()(orgId, brandId)).toEqual(answer(1200.5));
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("an old stored answer is served at once and refreshed behind the read", async () => {
    await snapshotSpendableBudgetReader()(orgId, brandId);
    live.mockResolvedValue(answer(700));
    const later = () => Date.now() + REFRESH_AFTER_MS + 1;
    expect(await snapshotSpendableBudgetReader(later)(orgId, brandId)).toEqual(answer(1200.5));
    await flush();
    expect(live).toHaveBeenCalledTimes(2);
    expect((await storedRow())?.body).toEqual(answer(700));
    expect(await snapshotSpendableBudgetReader()(orgId, brandId)).toEqual(answer(700));
  });

  it("a write to billing's own budget rows makes the stored answer unservable", async () => {
    await snapshotSpendableBudgetReader()(orgId, brandId);
    await db.insert(brandSalesBudgets).values({ orgId, brandId, dailyBudgetCents: "2500" });
    live.mockResolvedValue(answer(2500));
    expect(await snapshotSpendableBudgetReader()(orgId, brandId)).toEqual(answer(2500));
    expect(live).toHaveBeenCalledTimes(2);

    // Any column, not only the amount.
    await db
      .update(brandSalesBudgets)
      .set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(brandSalesBudgets.orgId, orgId));
    live.mockResolvedValue(answer(10));
    expect(await snapshotSpendableBudgetReader()(orgId, brandId)).toEqual(answer(10));
    expect(live).toHaveBeenCalledTimes(3);
  });

  it("a failed campaign-service read is answered null and never stored", async () => {
    live.mockResolvedValue(null);
    expect(await snapshotSpendableBudgetReader()(orgId, brandId)).toBeNull();
    expect(await storedRow()).toBeNull();
  });

  it("a failed refresh behind the read keeps the stored answer", async () => {
    await snapshotSpendableBudgetReader()(orgId, brandId);
    live.mockResolvedValue(null);
    const later = () => Date.now() + REFRESH_AFTER_MS + 1;
    expect(await snapshotSpendableBudgetReader(later)(orgId, brandId)).toEqual(answer(1200.5));
    await flush();
    expect((await storedRow())?.body).toEqual(answer(1200.5));
  });

  it("concurrent reads of a brand never read ask campaign-service once", async () => {
    const read = snapshotSpendableBudgetReader();
    const [a, b] = await Promise.all([read(orgId, brandId), snapshotSpendableBudgetReader()(orgId, brandId)]);
    expect(a).toEqual(b);
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("resolveBudgets gives the same totals through the snapshot as live", async () => {
    await db.insert(brandSalesBudgets).values({ orgId, brandId, dailyBudgetCents: "2500" });
    live.mockResolvedValue({ ...answer(1200.5), campaigns: [{ running: true } as never] });
    const fresh = await resolveBudgets(orgId);
    const viaSnapshot = await resolveBudgets(orgId, snapshotSpendableBudgetReader());
    const served = await resolveBudgets(orgId, snapshotSpendableBudgetReader());
    expect(viaSnapshot).toEqual(fresh);
    expect(served).toEqual(fresh);
    expect(live).toHaveBeenCalledTimes(2);
  });

  it("the runway serves the stored answer on the second read, same figures", async () => {
    await insertTestAccount({ orgId });
    await db.update(billingAccounts).set({ paymentMode: "prepaid" }).where(eq(billingAccounts.orgId, orgId));
    await db.insert(brandSalesBudgets).values({ orgId, brandId, dailyBudgetCents: "2500" });
    live.mockResolvedValue({ ...answer(1200.5), campaigns: [{ running: true } as never] });
    const ss = setupStripeMocks();
    ss.fetchOrgCustomer.mockResolvedValue(customerWithEmail("founder@acme.test"));
    ss.sumSucceededTopupsForOrg.mockResolvedValue("10000.0000000000");
    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-11-12T00:00:00.000Z",
    } as never);

    const now = new Date("2026-11-12T12:00:00.000Z");
    const first = await getRunway(orgId, now);
    const second = await getRunway(orgId, now);
    expect(first?.state).toBe("days");
    expect(first?.dailyBudgetCents).toBe(second?.dailyBudgetCents);
    expect(second).toEqual(first);
    expect(live).toHaveBeenCalledTimes(1);
  });
});
