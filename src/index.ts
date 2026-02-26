import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import healthRoutes from "./routes/health.js";
import accountsRoutes from "./routes/accounts.js";
import creditsRoutes from "./routes/credits.js";
import checkoutRoutes from "./routes/checkout.js";
import webhookRoutes from "./routes/webhooks.js";
import { requireApiKey } from "./middleware/auth.js";
import { registerAllAppKeys } from "./lib/key-client.js";

const app = express();
const PORT = process.env.PORT || 3012;

app.use(cors());

// Webhook route needs raw body for Stripe signature — register BEFORE express.json()
app.use("/v1/webhooks/stripe", express.raw({ type: "application/json" }));
app.use(webhookRoutes);

// JSON parser for all other routes
app.use(express.json());

// Public routes
app.use(healthRoutes);

// Serve OpenAPI spec
app.get("/openapi.json", (_req, res) => {
  try {
    const spec = readFileSync("openapi.json", "utf-8");
    res.type("application/json").send(spec);
  } catch {
    res.status(404).json({ error: "OpenAPI spec not found" });
  }
});

// Protected routes (service-to-service)
app.use(requireApiKey);
app.use(accountsRoutes);
app.use(creditsRoutes);
app.use(checkoutRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("Migrations complete");
      return registerAllAppKeys();
    })
    .then(() => {
      app.listen(Number(PORT), "::", () => {
        console.log(`Billing service running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

export default app;
