import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  localPromoCodes,
  localPromos,
  PRODUCT_TASK_REWARD_CODE,
  INVITE_REWARD_CODE,
} from "../../src/db/schema.js";

/**
 * A product-task reward RECURS for the same org, roughly monthly, forever — so it
 * cannot key its idempotency on (org, reason) the way the two invite reasons do.
 * It stacks on the caller's own per-completion identifier, exactly like a staff
 * admin_grant stacks on its idempotency key, but on the service-to-service path
 * (no staff identity is faked).
 */
describe("POST /internal/credits/grant — product_task_completed", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-0000000000a1";

  beforeEach(async () => {
    vi.restoreAllMocks();
    setupStripeMocks();
    await cleanTestData();

    const runsClient = await import("../../src/lib/runs-client.js");
    vi.spyOn(runsClient, "fetchRunsOrgUsageTotal").mockResolvedValue({
      org_id: orgId,
      spent_cents: "0.0000000000",
      as_of: "2026-09-17T00:00:00.000Z",
    } as never);
    vi.spyOn(runsClient, "fetchRunsOrgActualUsageTotal").mockResolvedValue({
      spent_cents: "0.0000000000",
    } as never);
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  function authHeaders() {
    return { "X-API-Key": "test-api-key", "Content-Type": "application/json" };
  }

  async function promosForOrg(target: string) {
    return db.select().from(localPromos).where(eq(localPromos.orgId, target));
  }

  async function promoCodeId(code: string): Promise<string> {
    const [row] = await db
      .select()
      .from(localPromoCodes)
      .where(eq(localPromoCodes.code, code))
      .limit(1);
    if (!row) throw new Error(`promo code missing in test seed: ${code}`);
    return row.id;
  }

  function grant(body: Record<string, unknown>) {
    return request(app)
      .post("/internal/credits/grant")
      .set(authHeaders())
      .send(body);
  }

  it("T1: two completions of the same task, two identifiers — BOTH land", async () => {
    const first = await grant({
      orgId,
      amountCents: 200,
      reason: PRODUCT_TASK_REWARD_CODE,
      completionId: "task-2026-08",
    });
    expect(first.status).toBe(200);
    expect(first.body.newBalanceCents).toBe("200.0000000000");

    const second = await grant({
      orgId,
      amountCents: 200,
      reason: PRODUCT_TASK_REWARD_CODE,
      completionId: "task-2026-09",
    });
    expect(second.status).toBe(200);
    expect(second.body.newBalanceCents).toBe("400.0000000000");

    const rows = await promosForOrg(orgId);
    expect(rows).toHaveLength(2);
    const codeId = await promoCodeId(PRODUCT_TASK_REWARD_CODE);
    expect(rows.every((r) => r.promoCodeId === codeId)).toBe(true);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual([
      "task:task-2026-08",
      "task:task-2026-09",
    ]);
  });

  it("T2: the same completion identifier retried pays exactly once", async () => {
    const body = {
      orgId,
      amountCents: 200,
      reason: PRODUCT_TASK_REWARD_CODE,
      completionId: "task-2026-08",
    };
    const first = await grant(body);
    const retry = await grant(body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.newBalanceCents).toBe("200.0000000000");
    expect(await promosForOrg(orgId)).toHaveLength(1);
  });

  it("T3: the org's grants ledger shows it distinguishably from invite + staff grants", async () => {
    await grant({
      orgId,
      amountCents: 200,
      reason: PRODUCT_TASK_REWARD_CODE,
      completionId: "task-2026-09",
    });
    await grant({ orgId, amountCents: 2500, reason: INVITE_REWARD_CODE });
    await request(app)
      .post("/v1/credits/grant")
      .set({ ...authHeaders(), "x-org-id": orgId, "x-email": "staff@distribute.you" })
      .send({ amountCents: 1000, note: "goodwill", idempotencyKey: "staff-1" });

    const res = await request(app)
      .get("/v1/credits/grants")
      .set({ "X-API-Key": "test-api-key", "x-org-id": orgId });

    expect(res.status).toBe(200);
    const reasons = res.body.grants.map((g: { reason: string }) => g.reason);
    expect(reasons).toContain(PRODUCT_TASK_REWARD_CODE);
    expect(reasons).toContain(INVITE_REWARD_CODE);
    expect(reasons).toContain("admin_grant");

    const reward = res.body.grants.find(
      (g: { reason: string }) => g.reason === PRODUCT_TASK_REWARD_CODE
    );
    // Customer-showable label, and no staff email invented on a machine grant.
    expect(reward.note).toBe("Product task reward: $2.00");
    expect(reward.grantedBy).toBeNull();
    expect(reward.amountCents).toBe("200.0000000000");
  });

  it("T4: no completionId on a recurring reward is a loud 400", async () => {
    const res = await grant({
      orgId,
      amountCents: 200,
      reason: PRODUCT_TASK_REWARD_CODE,
    });
    expect(res.status).toBe(400);
    expect(await promosForOrg(orgId)).toHaveLength(0);
  });

  it("T5: an empty completionId is a loud 400", async () => {
    const res = await grant({
      orgId,
      amountCents: 200,
      reason: PRODUCT_TASK_REWARD_CODE,
      completionId: "",
    });
    expect(res.status).toBe(400);
    expect(await promosForOrg(orgId)).toHaveLength(0);
  });

  it("T6: an unknown reason stays a loud 400", async () => {
    const res = await grant({
      orgId,
      amountCents: 200,
      reason: "task_bonus",
      completionId: "x",
    });
    expect(res.status).toBe(400);
    expect(await promosForOrg(orgId)).toHaveLength(0);
  });

  it("T7: a completionId on an invite reason is refused, never silently ignored", async () => {
    const res = await grant({
      orgId,
      amountCents: 2500,
      reason: INVITE_REWARD_CODE,
      completionId: "task-2026-09",
    });
    expect(res.status).toBe(400);
    expect(await promosForOrg(orgId)).toHaveLength(0);
  });

  it("T8: REGRESSION — invite grants are still one-shot per (org, reason)", async () => {
    const body = { orgId, amountCents: 2500, reason: INVITE_REWARD_CODE };
    expect((await grant(body)).status).toBe(200);
    const retry = await grant(body);
    expect(retry.status).toBe(200);
    expect(retry.body.newBalanceCents).toBe("2500.0000000000");

    const rows = await promosForOrg(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBeNull();
  });

  it("T9: a missing product_task_completed seed fails loud (500), never a silent skip", async () => {
    await db
      .delete(localPromoCodes)
      .where(eq(localPromoCodes.code, PRODUCT_TASK_REWARD_CODE));

    const res = await grant({
      orgId,
      amountCents: 200,
      reason: PRODUCT_TASK_REWARD_CODE,
      completionId: "task-2026-09",
    });
    expect(res.status).toBe(500);

    await db
      .insert(localPromoCodes)
      .values({ code: PRODUCT_TASK_REWARD_CODE, amountCents: 0 })
      .onConflictDoNothing();
  });
});
