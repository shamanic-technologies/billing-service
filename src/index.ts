import express from "express";
import cors from "cors";
import { resolve, dirname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import healthRoutes from "./routes/health.js";
import publicStatsRoutes from "./routes/public-stats.js";
import accountsRoutes from "./routes/accounts.js";
import customerBalanceRoutes from "./routes/customer_balance.js";
import checkoutRoutes from "./routes/checkout.js";
import portalRoutes from "./routes/portal.js";
import promotionCodesRoutes from "./routes/promotion_codes.js";
import internalRoutes from "./routes/internal.js";
import creditsRoutes from "./routes/credits.js";
import promoCodesRoutes from "./routes/promo_codes.js";
import { requireApiKey } from "./middleware/auth.js";
import { startDunningScheduler } from "./lib/dunning-scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3012;

app.use(cors());
app.use(express.json());

// Public routes
app.use(healthRoutes);
app.use(publicStatsRoutes);

// Serve OpenAPI spec (resolve relative to dist/ → ../openapi.json in Docker)
const openapiPath = resolve(__dirname, "..", "openapi.json");
app.get("/openapi.json", (_req, res) => {
  try {
    const spec = readFileSync(openapiPath, "utf-8");
    res.type("application/json").send(spec);
  } catch {
    res.status(404).json({ error: "OpenAPI spec not found" });
  }
});

// Protected routes (service-to-service)
app.use(requireApiKey);
app.use(internalRoutes);
app.use(creditsRoutes);
app.use(promoCodesRoutes);
app.use(accountsRoutes);
app.use(customerBalanceRoutes);
app.use(checkoutRoutes);
app.use(portalRoutes);
app.use(promotionCodesRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("Migrations complete");
      // Self-rescheduling, non-blocking — first tick deferred past boot.
      startDunningScheduler();
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
