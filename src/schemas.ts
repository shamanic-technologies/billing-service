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

// --- Account ---

export const BillingAccountSchema = z
  .object({
    id: z.string().uuid(),
    org_id: z.string().uuid(),
    /** Lifetime credits added: stripe-service paid topups + sum(local_promos). */
    credited_cents: CentsStringSchema,
    /** Lifetime platform usage from runs-service /internal/org-usage-total. */
    usage_cents: CentsStringSchema,
    /** Spendable funds = credited_cents − usage_cents. Use this for depletion/budget gates. */
    balance_cents: CentsStringSchema,
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
    topup_threshold_cents: z.number().int().min(0).optional(),
  })
  .openapi("UpdateAutoTopupRequest");

// --- Checkout ---

export const CreateCheckoutRequestSchema = z
  .object({
    success_url: z.string().url(),
    cancel_url: z.string().url(),
    /**
     * Checkout flavor. Absent or "payment" → charge `topup_amount_cents` (unchanged
     * behavior). "setup" → no-charge Stripe Checkout that saves a reusable off-session
     * card so the org can enable auto-topup without buying credits.
     */
    mode: z.enum(["payment", "setup"]).optional(),
    /**
     * Required for payment-mode (validated in the route — fail loud with 400 when
     * absent). Omitted for setup-mode (no charge).
     */
    topup_amount_cents: z.number().int().positive().optional(),
  })
  .openapi("CreateCheckoutRequest");

export const CheckoutResponseSchema = z
  .object({
    url: z.string(),
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
    balance_cents: CentsStringSchema,
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
    "mode='payment' (default) charges topup_amount_cents and persists it as the auto-topup amount. " +
    "mode='setup' creates a no-charge Checkout that saves a reusable off-session card (for enabling auto-topup); topup_amount_cents is omitted and no topup amount is written.",
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
