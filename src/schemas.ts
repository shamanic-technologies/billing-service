import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { parsePositiveCents } from "./lib/cents.js";

extendZodWithOpenApi(z);
export const registry = new OpenAPIRegistry();

// --- Shared ---

export const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse");

export const ProvisionConflictResponseSchema = z
  .object({
    error: z.string(),
    transaction_id: z.string().uuid().nullable(),
    provision_id: z.string().uuid().nullable().describe("DEPRECATED alias of transaction_id; will be removed after consumers migrate"),
    cost_id: z.string().uuid().nullable().optional(),
    run_id: z.string().nullable(),
    current_status: z.string().nullable(),
    current_amount_cents: z.string().nullable(),
    requested_amount_cents: z.string().nullable().optional(),
  })
  .openapi("ProvisionConflictResponse");

/**
 * Inbound fractional-cents amount. Accepts decimal string or finite number.
 * Rejects negative, zero, NaN, non-numeric, or integer part > 16 digits.
 * Output is the canonical fixed-scale string (10 fractional digits).
 */
const PositiveCentsSchema = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return parsePositiveCents(v);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : "invalid amount_cents",
      });
      return z.NEVER;
    }
  });

/**
 * Outbound balance/amount string with full numeric(16,10) precision.
 * Drizzle returns numeric columns as strings — we pass them through unchanged.
 */
const CentsStringSchema = z.string();

// --- Account ---

export const BillingAccountSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    creditBalanceCents: CentsStringSchema,
    reloadAmountCents: z.number().int().nullable(),
    reloadThresholdCents: z.number().int().nullable(),
    hasPaymentMethod: z.boolean(),
    hasAutoReload: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("BillingAccount");

// --- Deduct ---

export const DeductRequestSchema = z
  .object({
    amount_cents: PositiveCentsSchema,
    description: z.string().min(1),
  })
  .openapi("DeductRequest");

export const DeductResponseSchema = z
  .object({
    success: z.boolean(),
    balance_cents: CentsStringSchema,
    depleted: z.boolean(),
  })
  .openapi("DeductResponse");

// --- Provision ---

export const ProvisionRequestSchema = z
  .object({
    amount_cents: PositiveCentsSchema,
    description: z.string().min(1),
    cost_id: z.string().uuid().optional(),
  })
  .openapi("ProvisionRequest");

export const ProvisionResponseSchema = z
  .object({
    transaction_id: z.string().uuid(),
    provision_id: z.string().uuid().describe("DEPRECATED alias of transaction_id; will be removed after consumers migrate"),
    cost_id: z.string().uuid().nullable().optional(),
    balance_cents: CentsStringSchema,
    depleted: z.boolean(),
  })
  .openapi("ProvisionResponse");

export const ConfirmProvisionRequestSchema = z
  .object({
    actual_amount_cents: PositiveCentsSchema.optional(),
  })
  .openapi("ConfirmProvisionRequest");

export const ConfirmProvisionResponseSchema = z
  .object({
    transaction_id: z.string().uuid(),
    provision_id: z.string().uuid().describe("DEPRECATED alias of transaction_id; will be removed after consumers migrate"),
    cost_id: z.string().uuid().nullable().optional(),
    status: z.literal("confirmed"),
    original_amount_cents: CentsStringSchema,
    final_amount_cents: CentsStringSchema,
    adjustment_cents: CentsStringSchema,
    balance_cents: CentsStringSchema.nullable(),
  })
  .openapi("ConfirmProvisionResponse");

export const CancelProvisionResponseSchema = z
  .object({
    transaction_id: z.string().uuid(),
    provision_id: z.string().uuid().describe("DEPRECATED alias of transaction_id; will be removed after consumers migrate"),
    cost_id: z.string().uuid().nullable().optional(),
    status: z.literal("cancelled"),
    refunded_cents: CentsStringSchema,
    balance_cents: CentsStringSchema.nullable(),
  })
  .openapi("CancelProvisionResponse");

export const ConfirmByCostRequestSchema = z
  .object({
    actual_amount_cents: PositiveCentsSchema.optional(),
  })
  .openapi("ConfirmByCostRequest");

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

