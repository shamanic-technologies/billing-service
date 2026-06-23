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
    "Platform usage from runs-service, including actualized costs and provisioned holds. Use with balance_cents for spend authorization.",
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
    /** Lifetime platform usage from runs-service /internal/org-usage-total. */
    usage_cents: UsageCentsSchema,
    /** Spendable funds = credited_cents − usage_cents. Use this for depletion/budget gates. */
    balance_cents: SpendableBalanceCentsSchema,
    /** User-facing balance = credited_cents − actualized usage only. */
    actual_balance_cents: ActualBalanceCentsSchema,
    topup_amount_cents: z.number().int().nullable(),
    topup_threshold_cents: z.number().int().nullable(),
    has_payment_method: z.boolean(),
    has_auto_topup: z.boolean(),
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

// --- Wallet setup ---

export const WalletSetupRequestSchema = z
  .object({
    /** Paid first load charged immediately via stripe-service PaymentIntent. */
    initial_load_amount_cents: z.number().int().positive(),
    /** Ongoing auto-topup reload amount. Required; no silent default. */
    topup_amount_cents: z.number().int().positive(),
    /** Ongoing auto-topup trigger threshold. Required; no silent default. */
    topup_threshold_cents: z.number().int().min(0),
  })
  .openapi("WalletSetupRequest");

export const WalletSetupResponseSchema = BillingAccountSchema.extend({
  initial_load_amount_cents: z.number().int().positive(),
  initial_load_payment_intent_id: z.string(),
  first_load_match_applied: z.boolean(),
  first_load_match_cents: CentsStringSchema,
  first_load_match_local_promo_id: z.string().uuid().nullable(),
}).openapi("WalletSetupResponse");

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

// --- Internal account teardown (client-service org cascade delete) ---

export const InternalAccountTeardownDeletedRowsSchema = z
  .object({
    billingAccounts: z.number().int(),
    localPromos: z.number().int(),
    creditDepletionEpisodes: z.number().int(),
    campaignAuthorizeCosts: z.number().int(),
    brandDailyBudgets: z.number().int(),
    welcomeCreditClaims: z.number().int(),
  })
  .openapi("InternalAccountTeardownDeletedRows");

export const InternalAccountTeardownResponseSchema = z
  .object({
    ok: z.literal(true),
    orgId: z.string().uuid(),
    deletedRows: InternalAccountTeardownDeletedRowsSchema,
  })
  .openapi("InternalAccountTeardownResponse");

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

// --- Public Stats ---

export const BillingGrowthRowSchema = z
  .object({
    period: z.string(),
    credited_cents: CentsStringSchema,
    revenue_cents: CentsStringSchema,
  })
  .openapi("BillingGrowthRow");

export const PublicBillingStatsSchema = z
  .object({
    total_accounts: z.number().int(),
    accounts_with_payment_method: z.number().int(),
    /** Lifetime sum of paid + local credits (combined). */
    total_credited_cents: CentsStringSchema,
    /** Lifetime stripe-service paid only. */
    total_paid_cents: CentsStringSchema,
    /**
     * Cumulative all-time Stripe revenue, top-level alias for investor/landing-page consumers.
     * Currently equals `total_paid_cents` (gross — refunds not subtracted). Will become net
     * (paid − refunded) once stripe-service exposes refund totals.
     */
    total_revenue_cents: CentsStringSchema,
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
    "Credit + first-load match land via the existing checkout.session.completed webhook in all modes.",
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
  path: "/v1/accounts/wallet_setup",
  summary: "Configure mandatory org wallet funding and process the initial load",
  description:
    "First-campaign funding setup. Requires explicit initial_load_amount_cents, topup_amount_cents, and topup_threshold_cents. " +
    "Charges the initial load via stripe-service, stores org-level auto-topup settings, and grants a first-load local promo match dollar-for-dollar up to $25 exactly once per org.",
  request: {
    headers: protectedHeaders,
    body: {
      content: { "application/json": { schema: WalletSetupRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Wallet setup result",
      content: { "application/json": { schema: WalletSetupResponseSchema } },
    },
    400: {
      description: "Invalid request or missing payment method",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    402: {
      description: "Initial load payment failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "stripe-service or runs-service unavailable",
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
    "When reason='invite_welcome', the existing $2 welcome row (if any) is deleted " +
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
    "redemptions, first_load_match), newest first. reason is the promo code.",
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
