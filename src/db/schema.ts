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
  unique,
  bigserial,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Sub-cent fractional cents — see migration 0013.
// Drizzle returns numeric columns as JS strings to preserve precision.
const FRACTIONAL_PRECISION = 16;
const FRACTIONAL_SCALE = 10;

// --- Free-credit offer: a PER-ACCOUNT property, frozen at account creation ---
//
// The offer is "$N in free credits in total, the remainder earned once your
// cumulative succeeded payments reach $N". Both figures used to be one global
// constant, so re-pricing the offer re-priced it for EVERY existing customer at
// once. They now live on the billing_accounts row (migration 0032), written ONCE
// from the DB column default at INSERT and never touched again — so a re-price is
// a one-line default change that grandfathers every existing org automatically,
// with no cutoff date and no backfill.
//
// The constants below are DEFAULTS AND DOCUMENTATION, never the value to apply to
// an org: always read `free_credit_entitlement_cents` / `free_credit_paid_trigger_cents`
// off the account. (There is deliberately no bare `FREE_CREDIT_ENTITLEMENT_CENTS`
// export any more — a global entitlement is the bug this shape exists to prevent.)

/** Total free credits a NEWLY created account may ever receive, welcome gift INCLUDED. */
export const CURRENT_FREE_CREDIT_ENTITLEMENT_CENTS = 40000;

/**
 * Cumulative SUCCEEDED payments that earn the completion for a NEWLY created
 * account. The trigger is money actually received — NOT usage consumed: the
 * account model is threshold-postpaid, so an org can consume on credit before
 * paying anything, and we must not gift credits to someone whose card may fail.
 */
export const CURRENT_FREE_CREDIT_PAID_TRIGGER_CENTS = 40000;

/**
 * What every account that existed before migration 0032 carries, permanently.
 * Kept as a named constant because it is the value the grandfathered cohort must
 * keep reading forever — not a historical footnote. Do NOT re-price it.
 */
export const GRANDFATHERED_FREE_CREDIT_ENTITLEMENT_CENTS = 2500;
export const GRANDFATHERED_FREE_CREDIT_PAID_TRIGGER_CENTS = 2500;

// billing_accounts: org ↔ topup config only. All Stripe state (customer id,
// payment method, paid balance) lives in stripe-service post-#0016.
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    topupAmountCents: integer("topup_amount_cents"),
    topupThresholdCents: integer("topup_threshold_cents").default(200),
    // Whether this org can still earn the welcome-COMPLETION gift (the second
    // half of the "$25 in free credits" promise — see lib/welcome-completion).
    // TRUE by default, and TRUE for every org today; it flips to FALSE only for an
    // org whose payments had ALREADY crossed the trigger before the automation
    // launched (granting those would be the retroactive credit the product owner
    // ruled out). That is resolved from Stripe's own payment history at settle
    // time and frozen here — see WELCOME_COMPLETION_LAUNCH_AT_ISO below and
    // migration 0030.
    welcomeCompletionEligible: boolean("welcome_completion_eligible")
      .notNull()
      .default(true),
    // The org's OWN free-credit offer, frozen at account creation (migration 0032).
    // Written from the DB column DEFAULT on INSERT and never updated: re-pricing the
    // offer moves the default for FUTURE accounts only, so every existing org keeps
    // the offer it signed up under with no cutoff rule and no backfill. Accounts that
    // predate 0032 carry GRANDFATHERED_* (2500/2500); accounts created after it carry
    // CURRENT_* (40000/40000). Read these — never a module-level constant.
    freeCreditEntitlementCents: integer("free_credit_entitlement_cents")
      .notNull()
      .default(CURRENT_FREE_CREDIT_ENTITLEMENT_CENTS),
    freeCreditPaidTriggerCents: integer("free_credit_paid_trigger_cents")
      .notNull()
      .default(CURRENT_FREE_CREDIT_PAID_TRIGGER_CENTS),
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
// $5 welcome trial gift. Source of truth for live redemptions is the
// local_promo_codes row (seeded by migration 0016 @200, bumped to 2500 by
// migration 0018, reverted to 200 by migration 0019, set to 500 by migration
// 0028); this constant documents the canonical amount.
export const WELCOME_PROMO_AMOUNT_CENTS = 500;

// Platform-issued grant codes (DIS-64 Wave 0.5 invite-only gate).
// Backed by migration 0017. Both are purely ADDITIVE: `invite_welcome` used to
// DELETE the org's `welcome` row so the two could not stack, which is exactly the
// behaviour the referral offer retires — nothing on an invite/referral path may
// remove or reduce an existing promise or an already-granted credit.
export const INVITE_REWARD_CODE = "invite_reward";
export const INVITE_WELCOME_CODE = "invite_welcome";