// --- Auto-Reload ---

export const UpdateAutoReloadRequestSchema = z
  .object({
    reload_amount_cents: z.number().int().positive(),
    reload_threshold_cents: z.number().int().min(0).optional(),
  })
  .openapi("UpdateAutoReloadRequest");

// --- Checkout ---

export const CreateCheckoutRequestSchema = z
  .object({
    success_url: z.string().url(),
    cancel_url: z.string().url(),
    reload_amount_cents: z.number().int().positive(),
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

// --- Transactions ---

export const TransactionSchema = z
  .object({
    id: z.string(),
    amount_cents: z.number().int(),
    description: z.string().nullable(),
    created_at: z.string(),
    type: z.enum(["deduction", "credit", "reload"]),
  })
  .openapi("Transaction");

export const TransactionsResponseSchema = z
  .object({
    transactions: z.array(TransactionSchema),
    has_more: z.boolean(),
  })
  .openapi("TransactionsResponse");

// --- Promo ---

export const RedeemPromoRequestSchema = z
  .object({
    code: z.string().min(1),
  })
  .openapi("RedeemPromoRequest");

export const RedeemPromoResponseSchema = z
  .object({
    redeemed: z.boolean(),
    amount_cents: z.number().int(),
    balance_cents: CentsStringSchema,
  })
  .openapi("RedeemPromoResponse");

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
    consumed_cents: CentsStringSchema,
    revenue_cents: CentsStringSchema,
  })
  .openapi("BillingGrowthRow");

