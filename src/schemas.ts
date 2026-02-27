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

export const BillingModeSchema = z
  .enum(["trial", "byok", "payg"])
  .openapi("BillingMode");

// --- Account ---

export const BillingAccountSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    appId: z.string(),
    billingMode: BillingModeSchema,
    creditBalanceCents: z.number().int(),
    reloadAmountCents: z.number().int().nullable(),
    reloadThresholdCents: z.number().int().nullable(),
    hasPaymentMethod: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("BillingAccount");

// --- Deduct ---

export const DeductRequestSchema = z
  .object({
    amount_cents: z.number().int().positive(),
    description: z.string().min(1),
    app_id: z.string().min(1),
    user_id: z.string().uuid(),
  })
  .openapi("DeductRequest");

export const DeductResponseSchema = z
  .object({
    success: z.boolean(),
    balance_cents: z.number().int().nullable(),
    billing_mode: BillingModeSchema,
    depleted: z.boolean(),
  })
  .openapi("DeductResponse");

// --- Mode ---

export const UpdateModeRequestSchema = z
  .object({
    mode: z.enum(["byok", "payg"]),
    reload_amount_cents: z.number().int().positive().optional(),
  })
  .openapi("UpdateModeRequest");

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

// --- Balance ---

export const BalanceResponseSchema = z
  .object({
    balance_cents: z.number().int(),
    billing_mode: BillingModeSchema,
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
  "x-app-id": z.string(),
  "x-user-id": z.string().uuid().optional(),
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
  path: "/v1/accounts/mode",
  summary: "Switch billing mode",
  request: {
    headers: protectedHeaders,
    body: {
      content: { "application/json": { schema: UpdateModeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated account",
      content: { "application/json": { schema: BillingAccountSchema } },
    },
    400: {
      description: "Invalid transition",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/credits/deduct",
  summary: "Deduct credits from org balance",
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
  summary: "Create Stripe Checkout session for PAYG setup",
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
  path: "/v1/webhooks/stripe/{appId}",
  summary: "Stripe webhook handler (per-app)",
  request: {
    params: z.object({
      appId: z.string(),
    }),
  },
  responses: {
    200: { description: "Webhook processed" },
    400: { description: "Invalid signature" },
  },
});
