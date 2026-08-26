import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);
export const registry = new OpenAPIRegistry();

// --- Shared ---

export const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse");

/**
 * Outbound balance/amount string with full numeric(16,10) precision.
 * Drizzle returns numeric columns as strings — we pass them through unchanged.
 */
const CentsStringSchema = z.string();
const UsageCentsSchema = CentsStringSchema.openapi({
  description:
    "Platform usage from runs-service, including actualized costs and provisioned holds. Already NET of any per-org usage discount (applied once at cost-write in runs-service). Use with balance_cents for spend authorization.",
});
const SpendableBalanceCentsSchema = CentsStringSchema.openapi({
  description:
    "Spendable funds: credited_cents minus usage_cents. Includes provisioned holds, so this is the safety value for authorization, depletion, runway, and top-up checks.",
});
const ActualBalanceCentsSchema = CentsStringSchema.openapi({
  description:
    "User-facing credit balance: credited funds minus actualized platform usage only. Provisioned holds are not subtracted here because they may later actualize or cancel.",
});

// --- Account ---

export const BillingAccountSchema = z
  .object({
    id: z.string().uuid(),
    org_id: z.string().uuid(),
    /** Lifetime credits added: stripe-service paid topups + sum(local_promos). */
    credited_cents: CentsStringSchema,
    /**
     * Money the org actually PAID: succeeded Stripe payments net of refunds and
     * lost disputes. Ready to render, no browser-side arithmetic.
     */
    credited_paid_cents: CentsStringSchema.openapi({
      description:
        "Money the org actually paid us: SUM of succeeded Stripe payments NET of refunds and lost disputes. Together with credited_gifted_cents this decomposes credited_cents (credited_cents === credited_paid_cents + credited_gifted_cents), so a client can show 'credit paid' vs 'credits gifted' without computing money.",
    }),
    /** Credits GIFTED to the org: SUM(local_promos) — welcome, welcome-completion, matches, invite + staff grants, redeemed promos. */
    credited_gifted_cents: CentsStringSchema.openapi({
      description:
        "Credits we gave the org: SUM(local_promos) — signup welcome gift, welcome-completion gift, first-load match, invite grants, staff grants and redeemed promo codes. The other half of credited_cents alongside credited_paid_cents.",
    }),
    /** Lifetime platform usage from runs-service /internal/org-usage-total. */
    usage_cents: UsageCentsSchema,
    /** Spendable funds = credited_cents − usage_cents. Use this for depletion/budget gates. */
    balance_cents: SpendableBalanceCentsSchema,
    /** User-facing balance = credited_cents − actualized usage only. */
    actual_balance_cents: ActualBalanceCentsSchema,
    /**
     * Per-org platform-usage discount percentage (0–100), or null when none.
     * EXPOSED for the customer dashboard banner only — it does NOT affect the
     * balance figures. The discount is applied ONCE, at cost-write time, inside
     * runs-service, so usage_cents (and thus balance_cents/actual_balance_cents) is
     * already net. Billing never re-applies it.
     */
    usage_discount_pct: z.number().int().nullable(),
    topup_amount_cents: z.number().int().nullable(),
    topup_threshold_cents: z.number().int().nullable(),
    has_payment_method: z.boolean(),
    has_auto_topup: z.boolean(),
    /**
     * False when the saved card's issuing country can't be charged off_session (e.g.
     * India / RBI e-mandate). The dashboard hides/disables the auto-reload section and
     * shows a notice when false. has_auto_topup is also false in that case (a stored
     * config would never fire). See issue #220.
     */
    auto_reload_supported: z.boolean(),
    /** Machine reason when auto_reload_supported is false; null otherwise. */
    auto_reload_unsupported_reason: z.string().nullable(),
    /** ISO-3166-1 alpha-2 issuing country of the card the reload would charge; null when no card PM. */
    card_country: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("BillingAccount");

// --- Authorize ---

export const AuthorizeCostItemSchema = z
  .object({
    costName: z.string().min(1),
    quantity: z.number().int().positive(),
  })
  .openapi("AuthorizeCostItem");

export const AuthorizeRequestSchema = z
  .object({
    items: z.array(AuthorizeCostItemSchema).min(1),
    description: z.string().optional(),
  })
  .openapi("AuthorizeRequest");

export const AuthorizeResponseSchema = z
  .object({
    sufficient: z.boolean(),
    balance_cents: CentsStringSchema,
    required_cents: CentsStringSchema,
  })
  .openapi("AuthorizeResponse");

// --- Usage Apply ---

export const UsageApplyRequestSchema = z
  .object({
    spent_total_cents: CentsStringSchema,
  })
  .openapi("UsageApplyRequest");

export const UsageApplyResponseSchema = z
  .object({
    acknowledged: z.boolean(),
    topup_triggered: z.boolean(),
  })
  .openapi("UsageApplyResponse");

// --- Auto-Topup ---

export const UpdateAutoTopupRequestSchema = z
  .object({
    topup_amount_cents: z.number().int().positive(),
    topup_threshold_cents: z.number().int().min(0),
  })
  .openapi("UpdateAutoTopupRequest");

// --- Checkout ---

export const CreateCheckoutRequestSchema = z
  .object({
    /**
     * Checkout UI flavor.
     * Absent → HOSTED redirect Checkout (default; requires success_url + cancel_url,
     * returns a `url` the dashboard redirects to).
     * "embedded" → Stripe Embedded Checkout mounted in an in-app modal (no redirect;
     * success_url/cancel_url are not required, returns a `client_secret`). Embedded is
     * payment-only: it always charges topup_amount_cents as a one-shot top-up.
     */
    ui_mode: z.literal("embedded").optional(),
    /** Required for HOSTED checkout; not required (and ignored) in embedded mode. */
    success_url: z.string().url().optional(),
    cancel_url: z.string().url().optional(),
    /**
     * Checkout flavor (hosted only). Absent or "payment" → one-shot top-up checkout.
     * "setup" → no-charge Stripe Checkout that saves a reusable off-session card so
     * the org can enable auto-topup without buying credits.
     */
    mode: z.enum(["payment", "setup"]).optional(),
    /**
     * Required for payment-mode and for embedded mode (validated in the route — fail
     * loud with 400 when absent). Omitted for hosted setup-mode (no charge).
     */
    topup_amount_cents: z.number().int().positive().optional(),
  })
  .refine(
    (data) => data.ui_mode === "embedded" || (!!data.success_url && !!data.cancel_url),
    {
      message: "success_url and cancel_url are required for hosted checkout",
      path: ["success_url"],
    }
  )
  .openapi("CreateCheckoutRequest");

export const CheckoutResponseSchema = z
  .object({
    /** Present for HOSTED checkout (the redirect URL); absent in embedded mode. */
    url: z.string().optional(),
    /** Present for EMBEDDED checkout (mounted in the in-app modal iframe); absent for hosted. */
    client_secret: z.string().optional(),
    session_id: z.string(),
  })
  .openapi("CheckoutResponse");

// --- Portal Sessions ---

export const CreatePortalSessionRequestSchema = z
  .object({
    return_url: z.string().url(),
  })
  .openapi("CreatePortalSessionRequest");

export const PortalSessionResponseSchema = z
  .object({
    url: z.string(),
  })
  .openapi("PortalSessionResponse");

// --- Balance ---

export const BalanceResponseSchema = z
  .object({
    balance_cents: SpendableBalanceCentsSchema,
    actual_balance_cents: ActualBalanceCentsSchema,
    depleted: z.boolean(),
  })
  .openapi("BalanceResponse");

// --- Promotion Codes ---

export const RedeemPromotionCodeRequestSchema = z
  .object({
    code: z.string().min(1),
  })
  .openapi("RedeemPromotionCodeRequest");

export const RedeemPromotionCodeResponseSchema = z
  .object({
    redeemed: z.boolean(),
    /** Positive grant amount (welcome gift or promo credit). */
    amount_cents: CentsStringSchema,
    /** Lifetime sum of all local promo credits for this org after redemption. */
    local_credits_total_cents: CentsStringSchema,
  })
  .openapi("RedeemPromotionCodeResponse");

// --- Internal Credit Grant (DIS-64 platform-issued grants) ---

export const CreditGrantRequestSchema = z
  .object({
    orgId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    reason: z.enum(["invite_reward", "invite_welcome"]),
  })
  .openapi("CreditGrantRequest");

export const CreditGrantResponseSchema = z
  .object({
    ok: z.literal(true),
    /** Spendable funds after the grant (credited_cents − usage_cents). */
    newBalanceCents: CentsStringSchema,
  })
  .openapi("CreditGrantResponse");

// --- Admin credit grants (staff oversight ledger, stacking arbitrary amount) ---

export const AdminCreditGrantRequestSchema = z
  .object({
    /** Arbitrary positive grant amount, integer cents. */
    amountCents: z.number().int().positive(),
    /** Optional staff note, stored on the grant row. */
    note: z.string().optional(),
    /**
     * Caller-supplied stacking key. A fresh key per grant STACKS; the same key
     * retried never double-grants. Required — no silent default.
     */
    idempotencyKey: z.string().min(1),
  })
  .openapi("AdminCreditGrantRequest");

export const AdminCreditGrantResponseSchema = z
  .object({
    ok: z.literal(true),
    /** Spendable funds after the grant (credited_cents − usage_cents). */
    newBalanceCents: CentsStringSchema,
  })
  .openapi("AdminCreditGrantResponse");

export const CreditGrantItemSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    /** Grant amount, decimal string (numeric(16,10)). */
    amountCents: CentsStringSchema,
    /** Promo CODE behind the grant (admin_grant, invite_*, welcome, …). */
    reason: z.string(),
    /** Staff note / grant description; null when none. */
    note: z.string().nullable(),
    /** Staff email behind an admin_grant; null for non-admin grants. */
    grantedBy: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("CreditGrantItem");

export const CreditGrantsListResponseSchema = z
  .object({
    grants: z.array(CreditGrantItemSchema),
  })
  .openapi("CreditGrantsListResponse");

// --- Per-org usage discount (staff-managed, single replaceable value) ---

export const SetUsageDiscountRequestSchema = z
  .object({
    /**
     * Platform-usage discount percentage, integer 0–100. Out-of-range is
     * rejected (400) — no silent clamp, no default. The org then pays
     * (1 − discountPct/100) of its gross usage. The discount is applied ONCE, at
     * cost-write time, inside runs-service (which reads this value); billing only
     * stores + serves it and never re-applies it at balance composition.
     */
    discountPct: z.number().int().min(0).max(100),
  })
  .openapi("SetUsageDiscountRequest");

export const InternalUsageDiscountSchema = z
  .object({
    orgId: z.string().uuid(),
    /**
     * Current discount percentage (0–100). A known org with NO discount returns 0
     * (NOT null, NOT 404) so a non-discounted org resolves to "0% off" = no change.
     * Field name + zero-not-null semantics match the deployed features-service
     * reader (PR #510 billing-discount-client.ts).
     */
    discount_percent: z.number().int().min(0).max(100),
  })
  .openapi("InternalUsageDiscount");

export const UsageDiscountResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    /** Current discount percentage (0–100); null when no discount is set. */
    discountPct: z.number().int().nullable(),
    /** Staff email that set the discount; null when unset or none recorded. */
    setBy: z.string().nullable(),
    /** ISO-8601 timestamp the discount was last set; null when unset. */
    setAt: z.string().nullable(),
  })
  .openapi("UsageDiscountResponse");

