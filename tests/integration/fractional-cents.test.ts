import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { db } from "../../src/db/index.js";
import { transactions } from "../../src/db/schema.js";
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
    await insertTestAccount({ orgId, creditBalanceCents: 100.1234567 });
    await db.insert(transactions).values([
      {
        orgId,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: "100.1234567",
        source: "reload",
        description: "frac-reload",
      },
      {
        orgId,
        userId,
        type: "credit",
        status: "confirmed",
        amountCents: "50.0000001",
        source: "welcome",
        description: "frac-welcome",
      },
    ]);

    const res = await request(app).get("/public/stats/billing");
    expect(res.status).toBe(200);

    // Strings, not numbers
    expect(typeof res.body.totalGrantsCents).toBe("string");
    expect(typeof res.body.totalCreditedCents).toBe("string");

    // Round-trip preserves precision
    const parsed = JSON.parse(JSON.stringify(res.body));
    expect(parsed.totalGrantsCents).toBe("100.1234567000");
    expect(parsed.totalCreditedCents).toBe("150.1234568000");
  });
});
