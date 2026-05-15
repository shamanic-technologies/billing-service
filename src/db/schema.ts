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
    // Prepaid balance liability (what we owe the org). Stored unsigned positive
    // in the cache column; per-row direction is encoded by amount_cents sign on
    // the customer_balance_transactions ledger.
    balanceCents: numeric("balance_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    })
      .notNull()
      .default("200"),
    topupAmountCents: integer("topup_amount_cents"),
    topupThresholdCents: integer("topup_threshold_cents").default(200),
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

// `customer_balance_transactions` — Stripe-aligned ledger.
// type: 'payment' | 'gift' | 'promo' | 'refund' | 'usage_applied' (frozen)
// status: 'requires_capture' | 'succeeded' | 'canceled'
// amount_cents: signed — negative = credit (balance increases), positive = debit (balance decreases).
//   balanceCents = − SUM(amount_cents) WHERE status='succeeded'.
export const customerBalanceTransactions = pgTable(
  "customer_balance_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    runId: uuid("run_id"),
    costId: uuid("cost_id"),
    type: text("type").notNull().default("payment"),
    amountCents: numeric("amount_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }).notNull(),
    status: text("status").notNull().default("requires_capture"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeBalanceTransactionId: text("stripe_balance_transaction_id"),
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
    index("idx_cbt_org_id").on(table.orgId),
    index("idx_cbt_status").on(table.status),
    index("idx_cbt_type").on(table.type),
    index("idx_cbt_cost_id").on(table.costId),
    uniqueIndex("idx_cbt_payment_pi")
      .on(table.orgId, table.stripePaymentIntentId)
      .where(sql`type = 'payment' AND stripe_payment_intent_id IS NOT NULL`),
  ]
);

export type CustomerBalanceTransaction =
  typeof customerBalanceTransactions.$inferSelect;
export type NewCustomerBalanceTransaction =
  typeof customerBalanceTransactions.$inferInsert;
