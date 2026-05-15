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
    /** Prepaid balance liability (what we owe the org). */
    balance_cents: CentsStringSchema,
    /** Lifetime platform usage from runs-service /internal/org-usage-total. */
    usage_cents: CentsStringSchema,
    /** balance_cents − usage_cents. Use this for depletion/budget gates. */
    available_cents: CentsStringSchema,
    topup_amount_cents: z.number().int().nullable(),
    topup_threshold_cents: z.number().int().nullable(),
    has_payment_method: z.boolean(),
    has_auto_topup: z.boolean(),
    stripe_customer_id: z.string().nullable(),
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

// --- Usage Apply (was usage-notify) ---

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
    topup_amount_cents: z.number().int().positive(),
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
    available_cents: CentsStringSchema,
    depleted: z.boolean(),
  })
  .openapi("BalanceResponse");

// --- Customer Balance Transactions ---

export const CustomerBalanceTransactionTypeSchema = z.enum([
  "payment",
  "gift",
  "promo",
  "refund",
  "usage_applied",
]);

export const CustomerBalanceTransactionStatusSchema = z.enum([
  "requires_capture",
  "succeeded",
  "canceled",
]);

export const CustomerBalanceTransactionSchema = z
  .object({
    id: z.string().uuid(),
    object: z.literal("customer_balance_transaction"),
    /** Signed: negative = credit, positive = debit. */
    amount_cents: CentsStringSchema,
    type: CustomerBalanceTransactionTypeSchema,
    status: CustomerBalanceTransactionStatusSchema,
    stripe_payment_intent_id: z.string().nullable(),
    stripe_balance_transaction_id: z.string().nullable(),
    cost_id: z.string().uuid().nullable(),
    description: z.string().nullable(),
    /** Unix seconds, Stripe convention. */
    created: z.number().int(),
  })
  .openapi("CustomerBalanceTransaction");

export const CustomerBalanceTransactionListSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(CustomerBalanceTransactionSchema),
    has_more: z.boolean(),
  })
  .openapi("CustomerBalanceTransactionList");

// --- Promotion Codes ---

export const RedeemPromotionCodeRequestSchema = z
  .object({
    code: z.string().min(1),
  })
  .openapi("RedeemPromotionCodeRequest");

export const RedeemPromotionCodeResponseSchema = z
  .object({
    redeemed: z.boolean(),
    /** Signed: negative = credit (added to balance). */
    amount_cents: CentsStringSchema,
    balance_cents: CentsStringSchema,
  })
  .openapi("RedeemPromotionCodeResponse");

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

// --- Public Stats ---

// Public-stats values are full-precision decimal strings to preserve sub-cent
// fidelity in JSON. Consumers wanting display-rounded integers should
// `Math.ceil(parseFloat(...))` at the presentation layer.
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
    /** Sum of billing_accounts.balance_cents (prepaid balance liability). */
    total_balance_cents: CentsStringSchema,
    /** Lifetime positive sum of credited cents (payment + gift + promo + refund). */
    total_credited_cents: CentsStringSchema,
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
    "Cross-tenant aggregate billing statistics. No authentication required.",
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
      description: "Payment provider authentication failed or runs-service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/accounts/balance",
  summary: "Quick available-funds check",
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
  method: "get",
  path: "/v1/customer_balance_transactions",
  summary: "Paginated customer balance transaction history",
  description:
    "Lists the org's customer balance transactions in reverse chronological order. " +
    "Excludes legacy `usage_applied` rows (frozen post-#104; runs-service owns usage truth). " +
    "`amount_cents` is SIGNED: negative = credit, positive = debit.",
  request: {
    headers: protectedHeaders,
  },
  responses: {
    200: {
      description: "Customer balance transaction list",
      content: { "application/json": { schema: CustomerBalanceTransactionListSchema } },
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
  summary: "Configure auto-topup settings (requires payment method)",
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
  summary: "Create Stripe Customer Portal session for payment method management",
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
      description: "No Stripe customer or invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Billing account not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Payment provider authentication failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/checkout-sessions",
  summary: "Create Stripe Checkout session to add payment method and balance top-up",
  description: "Auto-creates the billing account with $2.00 trial gift if the org has no account yet. " +
    "Creates a Stripe Checkout session in setup mode to collect a payment method and configure auto-topup.",
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
      description: "Payment provider authentication failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/customer_balance/authorize",
  summary: "Synchronous pre-execution authorization with auto-topup",
  description: "Auto-creates the billing account with $2.00 trial gift if the org has no account yet. " +
    "Resolves prices from costs-service, fetches org usage total from runs-service, then checks available funds. " +
    "Available funds = balance_cents − usage_cents. " +
    "If insufficient and auto-topup is configured, charges the smallest multiple of topup_amount_cents " +
    "that covers the required amount. " +
    "Sends email notification on topup failure or balance depletion.",
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
      description: "Payment provider, costs-service, or runs-service unavailable",
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
    "Body carries the org's current spent total (actual + provisioned platform costs). " +
    "Billing computes available = balance - usage; if below topup_threshold " +
    "and auto-topup is configured, fires a Stripe topup under a short row lock. " +
    "Always returns 202 — caller does NOT rely on this for correctness; billing always " +
    "re-pulls truth from runs-service /internal/org-usage-total at authorize time.",
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
  summary: "Redeem a promo code for bonus credits",
  description:
    "Validates the promo code, checks it hasn't been redeemed by this org, " +
    "and credits the bonus amount to the org's customer balance. " +
    "Inserts a `type='promo'` row with negative signed amount_cents. " +
    "The normal $2 welcome gift is unaffected — this adds on top.",
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

registry.registerPath({
  method: "post",
  path: "/v1/webhooks/stripe",
  summary: "Stripe webhook handler",
  description:
    "Fixed URL for Stripe webhook. Organization is resolved from the Stripe customer ID in the event payload.",
  responses: {
    200: { description: "Webhook processed" },
    400: { description: "Invalid signature or missing stripe-signature header" },
  },
});

const internalHeaders = z.object({
  "x-api-key": z.string(),
});

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Transfer all solo-brand rows from one org to another",
  description:
    "For every table that stores brand references alongside org_id, " +
    "re-assigns rows where org_id = sourceOrgId and the row references only sourceBrandId. " +
    "When targetBrandId is provided, also rewrites the brand reference to targetBrandId. " +
    "Skips co-branding rows (multiple brand IDs). Idempotent.",
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
  },
});