// --- Internal account teardown (client-service org cascade delete) ---

export const InternalAccountTeardownDeletedRowsSchema = z
  .object({
    billingAccounts: z.number().int(),
    localPromos: z.number().int(),
    creditDepletionEpisodes: z.number().int(),
    campaignAuthorizeCosts: z.number().int(),
    brandDailyBudgets: z.number().int(),
    brandFunnelDailyBudgets: z.number().int(),
    welcomeCreditClaims: z.number().int(),
    freeCreditPromises: z.number().int(),
  })
  .openapi("InternalAccountTeardownDeletedRows");

export const InternalAccountTeardownResponseSchema = z
  .object({
    ok: z.literal(true),
    orgId: z.string().uuid(),
    deletedRows: InternalAccountTeardownDeletedRowsSchema,
  })
  .openapi("InternalAccountTeardownResponse");

// --- Free-credit promises (stacked welcome + referral offers, migration 0033) ---

export const ReferralClaimRequestSchema = z
  .object({
    /** The org that signed up through the invite link (the invitee). */
    orgId: z.string().uuid(),
    /** The org whose invite link they used (the inviter). */
    referrerOrgId: z.string().uuid(),
  })
  .openapi("ReferralClaimRequest");

export const FreeCreditPromiseSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    /** 'welcome' (the signup offer) | 'referral' (the invite offer). */
    kind: z.string(),
    /** What lands when it unlocks; frozen at creation, integer cents. */
    amountCents: z.number().int(),
    /** Cumulative succeeded payments (net of returns) that unlock it; frozen. */
    paidTriggerCents: z.number().int(),
    /** On our own referral promise: the org that referred us. */
    referrerOrgId: z.string().uuid().nullable(),
    /** On an inviter's promise: the referred org whose conversion caused it. */
    referredOrgId: z.string().uuid().nullable(),
    /** ISO-8601 instant the promise was granted; null while outstanding. */
    grantedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("FreeCreditPromise");

export const ReferralClaimResponseSchema = z
  .object({
    ok: z.literal(true),
    /** True when this invite had already been claimed (no second promise opened). */
    alreadyClaimed: z.boolean(),
    promise: FreeCreditPromiseSchema,
  })
  .openapi("ReferralClaimResponse");

export const OutstandingFreeCreditPromiseSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    /**
     * What would actually land if it unlocked right now. For a welcome promise that
     * is its frozen entitlement MINUS the free credit already gifted (the $5 signup
     * gift, staff grants, redeemed codes) — referral rewards excluded, since they
     * stack with the welcome offer rather than replacing it.
     */
    amount_cents: CentsStringSchema,
    /** The bar: cumulative succeeded payments, net of returns, that unlock it. */
    paid_trigger_cents: CentsStringSchema,
    /** Progress toward the bar, capped at it. */
    paid_so_far_cents: CentsStringSchema,
    /** Bar minus progress. */
    remaining_to_unlock_cents: CentsStringSchema,
    /** Progress as an integer percentage, 0–100. */
    progress_pct: z.number().int(),
    /** The referred org whose conversion caused this promise; null otherwise. */
    referred_org_id: z.string().uuid().nullable(),
    /**
     * Display name of that referred org, so an inviter holding three pending $500s
     * can tell WHICH referral earned each one. billing resolves it through
     * brand-service: it is the only service that knows the referral relationship
     * exists, and that relationship is what authorizes revealing the other org's
     * identity at all. Only the name and the domain are revealed — never anything
     * about that org's spend, campaigns, credits or performance.
     *
     * Absent on a promise with no referred org, and null whenever the lookup
     * resolved nothing real (org has no brand, brand-service unreachable). NEVER
     * fabricated from the UUID: a placeholder name is worse than no name, and the
     * promise is always returned with its amounts intact regardless.
     */
    referred_org_name: z.string().nullable().optional(),
    /**
     * Normalized domain of that org — what the dashboard turns into a logo. Same
     * absent/null/never-fabricated rules as the name.
     */
    referred_org_domain: z.string().nullable().optional(),
    /**
     * The org that referred us, on our own referral promise; null otherwise. Left
     * bare on purpose: the invitee reached us through that org's own invite link, so
     * they already know who it was, and they hold exactly one referral promise —
     * nothing to disambiguate. Revealing less is the default.
     */
    referrer_org_id: z.string().uuid().nullable(),
    created_at: z.string(),
  })
  .openapi("OutstandingFreeCreditPromise");

export const FreeCreditPromisesResponseSchema = z
  .object({
    org_id: z.string().uuid(),
    /** Cumulative succeeded payments, net of refunds + lost disputes. */
    paid_topups_cents: CentsStringSchema,
    /**
     * TOTAL free credit still outstanding across every promise below — the
     * headline the dashboard sidebar states. Summed from those very rows, in the
     * same units and on the same basis, so the two can never disagree; a consumer
     * never adds money up itself. "0.0000000000" when nothing is outstanding.
     *
     * Still NOT spendable money: it enters neither credited, balance nor
     * spendable, exactly like the rows it sums.
     */
    outstanding_total_cents: CentsStringSchema,
    /**
     * Promises still outstanding, cheapest bar first. An outstanding promise is a
     * promise, not money: it is NOT part of credited / balance / spendable anywhere.
     */
    promises: z.array(OutstandingFreeCreditPromiseSchema),
  })
  .openapi("FreeCreditPromisesResponse");

// --- Internal Promo-code config (re-price welcome / admin codes, no migration) ---

export const PromoCodeSchema = z
  .object({
    code: z.string(),
    /** Current grant amount (integer cents) read at redeem time. */
    amount_cents: z.number().int(),
  })
  .openapi("PromoCode");

export const UpdatePromoCodeRequestSchema = z
  .object({
    amountCents: z.number().int().nonnegative(),
  })
  .openapi("UpdatePromoCodeRequest");

// --- Transfer Brand ---

export const TransferBrandRequestSchema = z
  .object({
    sourceBrandId: z.string().uuid(),
    sourceOrgId: z.string().uuid(),
    targetOrgId: z.string().uuid(),
    targetBrandId: z.string().uuid().optional(),
  })
  .openapi("TransferBrandRequest");

export const TransferBrandTableResultSchema = z
  .object({
    tableName: z.string(),
    count: z.number().int(),
  })
  .openapi("TransferBrandTableResult");

export const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(TransferBrandTableResultSchema),
  })
  .openapi("TransferBrandResponse");

// --- Dunning tick (out-of-credit engine, issue #147) ---

export const DunningTickResponseSchema = z
  .object({
    processed: z.number().int(),
    recovered: z.number().int(),
    followup3dSent: z.number().int(),
    followup10dSent: z.number().int(),
  })
  .openapi("DunningTickResponse");

// --- Campaign affordability (read-only pre-flight gate) ---

export const CampaignAffordabilitySchema = z
  .object({
    /** true when hasHistory=false (first-run default) OR balance >= lastRequired. */
    affordable: z.boolean(),
    /** Live balance (credited − usage), decimal string. "0" when hasHistory=false. */
    balanceCents: CentsStringSchema,
    /** Stored required_cents of the last authorize for this campaign; null if none. */
    lastRequiredCents: CentsStringSchema.nullable(),
    /** false when no authorize was ever recorded for this campaign. */
    hasHistory: z.boolean(),
  })
  .openapi("CampaignAffordability");

// --- Brand daily budget (per-brand spend ceiling / pacing) ---

export const SetBrandDailyBudgetRequestSchema = z
  .object({
    /**
     * The per-day spend ceiling for this brand, in cents. Non-negative
     * (0 = explicit pause). Accepts a number or decimal string; stored at
     * numeric(16,10) precision.
     */
    dailyBudgetCents: z.union([z.string(), z.number()]),
  })
  .openapi("SetBrandDailyBudgetRequest");

export const BrandDailyBudgetSchema = z
  .object({
    brandId: z.string().uuid(),
    orgId: z.string().uuid(),
    /** Current daily spend ceiling, decimal string (numeric(16,10)). */
    dailyBudgetCents: CentsStringSchema,
    updatedAt: z.string(),
  })
  .openapi("BrandDailyBudget");

export const ReadBrandDailyBudgetSchema = z
  .object({
    brandId: z.string().uuid(),
    /** Current daily spend ceiling; null when no budget has been set. */
    dailyBudgetCents: CentsStringSchema.nullable(),
    /** Last-set timestamp; null when no budget has been set. */
    updatedAt: z.string().nullable(),
  })
  .openapi("ReadBrandDailyBudget");

export const BrandDailyBudgetChangeSchema = z
  .object({
    /** The value the daily budget BECAME at this point in time. */
    dailyBudgetCents: CentsStringSchema,
    /** When the budget was changed to this value (ISO 8601). */
    changedAt: z.string(),
  })
  .openapi("BrandDailyBudgetChange");

export const ReadBrandDailyBudgetHistorySchema = z
  .object({
    brandId: z.string().uuid(),
    /**
     * Ordered daily-budget change history, oldest first (chronological
     * timeline). Empty when no budget has been set for this org+brand since the
     * feature shipped (forward-only — no fabricated backfill).
     */
    history: z.array(BrandDailyBudgetChangeSchema),
  })
  .openapi("ReadBrandDailyBudgetHistory");

// --- Per-funnel daily ceilings (the brand budget, split by sales funnel) ---

export const BrandFunnelKeySchema = z
  .enum(["reply_meeting", "visit_meeting", "visit_signup", "visit_form"])
  .openapi("BrandFunnelKey");

