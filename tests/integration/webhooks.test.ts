import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestAccount, closeDb } from "../helpers/test-db.js";
import { setupStripeMocks } from "../helpers/mock-stripe.js";
import { db } from "../../src/db/index.js";
import { billingAccounts } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

describe("Stripe webhooks", () => {
  const app = createTestApp();
  const orgId = "00000000-0000-0000-0000-000000000001";
  const webhookAppId = "testapp";
  let stripeMocks: ReturnType<typeof setupStripeMocks>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    stripeMocks = setupStripeMocks();
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("rejects requests without stripe-signature", async () => {
    const res = await request(app)
      .post(`/v1/webhooks/stripe/${webhookAppId}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "test" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing stripe-signature header");
  });

  it("rejects requests with invalid signature", async () => {
    stripeMocks.constructWebhookEvent.mockImplementation(() => {
      throw new Error("Invalid signature");
    });

    const res = await request(app)
      .post(`/v1/webhooks/stripe/${webhookAppId}`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "invalid_sig")
      .send(JSON.stringify({ type: "test" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid signature");
  });

  it("handles checkout.session.completed — updates account to PAYG", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      billingMode: "trial",
      creditBalanceCents: 200,
    });

    stripeMocks.constructWebhookEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_123",
          payment_intent: "pi_123",
          payment_method_types: ["card"],
          payment_method: "pm_new_123",
          metadata: { reload_amount_cents: "2000" },
        },
      },
    });

    const res = await request(app)
      .post(`/v1/webhooks/stripe/${webhookAppId}`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "valid_sig")
      .send(JSON.stringify({ type: "checkout.session.completed" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // Verify account was updated
    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    expect(account.billingMode).toBe("payg");
    expect(account.creditBalanceCents).toBe(2200); // 200 + 2000
    expect(account.stripePaymentMethodId).toBe("pm_new_123");
  });

  it("handles payment_intent.succeeded for auto-reload", async () => {
    await insertTestAccount({
      orgId,
      stripeCustomerId: "cus_123",
      billingMode: "payg",
      stripePaymentMethodId: "pm_old",
    });

    stripeMocks.constructWebhookEvent.mockReturnValue({
      type: "payment_intent.succeeded",
      data: {
        object: {
          customer: "cus_123",
          payment_method: "pm_new",
          metadata: { type: "auto_reload" },
        },
      },
    });

    const res = await request(app)
      .post(`/v1/webhooks/stripe/${webhookAppId}`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "valid_sig")
      .send(JSON.stringify({ type: "payment_intent.succeeded" }));

    expect(res.status).toBe(200);

    // Verify payment method was updated
    const [account] = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);

    expect(account.stripePaymentMethodId).toBe("pm_new");
  });

  it("acknowledges unknown event types", async () => {
    stripeMocks.constructWebhookEvent.mockReturnValue({
      type: "some.unknown.event",
      data: { object: {} },
    });

    const res = await request(app)
      .post(`/v1/webhooks/stripe/${webhookAppId}`)
      .set("Content-Type", "application/json")
      .set("stripe-signature", "valid_sig")
      .send(JSON.stringify({ type: "some.unknown.event" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});
