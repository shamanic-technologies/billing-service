import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../src/db/index.js";
import { customerBalanceTransactions } from "../../src/db/schema.js";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";

describe("Fractional cents — public-stats string repr", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-00000000fc05";
  const userId = "00000000-0000-0000-0000-000000000099";

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("AC-D1: returns string-decimal sums that survive JSON round-trip without precision loss", async () => {
    await insertTestAccount({ orgId, balanceCents: "100.1234567" });
    await db.insert(customerBalanceTransactions).values([
      {
        orgId,
        userId,
        type: "payment",
        status: "succeeded",
        // Signed: negative = credit. Stored as -100.1234567.
        amountCents: "-100.1234567",
        description: "frac-payment",
      },
      {
        orgId,
        userId,
        type: "gift",
        status: "succeeded",
        amountCents: "-50.0000001",
        description: "frac-gift",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);

    expect(typeof res.body.total_balance_cents).toBe("string");
    expect(typeof res.body.total_credited_cents).toBe("string");

    const parsed = JSON.parse(JSON.stringify(res.body));
    expect(parsed.total_balance_cents).toBe("100.1234567000");
    expect(parsed.total_credited_cents).toBe("150.1234568000");
  });
});
