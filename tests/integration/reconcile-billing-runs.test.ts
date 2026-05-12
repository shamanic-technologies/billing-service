import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { transactions, billingAccounts } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

const orgId = "00000000-0000-0000-0000-000000000bb1";
const userId = "00000000-0000-0000-0000-000000000099";

const authorizeBody = {
  items: [{ costName: "anthropic-sonnet-4-5-tokens-input", quantity: 1000 }],
  description: "reconcile-billing-runs test",
};

describe("Credits authorize — reconcileBillingRuns (billing <> runs-service drift)", () => {
  const app = createTestApp();
  let stripeMocks: ReturnType<typeof setupStripeMocks>;
  let fetchRunsExpectedTotalsSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();

    // costs-service mock — required so /authorize resolves prices without HTTP
    const costsClient = await import("../../src/lib/costs-client.js");
    vi.spyOn(costsClient, "resolveRequiredCents").mockResolvedValue("10.0000000000");

    // runs-service mock — default to "no drift" so other tests don't accidentally
    // mutate the ledger. Each test below overrides with its own expectations.
    const runsClient = await import("../../src/lib/runs-client.js");
    fetchRunsExpectedTotalsSpy = vi.fn().mockResolvedValue({
      total_expected_cents: "0.0000000000",
      runs: [],
    });
    vi.spyOn(runsClient, "fetchRunsExpectedTotals").mockImplementation(
      fetchRunsExpectedTotalsSpy
    );
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("no drift: total expected matches total billed → no reconcile rows, balance unchanged", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_norun",
      creditBalanceCents: 500,
    });

    // Welcome credit + pre-existing $5 charge → ledger sum = $495 = cache
    // (so reconcileBillingStripe Check 1 finds no drift).
    const runR1 = "00000000-0000-0000-0000-000000000ba1";
    await db.insert(transactions).values([
      {
        orgId,
        userId,
        type: "credit",
        amountCents: "500.0000000000",
        status: "confirmed",
        source: "welcome",
        description: "Trial credit",
      },
      {
        orgId,
        userId,
        runId: runR1,
        type: "debit",
        amountCents: "5.0000000000",
        status: "confirmed",
        source: "charge",
        description: "existing charge",
      },
    ]);
    // Cache must equal ledger sum or Check 1 would fix it before reconcileBillingRuns runs.
    await db
      .update(billingAccounts)
      .set({ creditBalanceCents: "495.0000000000" })
      .where(eq(billingAccounts.orgId, orgId));

    fetchRunsExpectedTotalsSpy.mockResolvedValue({
      total_expected_cents: "5.0000000000",
      runs: [{ run_id: runR1, expected_cents: "5.0000000000" }],
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);

    // Exactly the two pre-existing rows — no reconcile inserts.
    const allTxns = await db
      .select()
      .from(transactions)
      .where(eq(transactions.orgId, orgId));
    expect(allTxns).toHaveLength(2);
    expect(allTxns.some((t) => t.description?.startsWith("Reconcile run"))).toBe(false);

    const [acct] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));
    expect(acct.creditBalanceCents).toBe("495.0000000000");
  });

  it("under-billed: inserts catch-up debit per run and decrements balance", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_under",
      creditBalanceCents: 100,
    });

    const runR1 = "00000000-0000-0000-0000-000000000ba2";
    // billed = $0 (no existing confirmed charge), expected = $3 → gap = $3
    fetchRunsExpectedTotalsSpy.mockResolvedValue({
      total_expected_cents: "3.0000000000",
      runs: [{ run_id: runR1, expected_cents: "3.0000000000" }],
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);

    const recon = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.orgId, orgId),
          eq(transactions.runId, runR1)
        )
      );
    expect(recon).toHaveLength(1);
    expect(recon[0].type).toBe("debit");
    expect(recon[0].source).toBe("charge");
    expect(recon[0].status).toBe("confirmed");
    expect(recon[0].amountCents).toBe("3.0000000000");
    expect(recon[0].description).toContain("under-billed by 3.0000000000");

    const [acct] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));
    expect(acct.creditBalanceCents).toBe("97.0000000000");
  });

  it("over-billed: inserts refund credit per run and increments balance", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_over",
      creditBalanceCents: 100,
    });

    const runR1 = "00000000-0000-0000-0000-000000000ba3";
    // Welcome credit $100 + pre-existing $5 over-charge → ledger sum = $95 = cache.
    await db.insert(transactions).values([
      {
        orgId,
        userId,
        type: "credit",
        amountCents: "100.0000000000",
        status: "confirmed",
        source: "welcome",
        description: "Trial credit",
      },
      {
        orgId,
        userId,
        runId: runR1,
        type: "debit",
        amountCents: "5.0000000000",
        status: "confirmed",
        source: "charge",
        description: "existing over-charge",
      },
    ]);
    await db
      .update(billingAccounts)
      .set({ creditBalanceCents: "95.0000000000" })
      .where(eq(billingAccounts.orgId, orgId));

    fetchRunsExpectedTotalsSpy.mockResolvedValue({
      total_expected_cents: "3.0000000000",
      runs: [{ run_id: runR1, expected_cents: "3.0000000000" }],
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);

    const refunds = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.orgId, orgId),
          eq(transactions.source, "refund")
        )
      );
    expect(refunds).toHaveLength(1);
    expect(refunds[0].type).toBe("credit");
    expect(refunds[0].amountCents).toBe("2.0000000000");
    expect(refunds[0].runId).toBe(runR1);
    expect(refunds[0].description).toContain("over-billed by 2.0000000000");

    const [acct] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));
    expect(acct.creditBalanceCents).toBe("97.0000000000");
  });

  it("idempotent: re-running with the same expected totals after a reconcile is a noop", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_idem",
      creditBalanceCents: 100,
    });

    const runR1 = "00000000-0000-0000-0000-000000000ba4";
    fetchRunsExpectedTotalsSpy.mockResolvedValue({
      total_expected_cents: "2.5000000000",
      runs: [{ run_id: runR1, expected_cents: "2.5000000000" }],
    });

    await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    const txnsAfterFirst = await db
      .select()
      .from(transactions)
      .where(eq(transactions.runId, runR1));
    expect(txnsAfterFirst).toHaveLength(1);
    expect(txnsAfterFirst[0].amountCents).toBe("2.5000000000");

    // Second call: same expected (2.5), billed now also 2.5 from prior reconcile → gap=0
    await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    const txnsAfterSecond = await db
      .select()
      .from(transactions)
      .where(eq(transactions.runId, runR1));
    expect(txnsAfterSecond).toHaveLength(1); // no new row
  });

  it("preserves fractional precision: expected=1.2345678901 vs billed=0.5 → debit=0.7345678901", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_frac",
      creditBalanceCents: 100,
    });

    const runR1 = "00000000-0000-0000-0000-000000000ba5";
    // Welcome credit $100 + partial $0.5 charge → ledger sum $99.5 = cache.
    await db.insert(transactions).values([
      {
        orgId,
        userId,
        type: "credit",
        amountCents: "100.0000000000",
        status: "confirmed",
        source: "welcome",
        description: "Trial credit",
      },
      {
        orgId,
        userId,
        runId: runR1,
        type: "debit",
        amountCents: "0.5000000000",
        status: "confirmed",
        source: "charge",
        description: "fractional partial charge",
      },
    ]);
    await db
      .update(billingAccounts)
      .set({ creditBalanceCents: "99.5000000000" })
      .where(eq(billingAccounts.orgId, orgId));

    fetchRunsExpectedTotalsSpy.mockResolvedValue({
      total_expected_cents: "1.2345678901",
      runs: [{ run_id: runR1, expected_cents: "1.2345678901" }],
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);
    expect(res.status).toBe(200);

    const recon = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.orgId, orgId),
          eq(transactions.runId, runR1),
          eq(transactions.description, "Reconcile run " + runR1 + ": under-billed by 0.7345678901")
        )
      );
    expect(recon).toHaveLength(1);
    expect(recon[0].amountCents).toBe("0.7345678901");
  });

  it("global gate: total expected == total billed → per-run sweep skipped even when individual run row would not match", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_gate",
      creditBalanceCents: 100,
    });

    const runR1 = "00000000-0000-0000-0000-000000000ba6";
    await db.insert(transactions).values({
      orgId,
      userId,
      runId: runR1,
      type: "debit",
      amountCents: "10.0000000000",
      status: "confirmed",
      source: "charge",
      description: "billed against R1",
    });

    // expected on runs-service side is also 10 total but allocated to a DIFFERENT run.
    // The global gate matches → no per-run sweep, even though run R1's billed=10 and run R2's expected=10.
    const runR2 = "00000000-0000-0000-0000-000000000ba7";
    fetchRunsExpectedTotalsSpy.mockResolvedValue({
      total_expected_cents: "10.0000000000",
      runs: [{ run_id: runR2, expected_cents: "10.0000000000" }],
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);
    expect(res.status).toBe(200);

    const allTxns = await db
      .select()
      .from(transactions)
      .where(eq(transactions.orgId, orgId));
    expect(allTxns).toHaveLength(1); // only the pre-existing row
  });

  it("multi-run drift: applies per-run gaps independently, balance reflects net change", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_multi",
      creditBalanceCents: 100,
    });

    const runA = "00000000-0000-0000-0000-000000000ba8";
    const runB = "00000000-0000-0000-0000-000000000ba9";
    // billed: A=0, B=0; expected: A=3, B=2 → +5 debit total, balance 100 → 95.
    fetchRunsExpectedTotalsSpy.mockResolvedValue({
      total_expected_cents: "5.0000000000",
      runs: [
        { run_id: runA, expected_cents: "3.0000000000" },
        { run_id: runB, expected_cents: "2.0000000000" },
      ],
    });

    await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    const [aRow] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.runId, runA));
    expect(aRow.amountCents).toBe("3.0000000000");
    expect(aRow.source).toBe("charge");

    const [bRow] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.runId, runB));
    expect(bRow.amountCents).toBe("2.0000000000");
    expect(bRow.source).toBe("charge");

    const [acct] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));
    expect(acct.creditBalanceCents).toBe("95.0000000000");
  });

  it("fires Stripe ceil-delta per reconcile insert", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_stripe_sync",
      creditBalanceCents: 100,
    });

    const runR1 = "00000000-0000-0000-0000-000000000baa";
    fetchRunsExpectedTotalsSpy.mockResolvedValue({
      total_expected_cents: "3.0000000000",
      runs: [{ run_id: runR1, expected_cents: "3.0000000000" }],
    });

    await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    await new Promise((r) => setTimeout(r, 50));

    // ceil(100) → ceil(97) = -3 delta from Stripe's perspective (positive = customer owes)
    expect(stripeMocks.createBalanceTransaction).toHaveBeenCalledWith(
      orgId,
      expect.any(String),
      "cus_stripe_sync",
      3,
      expect.stringContaining("Reconcile run"),
      undefined,
      {}
    );
  });

  it("runs-service down (HTTP error): authorize still succeeds, no reconcile rows written", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_runs_down",
      creditBalanceCents: 100,
    });

    fetchRunsExpectedTotalsSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders(orgId))
      .send(authorizeBody);

    expect(res.status).toBe(200);

    const allTxns = await db
      .select()
      .from(transactions)
      .where(eq(transactions.orgId, orgId));
    expect(allTxns).toHaveLength(0);
  });

  it("account not found: noop, does not 500", async () => {
    // No billing account inserted. Note: /authorize auto-creates via findOrCreateAccount,
    // so a missing account at the start gets auto-provisioned with the trial credit.
    // We simulate a drift detected against the auto-created account.
    const runR1 = "00000000-0000-0000-0000-000000000bab";
    fetchRunsExpectedTotalsSpy.mockResolvedValue({
      total_expected_cents: "0.5000000000",
      runs: [{ run_id: runR1, expected_cents: "0.5000000000" }],
    });

    const res = await request(app)
      .post("/v1/credits/authorize")
      .set(getAuthHeaders("00000000-0000-0000-0000-000000000bac"))
      .send(authorizeBody);

    expect(res.status).toBe(200);

    // Reconcile fired against the newly auto-created account
    const recon = await db
      .select()
      .from(transactions)
      .where(eq(transactions.runId, runR1))
      .orderBy(desc(transactions.createdAt));
    expect(recon).toHaveLength(1);
    expect(recon[0].source).toBe("charge");
    expect(recon[0].amountCents).toBe("0.5000000000");
  });
});
