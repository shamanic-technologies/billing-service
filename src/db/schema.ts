import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Sub-cent fractional cents — see migration 0013.
// Drizzle returns numeric columns as JS strings to preserve precision.
const FRACTIONAL_PRECISION = 16;
const FRACTIONAL_SCALE = 10;

// billing_accounts: org ↔ topup config only. All Stripe state (customer id,
// payment method, paid balance) lives in stripe-service post-#0016.
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    topupAmountCents: integer("topup_amount_cents"),
    topupThresholdCents: integer("topup_threshold_cents").default(200),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_billing_accounts_org_id").on(table.orgId),
  ]
);

export type BillingAccount = typeof billingAccounts.$inferSelect;
export type NewBillingAccount = typeof billingAccounts.$inferInsert;

// local_promo_codes: code definitions. Welcome gift is seeded as code='welcome'.
export const localPromoCodes = pgTable(
  "local_promo_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    amountCents: integer("amount_cents").notNull(),
    maxRedemptions: integer("max_redemptions"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("idx_local_promo_codes_code").on(table.code)]
);

export type LocalPromoCode = typeof localPromoCodes.$inferSelect;
export type NewLocalPromoCode = typeof localPromoCodes.$inferInsert;

// local_promos: per-org credit grants from promo codes (incl. welcome).
// One row per (org, promo_code) UNIQUE. Welcome is just another promo code.
// amount_cents is positive — these are credits, no sign convention needed.
export const localPromos = pgTable(
  "local_promos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    amountCents: numeric("amount_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }).notNull(),
    promoCodeId: uuid("promo_code_id")
      .notNull()
      .references(() => localPromoCodes.id),
    description: text("description"),
    brandIds: text("brand_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_local_promos_org_promo").on(table.orgId, table.promoCodeId),
    index("idx_local_promos_org").on(table.orgId),
  ]
);

export type LocalPromo = typeof localPromos.$inferSelect;
export type NewLocalPromo = typeof localPromos.$inferInsert;

export const WELCOME_PROMO_CODE = "welcome";
export const WELCOME_PROMO_AMOUNT_CENTS = 200;
