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

/**
 * Total free credits a NEWLY created account may ever receive, welcome gift INCLUDED.
 *
 * $30, and the offer is no longer a MATCH: the whole amount is granted at signup by
 * the `welcome` promo row, unconditionally, with nothing left to earn. So for a new
 * account this figure is also exactly what signup already gave, which is why the
 * completion remainder is zero and `settleWelcomeCompletion` no-ops for that cohort.
 * The two earlier cohorts ($25 grandfathered, $400) keep their own frozen figures and
 * their own two-stage behaviour — see the column comment below.
 */
export const CURRENT_FREE_CREDIT_ENTITLEMENT_CENTS = 3000;

/**
 * Cumulative SUCCEEDED payments that earn the completion for a NEWLY created
 * account. The trigger is money actually received — NOT usage consumed: the
 * account model is threshold-postpaid, so an org can consume on credit before
 * paying anything, and we must not gift credits to someone whose card may fail.
 *
 * Equal to the entitlement, as it has been for every cohort. At $30 that equality
 * has a second consequence worth stating: signup already grants the full $30, so the
 * remainder is zero before the trigger is ever consulted and no new account can reach
 * a second grant whatever it pays. The trigger still governs the two older cohorts.
 */
export const CURRENT_FREE_CREDIT_PAID_TRIGGER_CENTS = 3000;

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
    // predate 0032 carry GRANDFATHERED_* (2500/2500); accounts created between 0032
    // and 0040 carry 40000/40000; accounts created after 0040 carry CURRENT_*
    // (3000/3000). Read these — never a module-level constant.
    freeCreditEntitlementCents: integer("free_credit_entitlement_cents")
      .notNull()
      .default(CURRENT_FREE_CREDIT_ENTITLEMENT_CENTS),
    freeCreditPaidTriggerCents: integer("free_credit_paid_trigger_cents")
      .notNull()
      .default(CURRENT_FREE_CREDIT_PAID_TRIGGER_CENTS),
    // How this org pays — the customer's explicit choice (migration 0050). Every
    // existing row and every new account is 'postpaid' until someone chooses
    // otherwise. See lib/payment-mode.
    paymentMode: text("payment_mode").notNull().default("postpaid"),
    // When this org last opened a SUBSCRIPTION checkout (migration 0055). Cleared
    // once the subscription is observed live (or the attempt is abandoned), so it
    // bounds which orgs the hourly settle asks stripe-service about. See
    // lib/subscription.
    subscriptionCheckoutStartedAt: timestamp("subscription_checkout_started_at", {
      withTimezone: true,
    }),
    // The monthly amount the customer picked when opening the subscription
    // checkout (migration 0056); the subscription starts at it once the card is saved.
    subscriptionRequestedAmountCents: integer("subscription_requested_amount_cents"),
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

// --- Trial seed (migration 0046) ---
//
// An organisation can exist, and spend, BEFORE anyone has signed up: the dashboard
// walks a visitor through their whole setup (reading their site, drafting an offer,
// assembling audiences) against an ordinary org that simply has no identity-provider
// identity yet. That work is metered, so a stranger typing a URL spends our money.
//
// What caps them is CREDIT, not a counter: the org is seeded with the WHOLE live
// welcome amount (owner decision 2026-09-28, was a $5 then $12 slice) and the
// affordability gate this service already enforces refuses the first call it
// cannot afford. No new threshold, no consumer-side spend limit.
//
// It is recorded under its OWN ledger key, never as the welcome gift — the two mean
// different things and the customer eventually sees the welcome one by name. The seed
// is NEVER surfaced to the visitor.
//
// Per-row amount lives on local_promos (the code row's amount_cents is a 0
// placeholder) because the figure is derived from the LIVE welcome amount — see
// lib/trial-seed.ts.
export const TRIAL_SEED_CODE = "trial_seed";


