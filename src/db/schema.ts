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
import { sql } from "drizzle-orm";

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
// $25 welcome trial gift. Source of truth for live redemptions is the
// local_promo_codes row (seeded by migration 0016 @200, bumped to 2500 by
// migration 0018); this constant documents the canonical amount.
export const WELCOME_PROMO_AMOUNT_CENTS = 2500;

// Platform-issued grant codes (DIS-64 Wave 0.5 invite-only gate).
// Backed by migration 0017. The invite_welcome grant replaces (not stacks)
// the welcome row at grant time — see lib/promos.ts grantCredit.
export const INVITE_REWARD_CODE = "invite_reward";
export const INVITE_WELCOME_CODE = "invite_welcome";
export const INVITE_GRANT_AMOUNT_CENTS = 2500;

export const PLATFORM_GRANT_REASONS = [
  INVITE_REWARD_CODE,
  INVITE_WELCOME_CODE,
] as const;
export type PlatformGrantReason = (typeof PLATFORM_GRANT_REASONS)[number];

// credit_depletion_episodes: out-of-credit dunning state machine (issue #147).
// One OPEN episode per org at a time — enforced by the partial unique index
// `(org_id) WHERE recovered_at IS NULL`. An episode opens when an authorize
// call concludes depleted (balance <= 0) AND the request carries campaign /
// workflow activity. It closes (recovered_at set) when the scheduler observes
// the balance restored. A new depletion after a recovery opens a fresh episode
// → the whole sequence re-arms.
//
// Per-stage `*_sent_at` stamps give at-most-once-per-stage idempotency; the
// scheduler atomic-claims each stage via `UPDATE ... WHERE <stage> IS NULL
// RETURNING` so overlapping ticks / multiple replicas never double-send.
export const creditDepletionEpisodes = pgTable(
  "credit_depletion_episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    // Captured at depletion — used for recipient resolution (x-user-id fallback)
    // and to rebuild the identity for the scheduler's balance recompute.
    userId: uuid("user_id").notNull(),
    // The run + campaign that detected depletion (tracking / x-run-id reuse).
    runId: uuid("run_id"),
    campaignId: uuid("campaign_id"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    t0SentAt: timestamp("t0_sent_at", { withTimezone: true }),
    followup3dSentAt: timestamp("followup_3d_sent_at", { withTimezone: true }),
    followup10dSentAt: timestamp("followup_10d_sent_at", { withTimezone: true }),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_one_open_episode_per_org")
      .on(table.orgId)
      .where(sql`recovered_at IS NULL`),
    index("idx_credit_depletion_open").on(table.recoveredAt),
  ]
);

export type CreditDepletionEpisode = typeof creditDepletionEpisodes.$inferSelect;
export type NewCreditDepletionEpisode = typeof creditDepletionEpisodes.$inferInsert;

// Dunning eventTypes — byte-equal to the templates registered by the dashboard
// app (distribute.you#1420). LOCKED contract; do not rename.
export const DUNNING_EVENT_T0 = "credit-depleted";
export const DUNNING_EVENT_3D = "credit-depleted-followup-3d";
export const DUNNING_EVENT_10D = "credit-depleted-followup-10d";