export const SetBrandFunnelDailyBudgetRequestSchema = z
  .object({
    /**
     * This funnel's per-day spend ceiling, in cents. Non-negative. 0 means "not
     * funding this funnel right now" and is always accepted; a FUNDED funnel
     * below its product minimum is refused with a readable reason.
     */
    dailyBudgetCents: z.union([z.string(), z.number()]),
    /**
     * The ACQUISITION CHANNEL being funded, as a features-service feature slug.
     * Optional: omitted, the write addresses the funnel as a whole — its single
     * channel when it funds one, the default channel when it funds none, and a
     * 409 when it is split across several.
     */
    featureSlug: z.string().min(1).optional(),
    /**
     * The OFFER being funded, a brand-service offer UUID. Optional: omitted, the
     * write addresses the (funnel, channel) pair as a whole - its single offer
     * when it funds one (the UNSCOPED ceiling, for everything written before
     * offers existed), an unscoped ceiling when it funds none, and a 409 when it
     * is split across several.
     */
    offerId: z.string().uuid().optional(),
  })
  .openapi("SetBrandFunnelDailyBudgetRequest");

export const SetBrandFunnelDailyBudgetSetRequestSchema = z
  .object({
    /**
     * The whole set, written atomically. Funnels absent from this list are
     * removed. A set whose ceilings are ALL zero is accepted (a brand in pause).
     */
    funnels: z
      .array(
        z.object({
          funnelKey: z.string(),
          /** The acquisition-channel feature slug — optional, see the PATCH. */
          featureSlug: z.string().min(1).optional(),
          /** The offer UUID - optional, see the PATCH. */
          offerId: z.string().uuid().optional(),
          dailyBudgetCents: z.union([z.string(), z.number()]),
        })
      )
      .min(1, "funnels must contain at least one funnel"),
  })
  .openapi("SetBrandFunnelDailyBudgetSetRequest");

export const BrandFunnelDailyBudgetSchema = z
  .object({
    funnelKey: BrandFunnelKeySchema,
    /**
     * This funnel's daily ceiling — the SUM of the acquisition channels funding
     * it. Decimal string (numeric(16,10)). Unchanged in meaning for every
     * consumer: a brand that has never split a funnel renders exactly as before.
     */
    dailyBudgetCents: CentsStringSchema,
    updatedAt: z.string(),
  })
  .openapi("BrandFunnelDailyBudget");

export const BrandFunnelChannelDailyBudgetSchema = z
  .object({
    funnelKey: BrandFunnelKeySchema,
    /**
     * The ACQUISITION CHANNEL this ceiling funds, as a features-service feature
     * slug. A channel IS a feature slug — there is no separate channel concept.
     */
    featureSlug: z.string(),
    /** This (funnel, channel) pair's own daily ceiling. */
    dailyBudgetCents: CentsStringSchema,
    updatedAt: z.string(),
  })
  .openapi("BrandFunnelChannelDailyBudget");

export const BrandFunnelOfferDailyBudgetSchema = z
  .object({
    funnelKey: BrandFunnelKeySchema,
    featureSlug: z.string(),
    /**
     * The OFFER this ceiling funds, a brand-service offer UUID. `null` means the
     * ceiling is not scoped to an offer - every ceiling written before offers
     * existed carries it, and it is a permanent value rather than a placeholder.
     */
    offerId: z.string().uuid().nullable(),
    /** This (funnel, channel, offer) ceiling, i.e. this campaign's own. */
    dailyBudgetCents: CentsStringSchema,
    updatedAt: z.string(),
  })
  .openapi("BrandFunnelOfferDailyBudget");

export const ReadBrandFunnelDailyBudgetsSchema = z
  .object({
    brandId: z.string().uuid(),
    /**
     * The brand-level daily budget — the SUM of the ceilings below when the
     * brand is funnel-funded, otherwise its brand-level scalar (null when never
     * set). Byte-identical to what GET /internal/brands/{brandId}/daily-budget
     * serves, so the two surfaces can never disagree.
     */
    dailyBudgetCents: CentsStringSchema.nullable(),
    /** Per-funnel ceilings; empty when this brand has never set any. */
    funnels: z.array(BrandFunnelDailyBudgetSchema),
    /**
     * ADDITIVE, finer grain: one entry per (funnel, acquisition-channel feature).
     * `funnels` above is its per-funnel sum, so a consumer that wants the funnel
     * figure never has to add these up. Empty when this brand has never set any.
     */
    channels: z.array(BrandFunnelChannelDailyBudgetSchema),
    /**
     * ADDITIVE, the STORED grain: one entry per (funnel, acquisition-channel
     * feature, offer), i.e. one per campaign. `channels` above is its per-pair
     * sum, so a consumer that wants the channel figure never has to add these
     * up. Empty when this brand has never set any.
     */
    offers: z.array(BrandFunnelOfferDailyBudgetSchema),
  })
  .openapi("ReadBrandFunnelDailyBudgets");

export const ReadBrandOfferDailyBudgetSchema = z
  .object({
    brandId: z.string().uuid(),
    /** Present on the user-facing read only. */
    orgId: z.string().uuid().optional(),
    offerId: z.string().uuid(),
    /**
     * This OFFER's daily ceiling — the SUM of the ceilings funding it, across
     * every funnel and acquisition channel it is sold through. `null` when this
     * offer has NO ceiling, which is a different answer from a ceiling of 0
     * (funded at nothing) and is never derived from it.
     */
    dailyBudgetCents: CentsStringSchema.nullable(),
    /** The latest of the ceilings funding this offer; null when it has none. */
    updatedAt: z.string().nullable(),
    /** This offer's per-funnel figures — the sums above, restricted to it. */
    funnels: z.array(BrandFunnelDailyBudgetSchema),
    /** This offer's per-(funnel, channel) figures, same restriction. */
    channels: z.array(BrandFunnelChannelDailyBudgetSchema),
  })
  .openapi("ReadBrandOfferDailyBudget");

export const BrandFunnelDailyBudgetsSchema = z
  .object({
    brandId: z.string().uuid(),
    orgId: z.string().uuid(),
    /** The brand-level daily budget after this write = the sum of the ceilings. */
    dailyBudgetCents: CentsStringSchema,
    funnels: z.array(BrandFunnelDailyBudgetSchema),
    /** ADDITIVE: one entry per (funnel, acquisition-channel feature). */
    channels: z.array(BrandFunnelChannelDailyBudgetSchema),
    /**
     * ADDITIVE, the STORED grain: one entry per (funnel, acquisition-channel
     * feature, offer), i.e. one per campaign. `channels` above is its per-pair
     * sum, so a consumer that wants the channel figure never has to add these
     * up. Empty when this brand has never set any.
     */
    offers: z.array(BrandFunnelOfferDailyBudgetSchema),
  })
  .openapi("BrandFunnelDailyBudgets");

// --- Public Stats ---

export const BillingGrowthRowSchema = z
  .object({
    period: z.string(),
    /** NET Stripe payments in this period + local promo credits granted in it. */
    credited_cents: CentsStringSchema,
    /** NET Stripe payments in this period. Returns are attributed to the period they happened in. */
    revenue_cents: CentsStringSchema,
  })
  .openapi("BillingGrowthRow");

