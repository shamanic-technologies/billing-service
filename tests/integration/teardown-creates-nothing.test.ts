import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import {
  billingAccounts,
  localPromos,
  welcomeRecipients,
} from "../../src/db/schema.js";

/**
 * Tearing down an org billing never held an account for must CREATE nothing: no
 * billing account, no Stripe customer, no welcome evaluation. It is a no-op that
 * says so (`billingAccountExisted: false`).
 */
describe("DELETE /internal/accounts/by-org/:orgId — an org with no billing account", () => {
  const app = createTestApp();
  const orgId = "eeeeeeee-0000-4000-8000-000000000001";
  const internal = { "X-API-Key": "test-api-key" };
  let ssMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ssMocks = setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("is a reported no-op: no account, no Stripe customer, no welcome, no outbound call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await request(app).delete(`/internal/accounts/by-org/${orgId}`).set(internal);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.billingAccountExisted).toBe(false);
    expect(res.body.deletedRows.billingAccounts).toBe(0);

    expect(
      await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId))
    ).toHaveLength(0);
    expect(
      await db.select().from(welcomeRecipients).where(eq(welcomeRecipients.orgId, orgId))
    ).toHaveLength(0);
    expect(
      await db.select().from(localPromos).where(eq(localPromos.orgId, orgId))
    ).toHaveLength(0);
    expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();
    expect(ssMocks.getCustomerByOrg).not.toHaveBeenCalled();
    expect(ssMocks.getCustomerByOrgOrNull).not.toHaveBeenCalled();
    expect(ssMocks.fetchOrgCustomer).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("removes a creation bonus held without an account, still creating no account", async () => {
    const bonus = await request(app)
      .post(`/internal/accounts/by-org/${orgId}/org-creation-bonus`)
      .set(internal);
    expect(bonus.status).toBe(200);

    const res = await request(app).delete(`/internal/accounts/by-org/${orgId}`).set(internal);

    expect(res.status).toBe(200);
    expect(res.body.billingAccountExisted).toBe(false);
    expect(res.body.deletedRows.localPromos).toBe(1);
    expect(
      await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId))
    ).toHaveLength(0);
    expect(ssMocks.ensureCustomer).not.toHaveBeenCalled();
  });
});
