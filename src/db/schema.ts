import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
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
// amount_cents is positive — these are credits, no sign convention needed.
//
// Idempotency is split by grant kind (migration 0025):
//   - invite/welcome/promo-redemption rows leave `idempotency_key` NULL and are
//     one-per-(org, promo_code) — enforced by the PARTIAL unique index
//     `idx_local_promos_org_promo … WHERE idempotency_key IS NULL`.
//   - admin_grant rows (staff oversight ledger) carry a caller-supplied
//     `idempotency_key`, which EXEMPTS them from the (org, promo_code) uniqueness
//     so multiple grants STACK; a retry with the same key is deduped by the
//     PARTIAL unique index `idx_local_promos_org_idempotency … WHERE idempotency_key
//     IS NOT NULL`. `granted_by` records the staff email behind the grant.
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
    // Staff email behind an admin_grant (null for non-admin rows). See 0025.
    grantedBy: text("granted_by"),
    // Caller-supplied stacking idempotency key for admin_grant rows (null for
    // invite/welcome/promo rows, which key idempotency on (org, promo_code)).
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_local_promos_org_promo")
      .on(table.orgId, table.promoCodeId)
      .where(sql`idempotency_key IS NULL`),
    index("idx_local_promos_org").on(table.orgId),
    uniqueIndex("idx_local_promos_org_idempotency")
      .on(table.orgId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ]
);

export type LocalPromo = typeof localPromos.$inferSelect;
export type NewLocalPromo = typeof localPromos.$inferInsert;

export const WELCOME_PROMO_CODE = "welcome";
// $2 welcome trial gift. Source of truth for live redemptions is the
// local_promo_codes row (seeded by migration 0016 @200, bumped to 2500 by
// migration 0018, reverted to 200 by migration 0019); this constant documents
// the canonical amount.
export const WELCOME_PROMO_AMOUNT_CENTS = 200;

// Platform-issued grant codes (DIS-64 Wave 0.5 invite-only gate).
// Backed by migration 0017. The invite_welcome grant replaces (not stacks)
// the welcome row at grant time — see lib/promos.ts grantCredit.
export const INVITE_REWARD_CODE = "invite_reward";
export const INVITE_WELCOME_CODE = "invite_welcome";
export const INVITE_GRANT_AMOUNT_CENTS = 2500;
export const FIRST_LOAD_MATCH_CODE = "first_load_match";
export const FIRST_LOAD_MATCH_CAP_CENTS = 2500;

// Admin-issued arbitrary-amount grant (staff oversight ledger, migration 0025).
// Per-row amount lives on local_promos (like first_load_match); the promo-code
// row's amount_cents is a 0 placeholder. admin_grant rows STACK via a
// caller-supplied idempotency_key — NOT part of PLATFORM_GRANT_REASONS (those
// dedup on (org, promo_code)); admin grants have their own dedup path.
export const ADMIN_GRANT_CODE = "admin_grant";

export const PLATFORM_GRANT_REASONS = [
  INVITE_REWARD_CODE,
  INVITE_WELCOME_CODE,
] as const;
export type PlatformGrantReason = (typeof PLATFORM_GRANT_REASONS)[number];

// credit_depletion_episodes: out-of-credit dunning state machine (issue #147).
// One OPEN episode per org at a time — enforced by the partial unique index
// `(org_id) WHERE recovered_at IS NULL`. An episode opens when an authorize
// call concludes depleted (balance <= 0) AND the request carries campaign /
// workflow activity. It closes (recovered_at set) when the scheduler observes a
// REAL recharge — `credited` increased above `credited_cents_at_open` (migration
// 0020). It deliberately does NOT close on balance > 0: balance flutters around
// zero from provisioned-cost churn (usage includes provisioned holds), and a
// balance-based recovery false-closed episodes and re-armed a fresh T0 email on
// every oscillation → customers got duplicate "out of credit" emails. `credited`
// only ever rises on a paid topup / promo, so it never flutters. A new depletion
// after a real recovery opens a fresh episode → the whole sequence re-arms.
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
    // `credited` snapshot at depletion. Recovery = current credited > this value
    // (a real recharge). Nullable for rows opened before migration 0020 — the
    // scheduler lazily backfills the baseline on its next tick.
    creditedCentsAtOpen: numeric("credited_cents_at_open", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }),
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