export const PublicBillingStatsSchema = z
  .object({
    total_accounts: z.number().int(),
    accounts_with_payment_method: z.number().int(),
    /** Lifetime NET Stripe payments + local credits (combined). */
    total_credited_cents: CentsStringSchema,
    /** Lifetime GROSS stripe-service payments, before anything was given back. */
    total_paid_cents: CentsStringSchema,
    /**
     * Cumulative all-time Stripe revenue, top-level alias for investor/landing-page consumers.
     * NET of money returned: `total_paid_cents − total_returned_cents`. Money we refunded is
     * not revenue we earned, and this figure feeds the investor metrics page. Read
     * `total_paid_cents` for the gross charges.
     */
    total_revenue_cents: CentsStringSchema,
    /**
     * Lifetime money given back across the platform: settled refunds plus LOST disputes.
     * A pending refund, a refund that later failed or was cancelled, and an open or won
     * dispute are all excluded — only money that actually left counts.
     */
    total_returned_cents: CentsStringSchema,
    /** Lifetime local promo credits only. */
    total_local_credits_cents: CentsStringSchema,
    monthly_growth: z.array(BillingGrowthRowSchema),
    weekly_growth: z.array(BillingGrowthRowSchema),
  })
  .openapi("PublicBillingStats");

// --- OpenAPI Path Registrations ---