// NOTE: `first_load_match` is GONE (migration 0031). It backed the retired
// `POST /v1/accounts/wallet_setup` first-load-match, which onboarding abandoned
// and prod never once completed. Do NOT reintroduce it: it capped at $25 on its
// OWN with no reference to the free-credit entitlement above, so welcome +
// first_load_match granted $30 of free credit against a $25 entitlement. The
// promise it encoded is served by `welcome_completion`.

// --- Welcome-completion gift (migration 0029) ---
//
// Onboarding promises "$N in free credits". Signup grants only the `welcome`
// row, so the REMAINDER is granted under this code, exactly once per org, once
// the org's cumulative succeeded payments reach that account's OWN
// free_credit_paid_trigger_cents. The per-row amount is dynamic (that account's
// entitlement MINUS what the org was already gifted) and lives on local_promos —
// the promo-code row's amount_cents is a 0 placeholder, like admin_grant.
// See lib/welcome-completion.ts.
export const WELCOME_COMPLETION_CODE = "welcome_completion";

// Instant the welcome-completion automation went live (migration 0029 shipped).
//
// This is the ONLY thing "no backfill" means: an org whose cumulative payments had
// ALREADY crossed its own free_credit_paid_trigger_cents before this instant is owed
// nothing, because granting it would be a retroactive credit for a trigger that was
// satisfied before the offer existed. An org that had NOT yet crossed it earns the
// gift on its FUTURE payments exactly like a brand-new signup — most of the orgs the
// automation exists for signed up long ago, hold the $5 welcome row, and have not
// paid $25 yet.
//
// A fixed literal, never now(): the answer is derived from immutable payment history,
// so it is the same every time it is computed, and an org created after this instant
// can never be caught by it.
export const WELCOME_COMPLETION_LAUNCH_AT_ISO = "2026-07-30T00:00:00Z";
export const WELCOME_COMPLETION_LAUNCH_AT_MS = Date.parse(
  WELCOME_COMPLETION_LAUNCH_AT_ISO
);
/** Same instant in Stripe's unit — PaymentIntent.created is unix SECONDS. */
export const WELCOME_COMPLETION_LAUNCH_AT_UNIX = Math.floor(
  WELCOME_COMPLETION_LAUNCH_AT_MS / 1000
);

// --- Free-credit promises (migration 0033) ---
//
// An org may carry SEVERAL outstanding free-credit promises at once, each worth a
// different amount, each earned at a different bar, and some of them earned because
// somebody ELSE paid. `billing_accounts.free_credit_*` can express exactly one, which
// is why this table exists.
//
// A promise is a PROMISE, not money: no `local_promos` row is written until it is
// earned, so an outstanding promise never enters credited / balance / spendable.
//
// `amount_cents` and `paid_trigger_cents` are FROZEN at creation and never updated —
// same grandfathering discipline as the per-account offer (0032): re-pricing the
// referral offer reaches only promises created after the re-price, with no cutoff
// date and no backfill.
export const freeCreditPromises = pgTable(
  "free_credit_promises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    /** 'welcome' (the signup offer) | 'referral' (the invite offer). */
    kind: text("kind").notNull(),
    /** What lands when this promise is earned. Frozen at creation. */
    amountCents: integer("amount_cents").notNull(),
    /**
     * The bar: cumulative SUCCEEDED payments (net of refunds + lost disputes) that
     * earn this promise. Frozen at creation as
     * (highest bar the org already carries) + (this promise's own amount).
     */
    paidTriggerCents: integer("paid_trigger_cents").notNull(),
    /**
     * Set on the INVITEE's promise: the org that referred them. Granting the
     * invitee's promise is what opens the inviter's — never the invitee signing up.
     */
    referrerOrgId: uuid("referrer_org_id"),
    /**
     * Set on the INVITER's promise: which referred org converted and caused it. The
     * dashboard resolves this org to a brand name + logo through brand-service.
     */
    referredOrgId: uuid("referred_org_id"),
    /** NULL while outstanding. Stamped when the matching credit grant lands. */
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    /**
     * Notification markers. "Did we grant" and "did we tell them" are different
     * questions, so they get different columns: the sweep re-examines a promise
     * on every tick, and without these it would re-send on each pass.
     *
     * Stamped by a CONDITIONAL update that claims the right to send, so exactly
     * one caller sends even when two settles race. Never blocks a grant: a
     * notification that cannot go out leaves the money committed.
     */
    openedNotifiedAt: timestamp("opened_notified_at", { withTimezone: true }),
    grantedNotifiedAt: timestamp("granted_notified_at", { withTimezone: true }),
    /** The `local_promos` row that granted it (audit link); NULL while outstanding. */
    grantedLocalPromoId: uuid("granted_local_promo_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One welcome promise per org.
    uniqueIndex("idx_free_credit_promises_org_welcome")
      .on(table.orgId)
      .where(sql`kind = 'welcome'`),
    // An org is REFERRED at most once — a re-claimed invite is a no-op, and a claim
    // by a different inviter is rejected rather than silently stacked.
    uniqueIndex("idx_free_credit_promises_org_referrer")
      .on(table.orgId)
      .where(sql`referrer_org_id IS NOT NULL`),
    // One inviter promise per (inviter, invitee) pair — the exactly-once guard on a
    // replayed or concurrent settle of the invitee's promise.
    uniqueIndex("idx_free_credit_promises_org_referred")
      .on(table.orgId, table.referredOrgId)
      .where(sql`referred_org_id IS NOT NULL`),
    index("idx_free_credit_promises_org").on(table.orgId),
    index("idx_free_credit_promises_outstanding")
      .on(table.grantedAt)
      .where(sql`granted_at IS NULL`),
  ]
);

