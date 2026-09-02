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
import brandBudgetsRoutes from "./routes/brand_budgets.js";
import usageDiscountRoutes from "./routes/usage_discount.js";
import freeCreditPromisesRoutes from "./routes/free_credit_promises.js";
import { requireApiKey } from "./middleware/auth.js";
import { startDunningScheduler } from "./lib/dunning-scheduler.js";
import { deployEmailTemplates } from "./instrument.js";
import { auditChannelCoverage } from "./lib/channel-coverage.js";

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
app.use(brandBudgetsRoutes);
app.use(usageDiscountRoutes);
app.use(freeCreditPromisesRoutes);
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
        // Register the email templates this service sends. Fired only once the
        // port is bound, never awaited, and it never throws — an unreachable or
        // cold email service must not delay or break the boot. The receiving
        // PUT upserts by template name, so every restart re-registering is
        // harmless (no marker state anywhere).
        void deployEmailTemplates();
        // Report every published acquisition channel this service prices no
        // daily floor for. Changes nothing and refuses nothing — it makes the
        // gap visible on deploy instead of on a customer's screen. Same posture
        // as the template registration above: after listen, never awaited,
        // never throws.
        void auditChannelCoverage();
      });
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

export default app;