const protectedHeaders = z.object({
  "x-api-key": z.string(),
  "x-org-id": z.string().uuid(),
  "x-user-id": z.string().uuid(),
  "x-run-id": z.string().uuid(),
  "x-campaign-id": z.string().optional().openapi({ description: "Campaign ID injected by workflow-service" }),
  "x-brand-id": z.string().optional().openapi({ description: "Brand ID(s) injected by workflow-service (comma-separated UUIDs for multi-brand campaigns)", example: "uuid1,uuid2,uuid3" }),
  "x-workflow-slug": z.string().optional().openapi({ description: "Workflow slug injected by workflow-service" }),
  "x-feature-slug": z.string().optional().openapi({ description: "Feature slug for tracking" }),
  "x-audience-id": z.string().optional().openapi({ description: "Audience ID injected by campaign-service for per-audience cost attribution" }),
});

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.string(),
            service: z.string(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/public/stats/billing",
  summary: "Aggregate billing stats (no auth)",
  description:
    "Cross-tenant aggregate billing statistics composed from stripe-service (paid balance) and local promo credits.",
  responses: {
    200: {
      description: "Billing stats",
      content: {
        "application/json": { schema: PublicBillingStatsSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/accounts",
  summary: "Get or create billing account for org",
  request: {
    headers: protectedHeaders,
  },
  responses: {
    200: {
      description: "Billing account",
      content: { "application/json": { schema: BillingAccountSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "stripe-service or runs-service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/accounts/balance",
  summary: "Quick balance check (spendable funds)",
  request: {
    headers: protectedHeaders,
  },
  responses: {
    200: {
      description: "Balance info",
      content: { "application/json": { schema: BalanceResponseSchema } },
    },
    404: {
      description: "Billing account not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/accounts/auto_topup",
  summary: "Configure auto-topup settings (requires payment method via stripe-service)",
  request: {
    headers: protectedHeaders,
    body: {
      content: { "application/json": { schema: UpdateAutoTopupRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated account",
      content: { "application/json": { schema: BillingAccountSchema } },
    },
    400: {
      description: "Payment method required or invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Billing account not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/accounts/auto_topup",
  summary: "Disable auto-topup",
  request: {
    headers: protectedHeaders,
  },
  responses: {
    200: {
      description: "Updated account with auto-topup disabled",
      content: { "application/json": { schema: BillingAccountSchema } },
    },
    404: {
      description: "Billing account not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/portal-sessions",
  summary: "Create Stripe Customer Portal session via stripe-service",
  request: {
    headers: protectedHeaders,
    body: {
      content: {
        "application/json": { schema: CreatePortalSessionRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Portal session URL",
      content: { "application/json": { schema: PortalSessionResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Billing account not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "stripe-service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/checkout-sessions",
  summary: "Create Stripe Checkout session via stripe-service",
  description:
    "Auto-creates the billing account with welcome promo if the org has no account yet, then proxies to stripe-service. " +
    "HOSTED (default, no ui_mode): requires success_url + cancel_url and returns a redirect `url`. " +
    "mode='payment' (default) charges topup_amount_cents as a one-shot top-up and does not configure auto-topup. " +
    "mode='setup' creates a no-charge Checkout that saves a reusable off-session card (for enabling auto-topup); topup_amount_cents is omitted and no topup amount is written. " +
    "EMBEDDED (ui_mode='embedded'): Stripe Embedded Checkout for an in-app modal — no success_url/cancel_url, returns a `client_secret` the front-end mounts in an iframe; always charges topup_amount_cents (payment-only). " +
    "Credit + first-load match land via the existing checkout.session.completed webhook in all modes. " +
    "FREE CREDITS: payment-mode checkouts carry the '$25 in free credits' offer. On an org's FIRST-EVER payment of at least $50 the whole $25 is advanced as a visible pre-applied Stripe discount (buyer pays $50 minus $25, and the credit that lands is still the full $50). Otherwise the page shows a notice that the remainder arrives once cumulative payments reach $25. " +
    "User-entered promotion codes are NOT offered (allow_promotion_codes is never set) — they are mutually exclusive with the pre-applied discount.",
  request: {
    headers: protectedHeaders,
    body: {
      content: {
        "application/json": { schema: CreateCheckoutRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Checkout session URL",
      content: { "application/json": { schema: CheckoutResponseSchema } },
    },
    502: {
      description: "stripe-service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/customer_balance/authorize",
  summary: "Synchronous pre-execution authorization with auto-topup",
  description: "Resolves prices from costs-service, fetches usage from runs-service, fetches paid balance from stripe-service, and composes with local promo credits. " +
    "If insufficient and auto-topup is configured, calls stripe-service reload (synchronous, with per-org coalescing).",
  request: {
    headers: protectedHeaders,
    body: {
      content: { "application/json": { schema: AuthorizeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Authorization result",
      content: { "application/json": { schema: AuthorizeResponseSchema } },
    },
    502: {
      description: "Downstream service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/customer_balance/usage_apply",
  summary: "Notify billing of an org's current usage total (hint for proactive topup)",
  description:
    "Fire-and-forget endpoint called by runs-service after every runs_costs write. " +
    "Billing computes balance = stripe paid topups + local credits − usage; if below " +
    "topup_threshold and auto-topup is configured, fires a stripe-service reload. " +
    "Always returns 202.",
  request: {
    headers: protectedHeaders,
    body: {
      content: { "application/json": { schema: UsageApplyRequestSchema } },
    },
  },
  responses: {
    202: {
      description: "Notification acknowledged",
      content: { "application/json": { schema: UsageApplyResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/promotion_codes/redeem",
  summary: "Redeem a promo code for bonus credits (billing-local)",
  description:
    "Validates the promo code, checks it hasn't been redeemed by this org, " +
    "and inserts a `local_promos` row. No Stripe call — credit composes into balance_cents at read time.",
  request: {
    headers: protectedHeaders,
    body: {
      content: { "application/json": { schema: RedeemPromotionCodeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Promo redeemed successfully",
      content: { "application/json": { schema: RedeemPromotionCodeResponseSchema } },
    },
    400: {
      description: "Invalid or expired promo code",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Promo code already redeemed by this org",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const internalHeaders = z.object({
  "x-api-key": z.string(),
});

const internalOrgHeaders = z.object({
  "x-api-key": z.string(),
  "x-org-id": z.string().uuid(),
});

registry.registerPath({
  method: "delete",
  path: "/internal/accounts/by-org/{orgId}",
  summary: "Remove billing-owned state for a deleted org",
  description:
    "Client-service cascade teardown leg for an internal org UUID. Removes only " +
    "billing-service-owned org-scoped rows that can keep active billing effects " +
    "alive: account topup config, local promo credits, dunning episodes, campaign " +
    "affordability estimates, brand daily budgets, and welcome-credit claims. " +
    "No cross-service fan-out. Idempotent: no rows for the org is still success.",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Billing-owned org state removed; all counts may be zero on retry",
      content: {
        "application/json": { schema: InternalAccountTeardownResponseSchema },
      },
    },
    400: {
      description: "orgId is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Database operation failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/credits/grant",
  summary: "Grant platform-issued credit to an org (no user-redeemable code required)",
  description:
    "Inserts a local_promos row for an org under a reserved platform reason. " +
    "Idempotent on (orgId, reason). " +
    "When reason='invite_welcome', the existing $5 welcome row (if any) is deleted " +
    "in the same tx so the invitee ends at the grant amount (not stacked). " +
    "Returns the org's spendable balance after the grant.",
  request: {
    headers: internalHeaders,
    body: {
      content: { "application/json": { schema: CreditGrantRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Grant applied (or already applied — idempotent)",
      content: { "application/json": { schema: CreditGrantResponseSchema } },
    },
    400: {
      description: "Invalid body or unknown reason",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "stripe-service or runs-service unavailable (balance compose failed)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const adminGrantHeaders = z.object({
  "x-api-key": z.string(),
  "x-org-id": z.string().uuid(),
  "x-email": z.string().optional().openapi({
    description: "Staff email behind the grant; recorded as grantedBy.",
  }),
});

registry.registerPath({
  method: "post",
  path: "/v1/credits/grant",
  summary: "Staff grant of an arbitrary credit amount to an org (stacking)",
  description:
    "Inserts a stacking admin_grant local_promos row for x-org-id. Grants STACK — a " +
    "fresh idempotencyKey per call adds another grant; the same key retried never " +
    "double-grants. The note is stored on the row; x-email is recorded as grantedBy. " +
    "Returns the org's spendable balance after the grant.",
  request: {
    headers: adminGrantHeaders,
    body: {
      content: { "application/json": { schema: AdminCreditGrantRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Grant applied (or already applied for this idempotencyKey)",
      content: {
        "application/json": { schema: AdminCreditGrantResponseSchema },
      },
    },
    400: {
      description: "Invalid body or missing/invalid x-org-id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "admin_grant promo code seed missing",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "stripe-service or runs-service unavailable (balance compose failed)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/credits/grants",
  summary: "List this org's credit grants (oversight ledger)",
  description:
    "Returns every credit grant for x-org-id (admin_grant, invite_*, welcome, promo " +
    "redemptions, welcome_completion), newest first. reason is the promo code.",
  request: {
    headers: z.object({
      "x-api-key": z.string(),
      "x-org-id": z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "Org grants",
      content: {
        "application/json": { schema: CreditGrantsListResponseSchema },
      },
    },
    400: {
      description: "Missing or invalid x-org-id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/usage-discount",
  summary: "Read this org's platform-usage discount (staff)",
  description:
    "Returns the current usage-discount percentage for x-org-id, or discountPct=null " +
    "when no discount is set (full pricing). Includes the audit (setBy / setAt). " +
    "Staff-gated on the gateway, mirroring the credit-grant path (x-api-key + x-org-id).",
  request: { headers: adminGrantHeaders },
  responses: {
    200: {
      description: "Current discount (discountPct null when none)",
      content: { "application/json": { schema: UsageDiscountResponseSchema } },
    },
    400: {
      description: "Missing or invalid x-org-id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/v1/usage-discount",
  summary: "Set / replace this org's platform-usage discount (staff)",
  description:
    "Upserts the single usage-discount value for x-org-id (0–100, integer). The org " +
    "then effectively pays (1 − discountPct/100) of its gross platform usage. The " +
    "discount is applied ONCE, at cost-write time, inside runs-service (which reads " +
    "this value via GET /internal/accounts/by-org/{orgId}/usage-discount): each cost " +
    "row is stored net, so the org's balance depletes proportionally slower and " +
    "auto-topups fire proportionally less often. Billing only stores + serves the " +
    "percentage and never re-applies it at balance composition. x-email is recorded " +
    "as setBy. Out-of-range percentages are rejected (400) — no silent clamp.",
  request: {
    headers: adminGrantHeaders,
    body: {
      content: { "application/json": { schema: SetUsageDiscountRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Discount set",
      content: { "application/json": { schema: UsageDiscountResponseSchema } },
    },
    400: {
      description: "Invalid discountPct (must be an integer 0–100) or invalid x-org-id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/usage-discount",
  summary: "Remove this org's platform-usage discount (staff)",
  description:
    "Deletes the usage discount for x-org-id (→ null → full pricing). Restores full " +
    "pricing on the NEXT balance composition (not retroactive). Idempotent: removing " +
    "a non-existent discount still returns 200 with discountPct=null.",
  request: { headers: adminGrantHeaders },
  responses: {
    200: {
      description: "Discount removed (discountPct null)",
      content: { "application/json": { schema: UsageDiscountResponseSchema } },
    },
    400: {
      description: "Missing or invalid x-org-id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/credits/grants",
  summary: "List ALL orgs' credit grants (platform-wide oversight ledger)",
  description:
    "Returns every credit grant across all orgs, newest first. Service-auth only " +
    "(x-api-key); no org scope. reason is the promo code behind each grant.",
  request: {
    headers: internalHeaders,
  },
  responses: {
    200: {
      description: "All grants",
      content: {
        "application/json": { schema: CreditGrantsListResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/promo-codes/{code}",
  summary: "Read a promo code's current grant amount",
  description:
    "Returns the live grant amount for a promo code (e.g. 'welcome'). This is the " +
    "value read at redeem time, so it reflects exactly what a new redemption grants.",
  request: {
    headers: internalHeaders,
    params: z.object({ code: z.string() }),
  },
  responses: {
    200: {
      description: "Promo code amount",
      content: { "application/json": { schema: PromoCodeSchema } },
    },
    404: {
      description: "Promo code not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/internal/promo-codes/{code}",
  summary: "Set a promo code's grant amount (re-price without a migration)",
  description:
    "Updates the grant amount for an admin-managed promo code (e.g. re-price the " +
    "'welcome' gift). Applies to NEW redemptions only — orgs that already redeemed " +
    "keep their existing grant. Lets the dashboard change the welcome amount with no " +
    "migration or deploy. Should be gated to staff on the gateway side.",
  request: {
    headers: internalHeaders,
    params: z.object({ code: z.string() }),
    body: {
      content: { "application/json": { schema: UpdatePromoCodeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated promo code amount",
      content: { "application/json": { schema: PromoCodeSchema } },
    },
    400: {
      description: "Invalid body (amountCents must be a non-negative integer)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Promo code not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/dunning/tick",
  summary: "Run one out-of-credit dunning scheduler pass (ops / manual trigger)",
  description:
    "Processes every open depletion episode: closes those whose balance was restored " +
    "(stop-on-recharge, no email) and sends due +3d / +10d follow-ups. The same pass runs " +
    "automatically on the in-process hourly scheduler; this route is for ops and testing. " +
    "Idempotent — re-running never double-sends a stage.",
  request: {
    headers: internalHeaders,
  },
  responses: {
    200: {
      description: "Tick summary",
      content: { "application/json": { schema: DunningTickResponseSchema } },
    },
    502: {
      description: "Tick failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/campaigns/{campaignId}/affordability",
  summary: "Read-only pre-flight: can this org afford another run of campaign X?",
  description:
    "Answers campaign-service's affordability question WITHOUT charging or reloading. " +
    "Zero side effects — no charge, no reload, no depletion-episode mutation. " +
    "Estimates the next run's cost as the required_cents of the campaign's LAST authorize " +
    "attempt (a campaign re-runs the same workflow → ~constant cost). " +
    "hasHistory=false (no authorize recorded yet) → affordable=true so a brand-new campaign " +
    "can run once to establish its cost. Otherwise affordable = live balance >= lastRequiredCents.",
  request: {
    headers: internalHeaders,
    params: z.object({ campaignId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Affordability verdict",
      content: { "application/json": { schema: CampaignAffordabilitySchema } },
    },
    400: {
      description: "campaignId is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "stripe-service or runs-service unavailable (balance compose failed)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/accounts/by-org/{orgId}/balance",
  summary: "User-less spendable balance for an org (platform/fleet reads)",
  description:
    "Same spendable-balance snapshot as GET /v1/accounts/balance (balance_cents = " +
    "credited − committed usage; actual_balance_cents = credited − actualized usage; " +
    "depleted = balance_cents <= 0), but keyed by the orgId PATH param and callable " +
    "with the service x-api-key ONLY — no x-org-id / x-user-id / x-run-id, no sentinel " +
    "identity. For platform/staff fleet aggregators (accounts audit, send-forecast) that " +
    "have no end-user in context. Pure read: no auto-reload, no depletion mutation. " +
    "404 when the org has no billing account; 502 when stripe-service/runs-service is unreachable.",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Balance info",
      content: { "application/json": { schema: BalanceResponseSchema } },
    },
    400: {
      description: "orgId is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Billing account not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "stripe-service or runs-service unavailable (balance compose failed)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/accounts/by-org/{orgId}/usage-discount",
  summary: "User-less read of an org's platform-usage discount (service-to-service)",
  description:
    "Returns the org's usage-discount percentage keyed by the orgId PATH param, " +
    "callable with the service x-api-key ONLY — no x-org-id / x-user-id, no sentinel. " +
    "Consumed by runs-service (to FREEZE the discount onto each cost row at cost-write, " +
    "the single application point — billing never re-applies it at balance composition) " +
    "and features-service PR #510 (net-priced cost metrics). A known org with NO discount " +
    "returns discount_percent = 0 (NOT null, NOT 404). Shape matches the deployed " +
    "features-service reader.",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Current discount (discountPct null when none)",
      content: { "application/json": { schema: InternalUsageDiscountSchema } },
    },
    400: {
      description: "orgId is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/daily-budget",
  summary: "Read this org's current daily budget for a brand",
  description:
    "Returns the caller org's current daily spend ceiling for this brand, keyed by " +
    "(x-org-id, brandId). Service-to-service read with x-api-key plus x-org-id; " +
    "shared brands can have different budgets in different orgs. A brand with no " +
    "configured budget for this org returns dailyBudgetCents: null (a legitimate " +
    "unset state; the consumer decides how to handle it). " +
    "billing-service only stores + serves this value; enforcement is campaign-service's job.",
  request: {
    headers: internalOrgHeaders,
    params: z.object({ brandId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Brand daily budget (dailyBudgetCents null when unset)",
      content: { "application/json": { schema: ReadBrandDailyBudgetSchema } },
    },
    400: {
      description: "brandId or x-org-id is not a valid UUID, or x-org-id is missing",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/daily-budget/history",
  summary: "Read this org's daily-budget change history for a brand",
  description:
    "Returns the caller org's ordered daily-budget CHANGE history for this brand " +
    "(the timeline of raises / lowers / zeroings), keyed by (x-org-id, brandId). " +
    "Service-to-service read with x-api-key plus x-org-id, same auth as the " +
    "current-value read. Entries are oldest-first (chronological). Forward-only: " +
    "history begins when the feature shipped, so a brand with no writes since then " +
    "returns an empty history array (never a fabricated backfill). " +
    "billing-service only stores + serves this; the current-value read is unchanged.",
  request: {
    headers: internalOrgHeaders,
    params: z.object({ brandId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Ordered daily-budget change history (empty array when none)",
      content: {
        "application/json": { schema: ReadBrandDailyBudgetHistorySchema },
      },
    },
    400: {
      description: "brandId or x-org-id is not a valid UUID, or x-org-id is missing",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/brands/{brandId}/daily-budget",
  summary: "Set / update a brand's daily budget (per-day spend ceiling)",
  description:
    "Sets this org's daily spend ceiling for the brand. One mutable scalar per " +
    "(orgId, brandId), upserted in place — a subsequent org-scoped read reflects " +
    "the latest write. dailyBudgetCents is " +
    "non-negative (0 = explicit pause). This is an allocation / pacing ceiling, a " +
    "SEPARATE concept from org credit balance/affordability (which is unchanged). " +
    "Shared brands can have independent budget rows per org.",
  request: {
    headers: protectedHeaders,
    params: z.object({ brandId: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: SetBrandDailyBudgetRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Updated brand daily budget",
      content: { "application/json": { schema: BrandDailyBudgetSchema } },
    },
    400: {
      description: "Invalid brandId or dailyBudgetCents",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description:
        "This brand is funded per sales funnel, so its daily budget is DERIVED " +
        "(the sum of the per-funnel ceilings). Write the per-funnel routes instead.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/funnel-budgets",
  summary: "Read this org's per-funnel daily ceilings for a brand",
  description:
    "Returns the caller org's per-SALES-FUNNEL daily spend ceilings for this brand " +
    "(brand-service's funnel vocabulary: reply_meeting, visit_meeting, visit_signup, " +
    "visit_form), plus the brand-level total. Service-to-service read with x-api-key " +
    "plus x-org-id. A brand that has never set per-funnel ceilings returns funnels: [] " +
    "and its brand-level value — never a fabricated split. dailyBudgetCents is exactly " +
    "what GET /internal/brands/{brandId}/daily-budget serves, so no consumer needs to " +
    "recompose the sum itself.",
  request: {
    headers: internalOrgHeaders,
    params: z.object({ brandId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Per-funnel ceilings (empty when none set) + brand total",
      content: {
        "application/json": { schema: ReadBrandFunnelDailyBudgetsSchema },
      },
    },
    400: {
      description: "brandId or x-org-id is not a valid UUID, or x-org-id is missing",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/brands/{brandId}/funnel-budgets",
  summary: "Read a brand's per-funnel daily ceilings (user, via the gateway)",
  description:
    "Same view as the internal read, for the user's own org — brand Settings reads " +
    "its ceilings back. A brand with no per-funnel ceilings returns funnels: [] and " +
    "its brand-level value.",
  request: {
    headers: protectedHeaders,
    params: z.object({ brandId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Per-funnel ceilings (empty when none set) + brand total",
      content: {
        "application/json": { schema: ReadBrandFunnelDailyBudgetsSchema },
      },
    },
    400: {
      description: "Invalid brandId or missing org headers",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/offers/{offerId}/daily-budget",
  summary: "Read ONE offer's daily ceiling for a brand",
  description:
    "Returns what the caller org has funded ONE offer at — the SUM of the ceilings " +
    "covering it across every sales funnel and acquisition channel it is sold " +
    "through — plus that offer's own per-funnel and per-(funnel, channel) figures, " +
    "so a caller never enumerates the offer's channels nor adds anything up. " +
    "An offer-scoped screen paces spend against THIS number: the brand-wide total " +
    "is about a different thing the moment a brand states a second offer. " +
    "A ceiling written before offers existed (offerId null) counts towards this " +
    "offer only while it is the brand's SOLE named one, which is why an offer that " +
    "is a brand's only one answers exactly the brand-wide total. " +
    "An offer with NO ceiling returns dailyBudgetCents: null — a different answer " +
    "from a ceiling of 0, and never derived from it. Service-to-service read with " +
    "x-api-key plus x-org-id.",
  request: {
    headers: internalOrgHeaders,
    params: z.object({
      brandId: z.string().uuid(),
      offerId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "This offer's ceiling (null when it has none) + its breakdown",
      content: {
        "application/json": { schema: ReadBrandOfferDailyBudgetSchema },
      },
    },
    400: {
      description:
        "brandId, offerId or x-org-id is not a valid UUID, or x-org-id is missing",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/brands/{brandId}/offers/{offerId}/daily-budget",
  summary: "Read one offer's daily ceiling (user, via the gateway)",
  description:
    "Same answer as the internal read, for the user's own org — an offer screen " +
    "reads the ceiling it paces its spend against. An offer with no ceiling " +
    "returns dailyBudgetCents: null.",
  request: {
    headers: protectedHeaders,
    params: z.object({
      brandId: z.string().uuid(),
      offerId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "This offer's ceiling (null when it has none) + its breakdown",
      content: {
        "application/json": { schema: ReadBrandOfferDailyBudgetSchema },
      },
    },
    400: {
      description: "Invalid brandId or offerId, or missing org headers",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/v1/brands/{brandId}/funnel-budgets",
  summary: "Set a brand's WHOLE per-funnel ceiling set at once (atomic)",
  description:
    "Writes every per-funnel daily ceiling for this org+brand in ONE transaction — " +
    "signup checkout uses this. Funnels absent from the body are removed. A rejected " +
    "set leaves nothing half-applied. A ceiling of 0 means 'not funding that funnel " +
    "right now' and is accepted, INCLUDING a set where every funnel is 0 (a brand in " +
    "pause). A FUNDED funnel below its product minimum is refused with a readable " +
    "reason: $1/day for visit_signup and visit_form, $24/day for reply_meeting and " +
    "visit_meeting. Once ceilings exist, the brand's daily budget is their SUM and the " +
    "brand-level write is refused (409).",
  request: {
    headers: protectedHeaders,
    params: z.object({ brandId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: SetBrandFunnelDailyBudgetSetRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Stored ceilings + the resulting brand-level total",
      content: {
        "application/json": { schema: BrandFunnelDailyBudgetsSchema },
      },
    },
    400: {
      description:
        "Invalid brandId, unknown or duplicated funnel key, or a funded funnel below its minimum",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description:
        "An entry named no acquisition channel for a funnel that is funded through several",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/brands/{brandId}/funnel-budgets/{funnelKey}",
  summary: "Set ONE funnel's daily ceiling for a brand",
  description:
    "Sets a single sales funnel's daily spend ceiling — brand Settings changes them " +
    "one at a time. Untouched funnels keep their ceiling. Same rules as the whole-set " +
    "write: 0 is legal (not funding that funnel), a funded funnel below its product " +
    "minimum is refused with a readable reason.",
  request: {
    headers: protectedHeaders,
    params: z.object({
      brandId: z.string().uuid(),
      funnelKey: BrandFunnelKeySchema,
    }),
    body: {
      content: {
        "application/json": {
          schema: SetBrandFunnelDailyBudgetRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Stored ceilings + the resulting brand-level total",
      content: {
        "application/json": { schema: BrandFunnelDailyBudgetsSchema },
      },
    },
    400: {
      description:
        "Invalid brandId, unknown funnel key, or a funded funnel below its minimum",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description:
        "No acquisition channel named for a funnel that is funded through several",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Transfer all solo-brand rows from one org to another (billing + stripe-service)",
  description:
    "Updates local_promos in billing AND proxies to stripe-service for ledger rows. " +
    "Skips co-branding rows. Idempotent.",
  request: {
    headers: internalHeaders,
    body: {
      content: { "application/json": { schema: TransferBrandRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Transfer result with per-table update counts",
      content: { "application/json": { schema: TransferBrandResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "stripe-service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/referrals/claim",
  summary: "Record that an org was referred, and open its outstanding referral promise",
  description:
    "Called by client-service when a new org signs up through another org's invite " +
    "link. Opens the INVITEE's outstanding free-credit promise (its bar stacks above " +
    "every bar the invitee already carries) and remembers who referred them. Grants " +
    "NOTHING: the referral offer has no up-front portion, the whole amount lands when " +
    "the bar is crossed. The INVITER's own promise is opened later, at the moment the " +
    "invitee EARNS theirs, never from the invitee merely signing up. Idempotent: " +
    "re-claiming the same invite returns the existing promise with alreadyClaimed=true.",
  request: {
    headers: internalHeaders,
    body: {
      content: { "application/json": { schema: ReferralClaimRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Referral promise opened (or already open — idempotent)",
      content: { "application/json": { schema: ReferralClaimResponseSchema } },
    },
    400: {
      description: "Invalid body, or an org referring itself",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "This org was already referred by a DIFFERENT org",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "referral_reward ledger key seed missing",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/free-credit-promises",
  summary: "Free-credit promises this org is still waiting on",
  description:
    "Every outstanding promise, cheapest bar first: what it is worth, what unlocks " +
    "it, how far along the org is, and — when the promise exists because someone they " +
    "referred converted — which org that was, by name and domain " +
    "(referred_org_name / referred_org_domain, resolved through brand-service and " +
    "fail-soft: absent or null, never fabricated, never blocking the amounts). An " +
    "outstanding promise is a promise, not " +
    "money: it is NOT part of credited / balance / spendable. Settles first, so a " +
    "customer returning from Stripe sees an already-earned grant land immediately; " +
    "that can only make an earned grant land sooner, never conjure one.",
  request: {
    headers: z.object({
      "x-api-key": z.string(),
      "x-org-id": z.string().uuid(),
      "x-user-id": z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "Outstanding promises for this org",
      content: {
        "application/json": { schema: FreeCreditPromisesResponseSchema },
      },
    },
    400: {
      description: "Missing or invalid org headers",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "stripe-service unavailable, or a promise could not be settled",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