// --- The welcome gift is once per PERSON (migration 0049) ---
//
// One row per person: the org where that person's welcome lives. The primary key on
// the person is the guarantee — a second org the same person creates gets no welcome
// and an account whose own free-credit offer is zero (see lib/welcome-recipient.ts).
// A person is the client-service internal user id carried as `x-user-id`; the
// all-zeros PLATFORM_USER_ID sentinel is never a person and is never written here.
export const welcomeRecipients = pgTable(
  "welcome_recipients",
  {
    userId: uuid("user_id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_welcome_recipients_org").on(table.orgId)]
);

export type WelcomeRecipient = typeof welcomeRecipients.$inferSelect;

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

/**
 * Ledger key for a product-task reward (migration 0045).
 *
 * A customer is paid a small fixed credit each time they complete a product task,
 * and the SAME task recurs for the same org roughly every month, forever. So this
 * reason CANNOT dedup on (org, promo_code) the way the two invite reasons do — that
 * shape pays once and then silently never again. It STACKS instead, on the caller's
 * own per-completion identifier (`idempotency_key = 'task:<completionId>'`), which
 * exempts it from the (org, promo_code) uniqueness and dedups on the completion.
 *
 * Same stacking mechanism as `admin_grant` / `referral_reward`, reached from the
 * SERVICE-TO-SERVICE path: no staff identity and no staff email is involved, so
 * `granted_by` stays NULL on these rows.
 *
 * The per-row amount lives on local_promos; this code row's amount_cents is a 0
 * placeholder (the caller states what each completion is worth).
 */
export const PRODUCT_TASK_REWARD_CODE = "product_task_completed";

/**
 * Ledger key for the organization-creation bonus (migration 0052).
 *
 * Every newly created organization receives a small free credit ONCE, so its very
 * first setup steps (reading the brand's website, drafting its offer and audiences)
 * can run. It exists because the welcome gift is once per PERSON: a person creating a
 * second organization gets no welcome there, so the new org would start at $0 and
 * every metered setup call would be refused.
 *
 * Deliberately NOT tied to the welcome logic: it is granted whether or not the
 * person already received a welcome elsewhere, it is not counted against the
 * welcome entitlement (lib/promos sumEntitlementGrantsForOrg), and it is listed in
 * the grants ledger under its own reason.
 *
 * ONE-SHOT per org: idempotent on (org_id, promo_code) — the partial unique index
 * `idx_local_promos_org_promo` — so a retry never pays twice. Billing owns the
 * amount: it is this code row's `amount_cents` (seeded at 500, re-priceable at
 * runtime via PATCH /internal/promo-codes/org_creation_bonus), never a caller figure.
 */
export const ORG_CREATION_BONUS_CODE = "org_creation_bonus";

/** Seed default of the org-creation bonus (migration 0052). The live figure is the code row. */
export const ORG_CREATION_BONUS_AMOUNT_CENTS = 500;

/**
 * Ledger key for the SUBSCRIPTION trial grant (migration 0055): when an org's
 * subscription trial starts, its free credit is topped up to this code row's
 * amount ($99 seeded), at our expense even if it cancels during the trial.
 *
 * ONE-SHOT per org on the partial unique (org_id, promo_code_id) index. The amount
 * is the live code row (re-priceable via PATCH /internal/promo-codes/subscription_trial).
 * See lib/subscription.
 */
export const SUBSCRIPTION_TRIAL_CODE = "subscription_trial";

/** Seed default of the subscription trial grant (migration 0055). The live figure is the code row. */
export const SUBSCRIPTION_TRIAL_AMOUNT_CENTS = 9900;

/**
 * Grant reasons a SERVICE may name on POST /internal/credits/grant. Closed set —
 * a caller can never supply an arbitrary reason.
 *
 * They do NOT share one idempotency shape, and conflating them is the bug this
 * split exists to prevent:
 *   - PLATFORM_GRANT_REASONS   one-shot per (org, reason), idempotency_key NULL.
 *   - STACKING_GRANT_REASONS   recurring, one row per caller-supplied completion id.
 */
export const PLATFORM_GRANT_REASONS = [
  INVITE_REWARD_CODE,
  INVITE_WELCOME_CODE,
] as const;
export type PlatformGrantReason = (typeof PLATFORM_GRANT_REASONS)[number];

