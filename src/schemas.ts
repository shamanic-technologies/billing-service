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

// --- Account ---

export const BillingAccountSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    creditBalanceCents: z.number().int(),
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
    amount_cents: z.number().int().positive(),
    description: z.string().min(1),
  })
  .openapi("DeductRequest");

export const DeductResponseSchema = z
  .object({
    success: z.boolean(),
    balance_cents: z.number().int(),
    depleted: z.boolean(),
  })
  .openapi("DeductResponse");

// --- Provision ---

export const ProvisionRequestSchema = z
  .object({
    amount_cents: z.number().int().positive(),
    description: z.string().min(1),
  })
  .openapi("ProvisionRequest");

export const ProvisionResponseSchema = z
  .object({
    provision_id: z.string().uuid(),
    balance_cents: z.number().int(),
    depleted: z.boolean(),
  })
  .openapi("ProvisionResponse");

export const ConfirmProvisionRequestSchema = z
  .object({
    actual_amount_cents: z.number().int().positive().optional(),
  })
  .openapi("ConfirmProvisionRequest");

export const ConfirmProvisionResponseSchema = z
  .object({
    provision_id: z.string().uuid(),
    status: z.literal("confirmed"),
    original_amount_cents: z.number().int(),
    final_amount_cents: z.number().int(),
    adjustment_cents: z.number().int(),
    balance_cents: z.number().int().nullable(),
  })
  .openapi("ConfirmProvisionResponse");

export const CancelProvisionResponseSchema = z
  .object({
    provision_id: z.string().uuid(),
    status: z.literal("cancelled"),
    refunded_cents: z.number().int(),
    balance_cents: z.number().int().nullable(),
  })
  .openapi("CancelProvisionResponse");

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
    balance_cents: z.number().int(),
    required_cents: z.number().int(),
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
    balance_cents: z.number().int(),
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
    "If the balance is insufficient and auto-reload is configured, charges the smallest multiple of reload_amount_cents " +
    "that covers the deficit (e.g. $10 reload unit, $37 deduction with $2 balance → charges 4x $10 = $40). " +
    "Always deducts, even if it results in a negative balance.",
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
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Provision already confirmed or cancelled",
      content: { "application/json": { schema: ErrorResponseSchema } },
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
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Provision already confirmed or cancelled",
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
