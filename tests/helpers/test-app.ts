import express from "express";
import cors from "cors";
import healthRoutes from "../../src/routes/health.js";
import publicStatsRoutes from "../../src/routes/public-stats.js";
import accountsRoutes from "../../src/routes/accounts.js";
import customerBalanceRoutes from "../../src/routes/customer_balance.js";
import checkoutRoutes from "../../src/routes/checkout.js";
import portalRoutes from "../../src/routes/portal.js";
import promotionCodesRoutes from "../../src/routes/promotion_codes.js";
import webhookRoutes from "../../src/routes/webhooks.js";
import internalRoutes from "../../src/routes/internal.js";
import { requireApiKey } from "../../src/middleware/auth.js";

export function createTestApp() {
  const app = express();
  app.use(cors());

  // Webhook route needs raw body — register BEFORE express.json()
  app.use("/v1/webhooks/stripe", express.raw({ type: "application/json" }));
  app.use(webhookRoutes);

  // JSON parser for all other routes
  app.use(express.json());

  // Public routes
  app.use(healthRoutes);
  app.use(publicStatsRoutes);

  // Protected routes
  app.use(requireApiKey);
  app.use(internalRoutes);
  app.use(accountsRoutes);
  app.use(customerBalanceRoutes);
  app.use(checkoutRoutes);
  app.use(portalRoutes);
  app.use(promotionCodesRoutes);

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

export function getAuthHeaders(
  orgId = "00000000-0000-0000-0000-000000000001",
  userId = "00000000-0000-0000-0000-000000000099",
  runId = "00000000-0000-0000-0000-000000000aaa"
) {
  return {
    "X-API-Key": "test-api-key",
    "x-org-id": orgId,
    "x-user-id": userId,
    "x-run-id": runId,
    "Content-Type": "application/json",
  };
}