export type FreeCreditPromise = typeof freeCreditPromises.$inferSelect;
export type NewFreeCreditPromise = typeof freeCreditPromises.$inferInsert;

export const PROMISE_KIND_WELCOME = "welcome";
export const PROMISE_KIND_REFERRAL = "referral";
export type FreeCreditPromiseKind =
  | typeof PROMISE_KIND_WELCOME
  | typeof PROMISE_KIND_REFERRAL;

/**
 * Ledger key for a GRANTED referral promise (migration 0033).
 *
 * Unlike `admin_grant` / `welcome_completion`, this code row's `amount_cents` is not
 * a placeholder: it is the amount a NEW referral promise freezes ($500 today). It is
 * the live, runtime-re-priceable source (PATCH /internal/promo-codes/referral_reward),
 * so re-pricing the referral offer needs no migration and cannot reach a promise that
 * already froze its own figure.
 *
 * Referral grants STACK — an inviter with ten converting referrals holds ten of them
 * — so each grant row carries an `idempotency_key` (`promise:<promise_id>`), which
 * exempts it from the (org, promo_code) uniqueness and dedups on the promise instead.
 */
export const REFERRAL_REWARD_CODE = "referral_reward";

/**
 * What a NEWLY created referral promise is worth. DOCUMENTATION + the seed value in
 * migration 0033 — never the value to apply to an existing promise, which carries its
 * own frozen `amount_cents`. The live figure is the `referral_reward` promo-code row.
 */
export const CURRENT_REFERRAL_PROMISE_AMOUNT_CENTS = 50000;

// Admin-issued arbitrary-amount grant (staff oversight ledger, migration 0025).
// Per-row amount lives on local_promos; the promo-code
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

// brand_daily_budget_changes: append-only history of daily-budget writes.
// brand_daily_budgets holds only the CURRENT scalar (upserted in place), so the
// timeline of raises/lowers/zeroings is lost. This table records ONE row per
// write — the value the budget BECAME and WHEN — for the customer-health board
// (features-service) to render a per-(org, brand) budget-change timeline.
// Forward-only: no backfill of pre-existing history (never captured). Written in
// the SAME transaction as the brand_daily_budgets upsert. `id` (bigserial) is a
// stable secondary sort so same-millisecond writes keep insertion order.
export const brandDailyBudgetChanges = pgTable(
  "brand_daily_budget_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    dailyBudgetCents: numeric("daily_budget_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }).notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("brand_daily_budget_changes_org_brand_changed_at_idx").on(
      table.orgId,
      table.brandId,
      table.changedAt,
      table.id
    ),
  ]
);

