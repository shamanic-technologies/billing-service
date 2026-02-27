import express from "express";
import cors from "cors";
import healthRoutes from "../../src/routes/health.js";
import accountsRoutes from "../../src/routes/accounts.js";
import creditsRoutes from "../../src/routes/credits.js";
import checkoutRoutes from "../../src/routes/checkout.js";
import webhookRoutes from "../../src/routes/webhooks.js";
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

  // Protected routes
  app.use(requireApiKey);
  app.use(accountsRoutes);
  app.use(creditsRoutes);
  app.use(checkoutRoutes);

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

export function getAuthHeaders(
  orgId = "00000000-0000-0000-0000-000000000001",
  appId = "testapp",
  keySource?: "app" | "byok" | "platform"
) {
  const headers: Record<string, string> = {
    "X-API-Key": "test-api-key",
    "x-org-id": orgId,
    "x-app-id": appId,
    "Content-Type": "application/json",
  };
  if (keySource) {
    headers["x-key-source"] = keySource;
  }
  return headers;
}
