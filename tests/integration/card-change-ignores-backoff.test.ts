/**
 * Changing or removing the card ALWAYS presents the whole amount owed (owner
 * 2026-10-21), even when a recent decline elsewhere put the org in the reload
 * backoff. Own file (one describe per file — see CLAUDE.md).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanTestData, closeDb, insertTestAccount } from "../helpers/test-db.js";
import { setupStripeMocks, customerWithEmail } from "../helpers/mock-stripe.js";
import { _resetCoalescer, coalesceReload } from "../../src/lib/reload-coalescer.js";
import { settleOutstandingBeforeCardChange } from "../../src/lib/card-change-settlement.js";

const orgId = "00000000-0000-0000-0000-00000000cc21";

describe("card change settle ignores the reload backoff", () => {
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetCoalescer();
    await cleanTestData();
    ssMocks = setupStripeMocks();
    ssMocks.fetchOrgCustomer.mockResolvedValue(customerWithEmail("client@x.test"));
    ssMocks.sumSucceededTopupsForOrg.mockResolvedValue("0.0000000000");
    ssMocks.hasChargeablePmForOrg.mockResolvedValue(true);
    ssMocks.getOrgCardCountryByOrg.mockResolvedValue("FR");
    const runsClient = await import("../../src/lib/runs-client.js");
    const usage = { org_id: orgId, spent_cents: "1217.0000000000", as_of: "2026-10-21T00:00:00.000Z" };
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue(usage);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue(usage);
  });

  afterAll(async () => {
    _resetCoalescer();
    await closeDb();
  });

  it("a decline seconds earlier does not stop the card-change charge of the whole amount", async () => {
    await insertTestAccount({ orgId, paymentMode: "postpaid" });
    // A decline on another path arms the backoff.
    await coalesceReload(orgId, async () => ({ status: "failed" as const, failure_reason: "card_declined" }));
    const out = await settleOutstandingBeforeCardChange(orgId);
    expect(ssMocks.reloadOffSession).toHaveBeenCalledTimes(1);
    expect(ssMocks.reloadOffSession.mock.calls[0][1]).toBe(1217);
    expect(out.chargedCents).toBe(1217);
  });
});