// brand_funnel_daily_budgets: ONE daily spend ceiling per (org, brand, funnel).
// A brand sells through several SALES FUNNELS (brand-service's vocabulary:
// reply_meeting, visit_meeting, visit_signup, visit_form) whose economics differ
// by orders of magnitude, so they must be fundable independently.
//
// The brand-level value is DERIVED from these rows (their sum) once any exist —
// see lib/brand-funnel-budgets.ts. A brand that has never set per-funnel ceilings
// keeps its brand_daily_budgets row as the authoritative value (no backfill), so
// every existing consumer of the brand-level read is unaffected.
//
// 0 is a legal value ("not funding that funnel right now"), including a set where
// every funnel is 0 (a brand in pause). The per-funnel product MINIMUM applies
// only to a funded (> 0) funnel and lives in the service layer, not in a CHECK —
// the minimums are product figures that move.
export const brandFunnelDailyBudgets = pgTable(
  "brand_funnel_daily_budgets",
  {
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    /** A brand-service sales-funnel key. Validated in the service layer. */
    funnelKey: text("funnel_key").notNull(),
    /**
     * The ACQUISITION CHANNEL this ceiling funds, as a features-service feature
     * slug (migration 0036). A channel IS a feature slug — there is no separate
     * channel vocabulary — so the same funnel worked through two offers holds
     * two rows, each paced and priced on its own money. Deliberately NOT
     * validated against a list of slugs: which feature may be sold through which
     * funnel is features-service's statement, not this service's.
     */
    featureSlug: text("feature_slug").notNull(),
    /**
     * The OFFER this ceiling funds — one distinct thing the brand sells
     * (migration 0037). brand-service owns the entity and exposes it as a UUID;
     * billing defines none of its semantics and, exactly as with the channel
     * slug, never validates it against another service.
     *
     * NULLABLE, and the NULL is a first-class permanent value: "this ceiling is
     * not scoped to an offer". Every ceiling written before 0037 carries it and
     * there is no backfill — only brand-service knows which offer a live ceiling
     * belongs to, and guessing would move real money onto the wrong campaign.
     * That is why the key below is a UNIQUE ... NULLS NOT DISTINCT constraint
     * rather than a primary key: a primary key cannot hold a nullable column,
     * and NULLS NOT DISTINCT still makes two unscoped ceilings for one
     * (funnel, channel) pair unrepresentable.
     */
    offerId: uuid("offer_id"),
    /**
     * The funnel LEG this ceiling funds — features-service's canonical leg id
     * (migration 0039).
     *
     * A sales funnel is a chain of steps and the thing a customer BUYS is one of
     * its LEGS: the leg that takes a lead sitting at one step and moves it to
     * the next. A campaign is (brand, offer, acquisition channel, leg), so this
     * is the grain the money that paces a campaign is keyed on.
     *
     * features-service OWNS the vocabulary and MINTS the identifier (its
     * `lib/funnel-legs.ts`, published on `GET /public/channels` as
     * `legs[].legKey`); campaign-service carries the same value on the campaign
     * row. This column carries it and nothing else — no leg vocabulary, enum or
     * list exists here and none is to be introduced, exactly as for the channel
     * slug and the offer id. OPAQUE, and never PARSED: the two steps a leg
     * connects ride BESIDE the identifier on that catalogue (`fromStep` /
     * `toStep`), so a consumer that wants them reads them there. `text`, because
     * that is the shape features-service mints.
     *
     * NULLABLE, and the NULL is a first-class permanent value: "this ceiling is
     * not scoped to a leg". Every ceiling written before 0039 carries it and
     * there is no backfill — a funnel has several legs and a leg belongs to
     * several funnels, so nothing here can derive one, and guessing would move
     * real money onto the wrong campaign.
     *
     * The FUNNEL stays in the key beside it: this is the additive half, and a
     * later ship removes the funnel once every consumer has moved.
     */
    legKey: text("leg_key"),
    dailyBudgetCents: numeric("daily_budget_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("brand_funnel_daily_budgets_leg_key")
      .on(
        table.orgId,
        table.brandId,
        table.funnelKey,
        table.featureSlug,
        table.offerId,
        table.legKey
      )
      .nullsNotDistinct(),
    index("brand_funnel_daily_budgets_org_brand_idx").on(
      table.orgId,
      table.brandId
    ),
    index("brand_funnel_daily_budgets_org_brand_funnel_idx").on(
      table.orgId,
      table.brandId,
      table.funnelKey
    ),
    index("brand_funnel_daily_budgets_org_brand_funnel_channel_idx").on(
      table.orgId,
      table.brandId,
      table.funnelKey,
      table.featureSlug
    ),
    index("brand_funnel_daily_budgets_org_brand_funnel_channel_offer_idx").on(
      table.orgId,
      table.brandId,
      table.funnelKey,
      table.featureSlug,
      table.offerId
    ),
  ]
);

export type BrandFunnelDailyBudget =
  typeof brandFunnelDailyBudgets.$inferSelect;
export type NewBrandFunnelDailyBudget =
  typeof brandFunnelDailyBudgets.$inferInsert;

export type BrandDailyBudgetChange = typeof brandDailyBudgetChanges.$inferSelect;
export type NewBrandDailyBudgetChange =
  typeof brandDailyBudgetChanges.$inferInsert;

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