// campaign_authorize_costs: per-campaign estimate of the next run's cost.
// One row per campaign — the `required_cents` resolved by the MOST RECENT
// authorize attempt for that campaign (upserted on BOTH sufficient and
// insufficient outcomes). A campaign re-runs the same workflow, so the last
// attempt's cost is the best estimate of the next run's cost. Read by the
// read-only `GET /internal/campaigns/:campaignId/affordability` pre-flight gate
// (campaign-service consumes it to skip re-triggering a run an out-of-credit org
// cannot afford). No row → no history → first-run-affordable default.
export const campaignAuthorizeCosts = pgTable("campaign_authorize_costs", {
  campaignId: uuid("campaign_id").primaryKey(),
  orgId: uuid("org_id").notNull(),
  lastAuthorizeRequiredCents: numeric("last_authorize_required_cents", {
    precision: FRACTIONAL_PRECISION,
    scale: FRACTIONAL_SCALE,
  }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CampaignAuthorizeCost = typeof campaignAuthorizeCosts.$inferSelect;
export type NewCampaignAuthorizeCost = typeof campaignAuthorizeCosts.$inferInsert;

// brand_daily_budgets: org-scoped per-brand daily spend ceiling
// (allocation / pacing). A shared brand can belong to multiple orgs, so the
// mutable scalar is one row per (org_id, brand_id), not one row per brand.
// This is a PACING ceiling ("how much should THIS org spend for THIS brand per
// day"), a SEPARATE concept from org credit balance/affordability ("can the org
// pay"). billing-service only STORES + SERVES this value — enforcement (summing
// today's spend vs the ceiling, stop-when-exceeded) is campaign-service's job.
// Reads and writes both require org identity. No row for that org+brand → unset
// (the read returns dailyBudgetCents:null) — distinct from an explicit 0 (pause).
export const brandDailyBudgets = pgTable(
  "brand_daily_budgets",
  {
    brandId: uuid("brand_id").notNull(),
    orgId: uuid("org_id").notNull(),
    dailyBudgetCents: numeric("daily_budget_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "brand_daily_budgets_pkey",
      columns: [table.orgId, table.brandId],
    }),
  ]
);

export type BrandDailyBudget = typeof brandDailyBudgets.$inferSelect;
export type NewBrandDailyBudget = typeof brandDailyBudgets.$inferInsert;

// org_usage_discounts: per-org platform-usage discount (staff-managed).
// ONE row per org (org_id PK); absence of a row = no discount = today's exact
// behavior. discount_pct is an integer 0..100 (DB CHECK + route validation, no
// silent clamp). At balance composition, billing subtracts NET usage =
// gross_usage × (1 − discount_pct/100), so a discounted org's spendable balance
// depletes proportionally slower and its Stripe topups fire proportionally less
// often. The GROSS usage in runs-service is NEVER overwritten (reporting sees
// the full number). Replaceable (upsert) + removable (DELETE → null). set_by /
// set_at record which staff member set it and when. Migration 0026.
export const orgUsageDiscounts = pgTable("org_usage_discounts", {
  orgId: uuid("org_id").primaryKey(),
  discountPct: integer("discount_pct").notNull(),
  // Staff email behind the discount (null when set by a service with no email).
  setBy: text("set_by"),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type OrgUsageDiscount = typeof orgUsageDiscounts.$inferSelect;
export type NewOrgUsageDiscount = typeof orgUsageDiscounts.$inferInsert;

// Dunning eventTypes — byte-equal to the templates registered by the dashboard
// app (distribute.you#1420). LOCKED contract; do not rename.
export const DUNNING_EVENT_T0 = "credit-depleted";
export const DUNNING_EVENT_3D = "credit-depleted-followup-3d";
export const DUNNING_EVENT_10D = "credit-depleted-followup-10d";

// Blocked-card variants — sent when the org's saved card can't be charged
// off_session (auto-reload-blocked country, e.g. India / RBI). The auto-topup
// nudge in the base templates is a dead-end for these orgs, so these sibling
// templates swap it for manual-recharge copy. Byte-equal to the rows seeded in
// the transactional-email-service prod DB (distribute.you#2240, 4th surface).
// LOCKED contract; do not rename. Copy lives in the DB templates, never in code.
export const DUNNING_EVENT_T0_BLOCKED = "credit-depleted-blocked";
export const DUNNING_EVENT_3D_BLOCKED = "credit-depleted-followup-3d-blocked";
export const DUNNING_EVENT_10D_BLOCKED = "credit-depleted-followup-10d-blocked";
