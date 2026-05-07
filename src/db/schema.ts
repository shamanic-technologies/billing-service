import { sql } from "drizzle-orm";
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

export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    creditBalanceCents: numeric("credit_balance_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    })
      .notNull()
      .default("200"),
    reloadAmountCents: integer("reload_amount_cents"),
    reloadThresholdCents: integer("reload_threshold_cents").default(200),
    stripePaymentMethodId: text("stripe_payment_method_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_billing_accounts_org_id").on(table.orgId),
    index("idx_billing_accounts_stripe_customer").on(table.stripeCustomerId),
  ]
);

export type BillingAccount = typeof billingAccounts.$inferSelect;
export type NewBillingAccount = typeof billingAccounts.$inferInsert;

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

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    runId: uuid("run_id"),
    costId: uuid("cost_id"),
    type: text("type").notNull().default("debit"),
    amountCents: numeric("amount_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }).notNull(),
    status: text("status").notNull().default("pending"),
    source: text("source").notNull().default("charge"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeBalanceTxnId: text("stripe_balance_txn_id"),
    promoCodeId: uuid("promo_code_id").references(() => localPromoCodes.id),
    description: text("description"),
    campaignId: text("campaign_id"),
    brandIds: text("brand_ids").array(),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_transactions_org_id").on(table.orgId),
    index("idx_transactions_status").on(table.status),
    index("idx_transactions_source").on(table.source),
    index("idx_transactions_cost_id").on(table.costId),
    uniqueIndex("idx_transactions_reload_pi")
      .on(table.orgId, table.stripePaymentIntentId)
      .where(sql`source = 'reload' AND stripe_payment_intent_id IS NOT NULL`),
  ]
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