export const PublicBillingStatsSchema = z
  .object({
    totalAccounts: z.number().int(),
    accountsWithPaymentMethod: z.number().int(),
    totalCreditBalanceCents: CentsStringSchema,
    totalCreditedCents: CentsStringSchema,
    totalConsumedCents: CentsStringSchema,
    monthlyGrowth: z.array(BillingGrowthRowSchema),
    weeklyGrowth: z.array(BillingGrowthRowSchema),
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
      description: "Payment provider authentication failed (e.g. expired Stripe key)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/accounts/balance",
  summary: "Quick balance check from DB cache",
  request: {
    headers: protectedHeaders,
  },
  responses: {
    200: {
      description: "Balance info",
      content: { "application/json": { schema: BalanceResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/accounts/transactions",
  summary: "Get credit transaction history from Stripe",
  request: {
    headers: protectedHeaders,
  },
  responses: {
    200: {
      description: "Transaction list",
      content: { "application/json": { schema: TransactionsResponseSchema } },
    },
    502: {
      description: "Payment provider authentication failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/accounts/auto-reload",
  summary: "Configure auto-reload settings (requires payment method)",
  request: {
    headers: protectedHeaders,
    body: {
      content: { "application/json": { schema: UpdateAutoReloadRequestSchema } },
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
  path: "/v1/accounts/auto-reload",
  summary: "Disable auto-reload",
  request: {
    headers: protectedHeaders,
  },
  responses: {
    200: {
      description: "Updated account with auto-reload disabled",
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
  path: "/v1/credits/deduct",
  summary: "Deduct credits from org balance",
  description: "Auto-creates the billing account with $2.00 trial credit if the org has no account yet. " +
    "Always deducts, even if it results in a negative balance. " +
    "Does NOT auto-reload — use authorize for pre-execution checks with auto-reload.",
  request: {
    headers: protectedHeaders,
    body: {
      content: { "application/json": { schema: DeductRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Deduction result",
      content: { "application/json": { schema: DeductResponseSchema } },
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
  summary: "Create Stripe Checkout session to add payment method and credits",
  description: "Auto-creates the billing account with $2.00 trial credit if the org has no account yet. " +
    "Creates a Stripe Checkout session in setup mode to collect a payment method and configure auto-reload.",
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
  path: "/v1/credits/authorize",
  summary: "Synchronous pre-execution authorization with auto-reload",
  description: "Auto-creates the billing account with $2.00 trial credit if the org has no account yet. " +
    "Resolves prices from costs-service, then checks balance. " +
    "If insufficient and auto-reload is configured, charges the smallest multiple of reload_amount_cents " +
    "that covers the required amount (e.g. $10 reload unit, $37 required with $2 balance → charges 4x $10 = $40). " +
    "Sends email notification on reload failure or credit depletion.",
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
      description: "Payment provider or costs-service unavailable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/credits/provision",
  summary: "Provision credits (deduct immediately, confirm or cancel later)",
  description: "Auto-creates the billing account with $2.00 trial credit if the org has no account yet. " +
    "Deducts amount immediately and creates a pending provision. " +
    "If the post-deduction balance drops below reload_threshold_cents and auto-reload is configured, " +
    "triggers an async reload.",
  request: {
    headers: protectedHeaders,
    body: {
      content: { "application/json": { schema: ProvisionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Provision created",
      content: { "application/json": { schema: ProvisionResponseSchema } },
    },
    502: {
      description: "Payment provider authentication failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/credits/provision/{id}/confirm",
  summary: "Confirm a pending provision, optionally adjusting for actual cost",
  request: {
    headers: protectedHeaders,
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: ConfirmProvisionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Provision confirmed",
      content: { "application/json": { schema: ConfirmProvisionResponseSchema } },
    },
    404: {
      description: "Provision not found",
      content: { "application/json": { schema: ProvisionConflictResponseSchema } },
    },
    409: {
      description: "Provision already confirmed or cancelled",
      content: { "application/json": { schema: ProvisionConflictResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/credits/provision/{id}/cancel",
  summary: "Cancel a pending provision, re-crediting the provisioned amount",
  request: {
    headers: protectedHeaders,
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Provision cancelled",
      content: { "application/json": { schema: CancelProvisionResponseSchema } },
    },
    404: {
      description: "Provision not found",
      content: { "application/json": { schema: ProvisionConflictResponseSchema } },
    },
    409: {
      description: "Provision already confirmed or cancelled",
      content: { "application/json": { schema: ProvisionConflictResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/credits/provision/by-cost/{cost_id}/confirm",
  summary: "Confirm a provision looked up by cost_id (natural key)",
  description:
    "Confirms the most recent provision row for the given cost_id. " +
    "Use this when callers (e.g. runs-service) hold the cost_id but not the billing-internal provision_id. " +
    "Idempotent: re-confirming with the same amount returns 200.",
  request: {
    headers: protectedHeaders,
    params: z.object({ cost_id: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: ConfirmByCostRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Provision confirmed",
      content: { "application/json": { schema: ConfirmProvisionResponseSchema } },
    },
    404: {
      description: "No provision found for cost_id",
      content: { "application/json": { schema: ProvisionConflictResponseSchema } },
    },
    409: {
      description: "Existing provision is in incompatible state (cancelled, or confirmed at a different amount)",
      content: { "application/json": { schema: ProvisionConflictResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/credits/provision/by-cost/{cost_id}/cancel",
  summary: "Cancel a provision looked up by cost_id (natural key)",
  description:
    "Cancels the most recent provision row for the given cost_id. " +
    "Idempotent: re-cancelling an already-cancelled cost_id returns 200.",
  request: {
    headers: protectedHeaders,
    params: z.object({ cost_id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Provision cancelled",
      content: { "application/json": { schema: CancelProvisionResponseSchema } },
    },
    404: {
      description: "No provision found for cost_id",
      content: { "application/json": { schema: ProvisionConflictResponseSchema } },
    },
    409: {
      description: "Existing provision is confirmed (cannot cancel)",
      content: { "application/json": { schema: ProvisionConflictResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/promo/redeem",
  summary: "Redeem a promo code for bonus credits",
  description:
    "Validates the promo code, checks it hasn't been redeemed by this org, " +
    "and credits the bonus amount to the org's billing account. " +
    "The normal $2 welcome credit is unaffected — this adds on top.",
  request: {
    headers: protectedHeaders,
    body: {
      content: { "application/json": { schema: RedeemPromoRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Promo redeemed successfully",
      content: { "application/json": { schema: RedeemPromoResponseSchema } },
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