export const STACKING_GRANT_REASONS = [PRODUCT_TASK_REWARD_CODE] as const;
export type StackingGrantReason = (typeof STACKING_GRANT_REASONS)[number];

export const SERVICE_GRANT_REASONS = [
  ...PLATFORM_GRANT_REASONS,
  ...STACKING_GRANT_REASONS,
] as const;
export type ServiceGrantReason = (typeof SERVICE_GRANT_REASONS)[number];

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
    // Claims the ONE "your card is gone, we cannot collect what you owe"
    // notification (customer + staff) for this episode — migration 0041. The
    // hourly sweep re-examines every open episode, so without this marker the
    // same debt would be mailed about forever. Cleared when the org regains a
    // chargeable card, so a LATER loss notifies again.
    cardRequiredNotifiedAt: timestamp("card_required_notified_at", {
      withTimezone: true,
    }),
    // Amount owed while the debt is uncollectable, refreshed on each dunning
    // tick — lets the staff read be a plain DB read with no per-org fan-out.
    // NULL = this debt is not (or is no longer) uncollectable.
    uncollectableDebtCents: numeric("uncollectable_debt_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }),
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

// campaign_reload_sweep_attempts: one row per org the blocked-campaign reload
// sweep has already presented a card for, keyed on the CREDITED total it saw.
//
// The sweep breaks a deadlock; it does not collect a debt. Once it has presented
// a card and the card refused, the org is blocked by its own card — a state the
// depletion-episode dunning engine already owns — so re-presenting it on every
// hourly tick would degrade the card at its issuer and our decline rate at the
// acquirer (see lib/reload-coalescer) for no chance of a different answer.
//
// `creditedCentsAtAttempt` is what makes "something changed" answerable with no
// new lifecycle: credited only ever RISES, so any recharge (paid top-up, promo,
// staff grant) moves it and re-arms the sweep for that org, while a dead card
// moves nothing and is attempted exactly once. Migration 0042.
export const campaignReloadSweepAttempts = pgTable("campaign_reload_sweep_attempts", {
  orgId: uuid("org_id").primaryKey(),
  creditedCentsAtAttempt: numeric("credited_cents_at_attempt", {
    precision: FRACTIONAL_PRECISION,
    scale: FRACTIONAL_SCALE,
  }).notNull(),
  /** "succeeded" | "failed". A succeeded row never stands an org down. */
  lastOutcome: text("last_outcome").notNull(),
  /**
   * Which rung of the retry schedule the last attempt was. 1 = the first
   * failure of this streak. Reset whenever `credited` moves.
   */
  attemptCount: integer("attempt_count").notNull().default(1),
  /**
   * When this streak's FIRST failure happened — the anchor the whole schedule
   * is measured from, so a restart or a deploy cannot shift the next rung.
   */
  firstFailedAt: timestamp("first_failed_at", { withTimezone: true }),
  /**
   * Claims the ONE "we could not charge your card" mail for this streak.
   * DURABLE on purpose: the gate used to be lib/reload-coalescer's in-memory
   * failure counter, which a deploy resets — and we deploy several times a day,
   * so "once per streak" silently meant "once per deploy". Migration 0043.
   */
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  /**
   * The acquirer's own reason for the last refusal, kept so a verdict about the
   * card can be audited rather than guessed at. Migration 0044.
   */
  lastDeclineCode: text("last_decline_code"),
  /**
   * Set when the bank said the card is PERMANENTLY unusable (lost, stolen,
   * account closed, authorization revoked). Card-network rules forbid
   * resubmitting those at any interval, so both sweeps stop presenting it.
   * Cleared by any successful charge. Migration 0044.
   */
  cardUnusableAt: timestamp("card_unusable_at", { withTimezone: true }),
  attemptedAt: timestamp("attempted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CampaignReloadSweepAttempt =
  typeof campaignReloadSweepAttempts.$inferSelect;

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

// campaign_daily_budgets: ONE daily spend ceiling per CAMPAIGN of an org+brand.
// A campaign is (offer x leg x acquisition channel), so a ceiling is keyed on
// exactly that. The brand-level value is DERIVED from these rows (their sum) once
// any exist - see lib/campaign-budgets.ts. A brand that has never set a ceiling
// keeps its brand_daily_budgets row as the authoritative value (no backfill).
//
// Until migration 0048 this table was `brand_funnel_daily_budgets` and carried a
// `funnel_key` in its identity. The sales funnel was retired fleet-wide (one leg
// belongs to several funnels, so the funnel never identified what was bought),
// and 0048 dropped it after snapshotting the column in production.
//
// 0 is a legal value ("not funding this campaign right now"), including a brand
// whose every ceiling is 0 (a brand in pause). The acquisition channel's daily
// minimum applies only to a funded (> 0) channel and lives in the service layer,
// not in a CHECK - the minimums are published figures that move.
export const campaignDailyBudgets = pgTable(
  "campaign_daily_budgets",
  {
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    /**
     * The ACQUISITION CHANNEL this ceiling funds, as a features-service feature
     * slug. A channel IS a feature slug - there is no separate channel
     * vocabulary. Deliberately NOT validated against a list of slugs.
     */
    featureSlug: text("feature_slug").notNull(),
    /**
     * The OFFER this ceiling funds - one distinct thing the brand sells.
     * brand-service owns the entity and exposes it as a UUID; billing defines
     * none of its semantics and never validates it against another service.
     *
     * NULLABLE, and the NULL is a first-class permanent value: "this ceiling is
     * not scoped to an offer" (written before offers existed). There is no
     * backfill - guessing would move real money onto the wrong campaign. That is
     * why the key below is a UNIQUE ... NULLS NOT DISTINCT constraint rather than
     * a primary key.
     */
    offerId: uuid("offer_id"),
    /**
     * The LEG this ceiling funds - features-service's canonical leg id, carried
     * OPAQUE and never parsed (the two steps a leg connects ride beside it on
     * features-service's catalogue). NULLABLE with the same meaning as the offer:
     * "written before legs existed", a permanent value, never backfilled.
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
    unique("campaign_daily_budgets_campaign_key")
      .on(
        table.orgId,
        table.brandId,
        table.featureSlug,
        table.offerId,
        table.legKey
      )
      .nullsNotDistinct(),
    index("campaign_daily_budgets_org_brand_idx").on(
      table.orgId,
      table.brandId
    ),
  ]
);

/** One stored campaign ceiling. */
export type CeilingRow = typeof campaignDailyBudgets.$inferSelect;
export type NewCeilingRow = typeof campaignDailyBudgets.$inferInsert;

// brand_sales_budgets: ONE daily budget for SALES stated at the BRAND grain
// (migration 0054). A brand that states one runs in "global" mode: campaign-
// service decides where the money goes (the best-return sales path), instead of
// pacing each campaign on its own ceiling. Clearing it DELETES the row and the
// brand is back on its campaign ceilings, which this table never touches.
// No row = the brand never stated one (or cleared it) = "campaigns" mode.
// 0 is a legal stated value (a brand that sells nothing today), distinct from
// no row at all.
export const brandSalesBudgets = pgTable(
  "brand_sales_budgets",
  {
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
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
      name: "brand_sales_budgets_pkey",
      columns: [table.orgId, table.brandId],
    }),
  ]
);

export type BrandSalesBudget = typeof brandSalesBudgets.$inferSelect;

// brand_sales_budget_changes: append-only history of every state / clear of
// the brand's global sales budget. `daily_budget_cents` NULL = cleared (the
// brand went back to its campaign ceilings). Written in the SAME transaction as
// the brand_sales_budgets write. Forward-only.
export const brandSalesBudgetChanges = pgTable(
  "brand_sales_budget_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    dailyBudgetCents: numeric("daily_budget_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("brand_sales_budget_changes_org_brand_changed_at_idx").on(
      table.orgId,
      table.brandId,
      table.changedAt,
      table.id
    ),
  ]
);

export type BrandSalesBudgetChange = typeof brandSalesBudgetChanges.$inferSelect;

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

// brand_transfers: a brand transfer moves HISTORY, not MONEY (migration 0051).
// runs-service moves the brand's cost rows to the target org, so billing records
// here what moved — net PROJECTED (platform actual + provisioned) and net
// ACTUALIZED — and balance composition adds it back to the source org and takes
// it off the target org (lib/transfer-usage.ts). Both orgs therefore read the
// balance they read before the transfer. Also the audit trail staff read to see
// that a balance correction came from a transfer: which brand, which orgs, when.
export const brandTransfers = pgTable(
  "brand_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceOrgId: uuid("source_org_id").notNull(),
    sourceBrandId: uuid("source_brand_id").notNull(),
    targetOrgId: uuid("target_org_id").notNull(),
    targetBrandId: uuid("target_brand_id"),
    movedUsageNetCents: numeric("moved_usage_net_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }).notNull(),
    movedActualNetCents: numeric("moved_actual_net_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }).notNull(),
    transferredAt: timestamp("transferred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("brand_transfers_source_target_key").on(
      table.sourceOrgId,
      table.sourceBrandId,
      table.targetOrgId
    ),
    index("idx_brand_transfers_source_org").on(table.sourceOrgId),
    index("idx_brand_transfers_target_org").on(table.targetOrgId),
  ]
);

export type BrandTransfer = typeof brandTransfers.$inferSelect;

// staff_debits: a staff member takes credit OFF an org's balance, with a mandatory
// note and the staff email behind it (migration 0053). The mirror of the staff
// grant, deliberately NOT a negative local_promos row: that ledger feeds the
// welcome remainder, the entitlement, the referral ladder and credited_gifted_cents,
// and a negative gift would reach all of them. Balance composition adds these rows
// to the org's USAGE instead (lib/transfer-usage.ts), so a debit lowers the
// spendable and displayed balance exactly like spend does. Never charges a card.
export const staffDebits = pgTable(
  "staff_debits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    amountCents: numeric("amount_cents", {
      precision: FRACTIONAL_PRECISION,
      scale: FRACTIONAL_SCALE,
    }).notNull(),
    note: text("note").notNull(),
    debitedBy: text("debited_by").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("staff_debits_org_idempotency_key").on(table.orgId, table.idempotencyKey),
    index("idx_staff_debits_org").on(table.orgId),
  ]
);

export type StaffDebit = typeof staffDebits.$inferSelect;

// Dunning eventTypes — byte-equal to the templates registered by the dashboard
// app (distribute.you#1420). LOCKED contract; do not rename.
/**
 * The platform is the actor. Written as `user_id` on a row this service creates
 * with no end user behind it (a scheduler tick, a sweep), and sent as `x-user-id`
 * on a write it genuinely performs itself. Never used to get past a READ gate,
 * and nothing downstream resolves a user from it — recipients are resolved from
 * the org's Stripe billing email.
 */
export const PLATFORM_USER_ID = "00000000-0000-0000-0000-000000000000";

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

// --- SUBSCRIPTION, owned by billing (migration 0056; lib/subscription) ---

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    /** trialing | active | past_due | canceled */
    status: text("status").notNull(),
    monthlyAmountCents: integer("monthly_amount_cents").notNull(),
    trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    creditsUsedNotifiedPeriodStart: timestamp("credits_used_notified_period_start", {
      withTimezone: true,
    }),
    /** The person who started it; the customer emails go to them. */
    startedByUserId: uuid("started_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_subscriptions_org").on(table.orgId)]
);
export type Subscription = typeof subscriptions.$inferSelect;

export const subscriptionCharges = pgTable(
  "subscription_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id").notNull(),
    orgId: uuid("org_id").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** pending | paid | failed */
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    reference: text("reference"),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("subscription_charges_period_unique").on(table.subscriptionId, table.periodStart),
    index("idx_subscription_charges_org").on(table.orgId),
  ]
);
export type SubscriptionCharge = typeof subscriptionCharges.$inferSelect;

export const subscriptionCreditExpiries = pgTable(
  "subscription_credit_expiries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    boundaryAt: timestamp("boundary_at", { withTimezone: true }).notNull(),
    amountCents: numeric("amount_cents", { precision: 16, scale: 10 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("subscription_credit_expiries_org_boundary").on(table.orgId, table.boundaryAt)]
);
