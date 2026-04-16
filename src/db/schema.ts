import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    creditBalanceCents: integer("credit_balance_cents").notNull().default(200),
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

export const creditProvisions = pgTable(
  "credit_provisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    runId: uuid("run_id"),
    type: text("type").notNull().default("debit"),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("pending"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
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
    index("idx_credit_provisions_org_id").on(table.orgId),
    index("idx_credit_provisions_status").on(table.status),
  ]
);

export type CreditProvision = typeof creditProvisions.$inferSelect;
export type NewCreditProvision = typeof creditProvisions.$inferInsert;

export const promoCodes = pgTable(
  "promo_codes",
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
  (table) => [uniqueIndex("idx_promo_codes_code").on(table.code)]
);

export type PromoCode = typeof promoCodes.$inferSelect;
export type NewPromoCode = typeof promoCodes.$inferInsert;

export const promoRedemptions = pgTable(
  "promo_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promoCodeId: uuid("promo_code_id")
      .notNull()
      .references(() => promoCodes.id),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_promo_redemptions_org_code").on(
      table.promoCodeId,
      table.orgId
    ),
    index("idx_promo_redemptions_org_id").on(table.orgId),
  ]
);

export type PromoRedemption = typeof promoRedemptions.$inferSelect;
export type NewPromoRedemption = typeof promoRedemptions.$inferInsert;
