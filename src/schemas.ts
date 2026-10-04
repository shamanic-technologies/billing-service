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
    /** How this org pays (prepaid | postpaid). See PUT /v1/accounts/payment_mode. */
    payment_mode: z.enum(["prepaid", "postpaid"]),
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
    /** Credit staff took off this org's balance (POST /v1/credits/debit). Never part of usage_cents. */
    debited_cents: CentsStringSchema.openapi({
      description:
        "Total credit staff removed from this org's balance with an explanatory note (POST /v1/credits/debit; see GET /v1/credits/debits for each line). Lowers balance_cents and actual_balance_cents exactly like spend, but is NOT campaign usage and is not included in usage_cents: balance_cents === credited_cents − usage_cents − debited_cents. \"0\" when none.",
    }),
    /** Spendable funds = credited_cents − usage_cents − debited_cents. Use this for depletion/budget gates. */
    balance_cents: SpendableBalanceCentsSchema,
    /** User-facing balance = credited_cents − actualized usage only. */
    actual_balance_cents: ActualBalanceCentsSchema,
    /**
     * Free credit this org can still spend: min(credited_gifted_cents, balance_cents),
     * floored at 0. "0.0000000000" for an org holding no free credit — e.g. a second
     * org whose person already received the welcome elsewhere.
     */
    free_credit_spendable_cents: CentsStringSchema.openapi({
      description:
        "Free credit this org can still spend right now: the smaller of credited_gifted_cents and balance_cents, never below 0. Positive means the org can run on gifted credit without paying first (e.g. a 'skip payment' option); 0 means it holds none — including a second org whose person already received the welcome gift on another org (the welcome is once per person).",
    }),
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
    /**
     * ONBOARDING checkout only. true → topup_amount_cents is the FULL daily budget and
     * billing deducts the welcome gift the org holds as a real discount (the page shows
     * the budget, the gift as a discount line, and the total). Absent/false → the
     * checkout charges topup_amount_cents exactly, no discount (unchanged behaviour).
     * Payment mode only (400 with mode='setup'). 409 when the org has already paid
     * (`welcome_discount_not_first_payment`) or the gift covers the whole budget
     * (`welcome_gift_covers_budget` → open a setup-mode checkout instead).
     */
    apply_welcome_gift: z.boolean().optional(),
  })
  .refine(
    (data) => data.ui_mode === "embedded" || (!!data.success_url && !!data.cancel_url),
    {
      message: "success_url and cancel_url are required for hosted checkout",
      path: ["success_url"],
    }
  )
  .openapi("CreateCheckoutRequest");

export const WelcomeDiscountRefusalSchema = z
  .object({
    error: z.string(),
    code: z.enum(["welcome_discount_not_first_payment", "welcome_gift_covers_budget"]),
    /** The welcome gift this org holds, in cents. */
    welcome_gift_cents: z.number().int(),
  })
  .openapi("WelcomeDiscountRefusal");

export const DeclareAcquirerRequestSchema = z
  .object({
    /** The only declaration this surface accepts: this new org pays through Revolut. */
    acquirer: z.literal("revolut"),
    /** The creator's email, used to create the acquirer-side customer. */
    email: z.string().email().optional(),
    /** The creator's name, used to create the acquirer-side customer. */
    full_name: z.string().min(1).optional(),
  })
  .openapi("DeclareAcquirerRequest");

export const DeclareAcquirerResponseSchema = z
  .object({
    org_id: z.string(),
    acquirer: z.string(),
  })
  .openapi("DeclareAcquirerResponse");

export const DeclareAcquirerRefusalSchema = z
  .object({
    error: z.string(),
    code: z.literal("chargeable_card_on_other_acquirer"),
  })
  .openapi("DeclareAcquirerRefusal");

export const CheckoutResponseSchema = z
  .object({
    /** Present for HOSTED checkout (the redirect URL); absent in embedded mode. */
    url: z.string().optional(),
    /** Present for EMBEDDED checkout (mounted in the in-app modal iframe); absent for hosted. */
    client_secret: z.string().optional(),
    session_id: z.string(),
    /** Only when the request set apply_welcome_gift: what came off the budget (0 = this org holds no welcome gift). */
    welcome_discount_cents: z.number().int().optional(),
    /** Only when the request set apply_welcome_gift: what the buyer pays (budget − welcome_discount_cents). */
    amount_due_cents: z.number().int().optional(),
    /**
     * EMBEDDED only, and only when the org's acquirer takes the payment through a
     * widget the page mounts itself: `"embedded_widget"`, same vocabulary as
     * card_setup's `mode`. Absent = a Stripe embedded session (use `client_secret`).
     */
    mode: z.literal("embedded_widget").optional(),
    /** embedded_widget only. The acquirer's browser SDK to load. */
    script_url: z.string().optional(),
    /** embedded_widget only. The SDK's environment argument. */
    environment: z.enum(["prod", "sandbox"]).optional(),
    /** embedded_widget only. Per-order PUBLIC token the SDK is initialised with. */
    token: z.string().optional(),
    /** embedded_widget only. Pass to the widget so the card is saved for later top-ups. */
    save_payment_method_for: z.literal("merchant").optional(),
    /** embedded_widget only. What the buyer is charged, minor units. */
    amount: z.number().int().optional(),
    /** embedded_widget only. */
    currency: z.string().optional(),
  })
  .openapi("CheckoutResponse");

// --- Portal Sessions ---

/**
 * How the card form is shown. `hosted` (the default, every existing caller) is the
 * acquirer's own page reached by redirect; `embedded` asks for a form the calling
 * page mounts in place, charging nothing — for a surface that must not lose its
 * state to a redirect (the New organization modal). An acquirer whose only form is
 * already in-page answers the same way for both. `return_url` is only needed when
 * something redirects, so it is optional for `embedded`.
 */
const CardUiModeSchema = z.enum(["hosted", "embedded"]).optional().openapi({
  description:
    "`hosted` (default): the acquirer's page, reached by redirect. `embedded`: a form the page mounts in place, charging nothing (Stripe answers `embedded_checkout` + `client_secret`). return_url is optional only for `embedded`.",
});

const returnUrlUnlessEmbedded = (
  body: { return_url?: string; ui_mode?: "hosted" | "embedded" },
  ctx: z.RefinementCtx
) => {
  if (body.ui_mode !== "embedded" && !body.return_url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["return_url"],
      message: "return_url is required unless ui_mode is \"embedded\"",
    });
  }
};

export const CreatePortalSessionRequestSchema = z
  .object({
    return_url: z.string().url().optional(),
    amount: z.number().int().positive().optional(),
    currency: z.string().min(3).optional(),
    ui_mode: CardUiModeSchema,
  })
  .superRefine(returnUrlUnlessEmbedded)
  .openapi("CreatePortalSessionRequest");

// --- Card setup (acquirer-neutral descriptor, stripe-service v0.48.0) ---

export const CardSetupRequestSchema = z
  .object({
    return_url: z.string().url().optional(),
    currency: z.string().min(3).optional(),
    ui_mode: CardUiModeSchema,
  })
  .superRefine(returnUrlUnlessEmbedded)
  .openapi("CardSetupRequest");

/**
 * What the BROWSER needs to render the card form, and nothing else.
 *
 * Passed through from stripe-service verbatim: it names the mechanism its
 * acquirer offers and hands over only what a page may hold. `token` is a
 * PER-ORDER PUBLIC identifier scoped to this one setup attempt — not a merchant
 * key, and stripe-service strips its own credentials before answering. Nothing
 * here re-introduces one, and card details are typed inside an iframe the
 * acquirer hosts, so they never reach the calling page or this service.
 */
/**
 * What the outstanding-balance collection did on the way to a card surface.
 * Shared by every route that settles before touching a card (the card session
 * and card removal) so a caller reads one concept one way. REPORTED, never a
 * veto: every value accompanies a successful response.
 */
const SettleOutcomeFields = {
  settle_result: z
    .enum(["charged", "declined", "failed", "not_attempted"])
    .openapi({
      description:
        "charged = the outstanding balance was just taken (`settled_cents`). " +
        "declined = the acquirer answered and refused the card; the balance is still owed " +
        "(`settle_decline_message` carries the acquirer's own customer-readable reason when it gave one). " +
        "failed = we could not get an answer from the payment side; nothing is known to be charged and the balance is still owed " +
        "(NOT a decline: the card may be fine). " +
        "not_attempted = no charge was presented; `settle_skip_reason` says why (e.g. nothing_owed, no_card, card_unusable, below_minimum, charge_backoff).",
    }),
  /** Cents collected by this request (0 when nothing was taken). */
  settled_cents: z.number(),
  /** Present when nothing was collected. Diagnostic — never a refusal. */
  settle_skip_reason: z.string().optional(),
  settle_decline_message: z.string().nullable().openapi({
    description:
      "The acquirer's own customer-readable refusal sentence (e.g. \"Your card does not support this type of purchase.\"). " +
      "Set only when settle_result is `declined` and the acquirer gave one; null otherwise. Never a raw processor payload.",
  }),
};

export const CardSetupResponseSchema = z
  .object({
    object: z.literal("card_setup"),
    mode: z.enum(["hosted_redirect", "embedded_widget", "embedded_checkout"]),
    url: z.string().optional(),
    /**
     * `embedded_checkout` only: the secret the page hands to the acquirer's own
     * embedded form (Stripe `initEmbeddedCheckout({ clientSecret })`). Scoped to
     * this one no-charge setup session; not a merchant key.
     */
    client_secret: z.string().optional(),
    script_url: z.string().optional(),
    environment: z.enum(["prod", "sandbox"]).optional(),
    token: z.string().optional(),
    save_payment_method_for: z.literal("merchant").optional(),
    /**
     * Additive: what the outstanding-balance collection attempted before this
     * descriptor was issued. The descriptor is handed over whatever it says.
     */
    ...SettleOutcomeFields,
  })
  .openapi("CardSetupResponse");

/**
 * The card is no longer held. What the collection attempted on the way out is
 * REPORTED, never a veto: `settled_cents` is what was actually taken (0 when
 * nothing was owed or nothing could be taken) and `settle_skip_reason` says
 * why. Nothing is forgiven — a debt that could not be collected stays owed.
 */
export const RemoveSavedPaymentMethodResponseSchema = z
  .object({
    object: z.literal("saved_payment_method_removed"),
    org_id: z.string(),
    /** How many saved methods this call detached. 0 is a success, not an error. */
    removed: z.number().int(),
    /** How many were already gone when we asked. */
    already_removed: z.number().int(),
    /** True when a stored auto-topup configuration was cleared by this removal. */
    auto_topup_disarmed: z.boolean(),
    /** What the collection at removal time did, on the card that was about to go. */
    ...SettleOutcomeFields,
  })
  .openapi("RemoveSavedPaymentMethodResponse");

/**
 * Whether a saved, chargeable card exists for this org. THREE answers, kept
 * apart: `saved: true`; `saved: false` with a `reason`; or a 502, which means we
 * could not ask and is never rendered as either of the other two.
 */
export const SavedPaymentMethodResponseSchema = z
  .object({
    object: z.literal("saved_payment_method"),
    org_id: z.string(),
    acquirer: z.string(),
    saved: z.boolean(),
    method: z
      .object({
        id: z.string(),
        type: z.string(),
        saved_for: z.string().nullable(),
      })
      .nullable(),
    reason: z.string().optional(),
  })
  .openapi("SavedPaymentMethodResponse");

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
    /**
     * Closed set — a caller can never supply an arbitrary reason. The two invite
     * reasons are ONE-SHOT per (org, reason); `product_task_completed` RECURS and
     * therefore requires a per-completion identifier.
     */
    reason: z.enum([
      "invite_reward",
      "invite_welcome",
      "product_task_completed",
    ]),
    /**
     * The caller's own identifier for ONE product-task completion. Required for
     * `product_task_completed` (a recurring reward has no other way to tell a new
     * completion from a retry of the last one) and REFUSED on the invite reasons,
     * whose idempotency is (org, reason) and must not be weakened. No silent
     * default and no silent ignore.
     */
    completionId: z.string().min(1).optional(),
  })
  .superRefine((body, ctx) => {
    const recurring = body.reason === "product_task_completed";
    if (recurring && body.completionId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["completionId"],
        message:
          "completionId is required for reason=product_task_completed (the reward recurs, so a retry can only be told from a new completion by its identifier)",
      });
    }
    if (!recurring && body.completionId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["completionId"],
        message: `completionId is not accepted for reason=${body.reason} (this grant is idempotent on (org, reason))`,
      });
    }
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

// --- Staff debits (the mirror of the staff grant: take credit OFF a balance) ---

export const StaffDebitRequestSchema = z
  .object({
    /** Amount to take off the org's balance, positive integer cents. */
    amountCents: z.number().int().positive(),
    /** Why — mandatory, human-readable, stored on the debit row. */
    note: z.string().trim().min(1, "note is required"),
    /**
     * Caller-supplied key. The same key retried never debits twice; the same key
     * with a different amount is refused (409). Required — no silent default.
     */
    idempotencyKey: z.string().min(1),
  })
  .openapi("StaffDebitRequest");

export const StaffDebitItemSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    /** Debited amount, decimal string (numeric(16,10)), positive. */
    amountCents: CentsStringSchema,
    /** Staff note explaining the debit. */
    note: z.string(),
    /** Staff email behind the debit (x-email). */
    debitedBy: z.string(),
    idempotencyKey: z.string(),
    createdAt: z.string(),
  })
  .openapi("StaffDebitItem");

export const StaffDebitResponseSchema = z
  .object({
    ok: z.literal(true),
    debit: StaffDebitItemSchema,
    /** True when this idempotencyKey had already debited the org: nothing new was taken. */
    alreadyDebited: z.boolean(),
    /** Spendable funds after the debit (credited_cents − usage_cents − debited_cents). */
    newBalanceCents: CentsStringSchema,
  })
  .openapi("StaffDebitResponse");

export const StaffDebitsListResponseSchema = z
  .object({
    debits: z.array(StaffDebitItemSchema),
  })
  .openapi("StaffDebitsListResponse");

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
    campaignDailyBudgets: z.number().int(),
    welcomeCreditClaims: z.number().int(),
    freeCreditPromises: z.number().int(),
    staffDebits: z.number().int(),
  })
  .openapi("InternalAccountTeardownDeletedRows");

export const InternalAccountTeardownResponseSchema = z
  .object({
    ok: z.literal(true),
    orgId: z.string().uuid(),
    /**
     * False when billing never held an account for this org. The teardown then
     * created nothing (no account, no Stripe customer, no welcome evaluation) and
     * only removed whatever org-keyed rows existed.
     */
    billingAccountExisted: z.boolean(),
    deletedRows: InternalAccountTeardownDeletedRowsSchema,
  })
  .openapi("InternalAccountTeardownResponse");

// --- Organization-creation bonus (migration 0052) ---

export const OrgCreationBonusResponseSchema = z
  .object({
    ok: z.literal(true),
    orgId: z.string().uuid(),
    /** Ledger reason the row carries in GET /v1/credits/grants. Always `org_creation_bonus`. */
    reason: z.literal("org_creation_bonus"),
    /** What this org received, in cents ($5 = 500). On a retry: the original amount. */
    grantedCents: z.number().int(),
    /** True when the bonus had already been granted — nothing new was paid. */
    alreadyGranted: z.boolean(),
  })
  .openapi("OrgCreationBonusResponse");

// --- Trial seed (migration 0046) ---

export const TrialSeedResponseSchema = z
  .object({
    ok: z.literal(true),
    orgId: z.string().uuid(),
    /** What the org holds as a trial seed, in cents. */
    seededCents: z.number().int(),
    /** true when the org was already seeded — the seed is never doubled. */
    alreadySeeded: z.boolean(),
  })
  .openapi("TrialSeedResponse");

export const SignupWelcomeResponseSchema = z
  .object({
    ok: z.literal(true),
    orgId: z.string().uuid(),
    /** What this org was seeded with before signing up (0 when it never was). */
    trialSeedCents: z.number().int(),
    /** What this call granted under the welcome code (0 when nothing was left to grant). */
    welcomeGrantedCents: z.number().int(),
    /** Seed + welcome. Equals the live welcome amount. */
    totalFreeCreditCents: z.number().int(),
    /** true when the org had already been settled — a replay grants nothing. */
    alreadySettled: z.boolean(),
    /**
     * true when the person signing up (x-user-id) already received the welcome on
     * ANOTHER org: this org got none and its own free-credit offer is zero. Any trial
     * seed it holds is kept (never clawed back).
     */
    welcomeReceivedElsewhere: z.boolean(),
  })
  .openapi("SignupWelcomeResponse");

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

// --- On-demand off-session charge (sell-first onboarding, no second redirect) ---

export const OnDemandChargeRequestSchema = z
  .object({
    amountCents: z.number().int().positive(),
    idempotencyKey: z.string().min(1).optional(),
  })
  .openapi("OnDemandChargeRequest");

export const OnDemandChargeResponseSchema = z
  .object({
    ok: z.boolean(),
    charged: z.boolean(),
    amountCents: z.number().int().positive(),
    reference: z.string().optional(),
    code: z.string().optional(),
    error: z.string().optional(),
  })
  .openapi("OnDemandChargeResponse");

export const TransferBrandTableResultSchema = z
  .object({
    tableName: z.string(),
    count: z.number().int(),
  })
  .openapi("TransferBrandTableResult");

export const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(TransferBrandTableResultSchema),
    balanceAdjustment: z
      .object({
        transferId: z.string().uuid(),
        movedUsageNetCents: z.string(),
        movedActualNetCents: z.string(),
        transferredAt: z.string(),
      })
      .describe(
        "The brand_transfers record: the spend runs-service moved with the brand, left on the source org and taken off the target org so neither balance moves."
      ),
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

// --- Unpaid debt: an org owes money we cannot collect ---

export const PaymentMethodLostRequestSchema = z
  .object({
    orgId: z.string().uuid(),
  })
  .openapi("PaymentMethodLostRequest");

export const PaymentMethodLostResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    state: z.enum([
      "no_debt",
      "collectable",
      "flagged",
      "already_flagged",
      "deferred",
      "no_customer",
      "prepaid",
      "platform_org",
    ]),
    owed_cents: z.string(),
  })
  .openapi("PaymentMethodLostResponse");

export const UnpaidDebtsResponseSchema = z
  .object({
    unpaid_debts: z.array(
      z.object({
        org_id: z.string().uuid(),
        owed_cents: z.string(),
        flagged_at: z.string(),
        episode_started_at: z.string(),
      })
    ),
  })
  .openapi("UnpaidDebtsResponse");

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

// --- Brand global sales budget (one daily budget for sales, "global" mode) ---

export const SetBrandSalesBudgetRequestSchema = z
  .object({
    /**
     * The brand's ONE daily budget for sales, in cents. Non-negative (0 is
     * legal). Accepts a number or decimal string; stored at numeric(16,10).
     */
    dailyBudgetCents: z.union([z.string(), z.number()]),
  })
  .openapi("SetBrandSalesBudgetRequest");

const BrandBudgetModeSchema = z
  .enum(["global", "campaigns"])
  .openapi("BrandBudgetMode", {
    description:
      "global = the brand stated one daily sales budget that campaign-service allocates; " +
      "campaigns = every campaign is paced on its own ceiling (the default).",
  });

const BrandFundingModeSchema = z
  .enum(["items", "global", "campaigns"])
  .openapi("BrandFundingMode", {
    description:
      "items = the brand budgets each campaign (offer x leg x channel) " +
      "(outranks the global pot; only a brand that stated an item reads it); " +
      "global = one daily sales budget campaign-service allocates; " +
      "campaigns = every campaign paced on its own ceiling (the default).",
  });

const ItemPeriodSchema = z.enum(["day", "month"]).openapi("CampaignItemPeriod", {
  description: "day = prepaid / postpaid daily budget; month = subscriber monthly budget.",
});

export const SpendableCampaignItemSchema = z
  .object({
    offerId: z.string().uuid(),
    legKey: z.string(),
    featureSlug: z.string(),
    role: z.enum(["proactive", "reactive"]).nullable(),
    /** Decimal cents. A reactive monthly item includes last period's carry-over. */
    budgetCents: CentsStringSchema,
    period: ItemPeriodSchema,
    /** The plan's current period for a monthly item; null for a daily one. */
    periodStart: z.string().nullable(),
    periodEnd: z.string().nullable(),
    /** false = a channel we do not run yet (recorded, never charged); null = catalogue unreadable. */
    managed: z.boolean().nullable(),
  })
  .openapi("SpendableCampaignItem");

export const BrandSalesBudgetSchema = z
  .object({
    brandId: z.string().uuid(),
    orgId: z.string().uuid(),
    mode: BrandFundingModeSchema,
    /**
     * global: the stated daily sales budget; items: the daily equivalent of the
     * proactive items we run (day + month/30); null in campaigns mode.
     */
    dailyBudgetCents: CentsStringSchema.nullable(),
    /** When it was stated; null in campaigns mode. */
    updatedAt: z.string().nullable(),
    /** items mode only: one row per campaign (offer, leg, channel) campaign-service spends. */
    items: z.array(SpendableCampaignItemSchema).optional(),
  })
  .openapi("BrandSalesBudget");

export const SetBrandSalesBudgetResponseSchema = BrandSalesBudgetSchema.extend({
  /** The amount stated before this write; null when the brand was in campaigns mode. */
  previousDailyBudgetCents: CentsStringSchema.nullable(),
}).openapi("SetBrandSalesBudgetResponse");

export const ClearBrandSalesBudgetResponseSchema = BrandSalesBudgetSchema.extend({
  /** false when the brand was already in campaigns mode (nothing written). */
  cleared: z.boolean(),
  previousDailyBudgetCents: CentsStringSchema.nullable(),
  /** The brand total the brand is back on (its campaign ceilings); null when none. */
  campaignsDailyBudgetCents: CentsStringSchema.nullable(),
}).openapi("ClearBrandSalesBudgetResponse");

export const BrandSalesBudgetHistorySchema = z
  .object({
    brandId: z.string().uuid(),
    orgId: z.string().uuid(),
    history: z.array(
      z.object({
        mode: BrandBudgetModeSchema,
        /** The amount stated at this point; null = cleared (back to campaigns mode). */
        dailyBudgetCents: CentsStringSchema.nullable(),
        changedAt: z.string(),
      })
    ),
  })
  .openapi("BrandSalesBudgetHistory");

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

export const BrandDailyBudgetDaySchema = z
  .object({
    /** The UTC calendar day, YYYY-MM-DD. */
    date: z.string(),
    /**
     * `recorded` — a change governs this day, so dailyBudgetCents is the amount
     * that was in force. `not_recorded` — the day precedes the first change
     * this org+brand ever recorded, so billing does not know. A RECORDED "0"
     * (a brand the customer deliberately defunded) is a different fact from a
     * day billing never observed; tell them apart by this field, never by
     * reading a number as a sentinel.
     */
    state: z.enum(["recorded", "not_recorded"]),
    /** The amount in force at the END of that UTC day. null iff not_recorded. */
    dailyBudgetCents: CentsStringSchema.nullable(),
    /**
     * When that amount was set (ISO 8601) — inside the day when the customer
     * changed it that day, before it otherwise. null iff not_recorded.
     */
    inForceSince: z.string().nullable(),
  })
  .openapi("BrandDailyBudgetDay");

export const ReadBrandDailyBudgetByDaySchema = z
  .object({
    brandId: z.string().uuid(),
    orgId: z.string().uuid(),
    /**
     * The grain these amounts are stated at. The BRAND total is the finest
     * grain billing genuinely records over time.
     */
    grain: z.literal("brand"),
    /**
     * The first daily-budget change ever recorded for this org+brand (ISO
     * 8601), or null when none exists. Every day before it is not_recorded —
     * the change log is forward-only, so a budget set before it and never
     * touched since leaves no trace of when it was set.
     */
    recordBeginsAt: z.string().nullable(),
    /** Oldest day first, one entry per UTC day of the requested range. */
    days: z.array(BrandDailyBudgetDaySchema),
  })
  .openapi("ReadBrandDailyBudgetByDay");

export const PaymentStoppedPeriodSchema = z
  .object({
    /** When the period began (ISO 8601). */
    startedAt: z.string(),
    /** When it ended (ISO 8601), or null while the org is still in it. */
    endedAt: z.string().nullable(),
  })
  .openapi("PaymentStoppedPeriod");

export const PaymentStoppedPeriodsResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    /**
     * The earliest instant this record demonstrably exists (ISO 8601), across
     * BOTH sources (depletion episodes and failed reload streaks), or null when
     * no period has ever been recorded. A day before it is NOT RECORDED: the
     * absence of a period there is not evidence that payment was on.
     */
    recordBeginsAt: z.string().nullable(),
    /**
     * Oldest first and DISJOINT — overlapping stretches are merged, so an open
     * period (endedAt null) can only be the last one.
     */
    periods: z.array(PaymentStoppedPeriodSchema),
  })
  .openapi("PaymentStoppedPeriodsResponse");

// --- Payment mode (prepaid / postpaid) ---

export const PaymentModeSchema = z.enum(["prepaid", "postpaid", "subscription"]).openapi({
  description:
    "How this org pays. postpaid (default for every org): a " +
    "credit line the balance may run below zero into, a card required, and no chargeable card is " +
    "charge_blocked. prepaid: spends only money already paid in (floor 0), no card required, never " +
    "charge_blocked; spend stops at zero through the affordability check. subscription: a monthly " +
    "Stripe subscription ($99/month, 3-day free trial, card required); each paid invoice is that " +
    "amount of credit, the trial start grants $99, floor 0, never auto-reloaded. Entered by starting " +
    "a subscription (POST /v1/accounts/subscription/checkout_session) or by staff.",
});

/** What a CUSTOMER may switch to on their own: never subscription (see PaymentModeSchema). */
export const CustomerPaymentModeSchema = z.enum(["prepaid", "postpaid"]);

export const SetPaymentModeRequestSchema = z
  .object({ payment_mode: CustomerPaymentModeSchema })
  .openapi("SetPaymentModeRequest");

/** Staff/service: any mode, subscription included. */
export const StaffSetPaymentModeRequestSchema = z
  .object({ payment_mode: PaymentModeSchema })
  .openapi("StaffSetPaymentModeRequest");

export const PaymentModeResponseSchema = z
  .object({
    org_id: z.string().uuid(),
    payment_mode: PaymentModeSchema,
  })
  .openapi("PaymentModeResponse");

export const SetPaymentModeResponseSchema = z
  .object({
    org_id: z.string().uuid(),
    payment_mode: PaymentModeSchema,
    /** Cents collected by this switch to settle what was owed ("0" when nothing). */
    settled_cents: z.string(),
    /** Whether auto top-up is configured on after the switch (ON by default when becoming prepaid). */
    auto_topup_enabled: z.boolean(),
  })
  .openapi("SetPaymentModeResponse");

export const PaymentModeRefusalSchema = z
  .object({
    error: z.string(),
    code: z.enum([
      "outstanding_balance_no_card",
      "outstanding_balance_charge_declined",
      "outstanding_balance_below_minimum_charge",
      "subscription_mode_staff_only",
    ]),
    /** What the org owes, positive cents. */
    owed_cents: z.string(),
  })
  .openapi("PaymentModeRefusal");

// --- Payment outlook (when will this org next be charged) ---

export const PaymentOutlookResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    /** How this org pays. A prepaid org is never charge_blocked. */
    paymentMode: PaymentModeSchema,
    /**
     * What billing expects next, money-wise.
     *
     * `no_autopay` is not a failure — it means this org holds a chargeable card
     * but no auto-topup, so it will never be charged automatically and will
     * simply run out and stop. An org with NO chargeable payment method is
     * `charge_blocked` / `no_chargeable_card` instead: nothing can be charged
     * at all, so its campaigns must stop. Half the orgs that were
     * spending anything in the fortnight to 2026-09-18 were in that state, so a
     * consumer that renders a date for every org will be wrong about half of
     * them. `unknown` means spend is happening but cannot be measured honestly
     * (see burnUnavailableReason) — it is never rendered as idle.
     */
    state: z.enum([
      "will_charge",
      "charge_due_now",
      "charge_blocked",
      "no_autopay",
      "idle",
      "unknown",
    ]),
    /**
     * When billing expects to PRESENT the card next (ISO 8601), or null when it
     * does not expect to. This is a CHARGE ATTEMPT, never a payment: for a card
     * the bank is refusing, billing can say when it will try again and nothing
     * about whether the bank will say yes.
     */
    nextChargeAttemptAt: z.string().nullable(),
    /** What brings that date about. Null whenever the date is null. */
    trigger: z.enum(["floor", "month_end", "retry_rung", "subscription_renewal"]).nullable(),
    /** Why no charge is possible. Null unless state is charge_blocked. */
    blockedReason: z
      .enum([
        "card_declined",
        "card_unusable",
        "retries_exhausted",
        "no_chargeable_card",
        "card_country_unsupported",
      ])
      .nullable(),
    balanceCents: z.string(),
    /** The postpaid credit-line floor ("0" when the org has no credit line). */
    floorCents: z.string(),
    /**
     * Net platform spend per day over the burn window, or null when it cannot be
     * measured honestly. Never 0 as a stand-in for "we do not know".
     */
    realizedDailyBurnCents: z.string().nullable(),
    /** Named reason the burn is absent. Null when the burn is present. */
    burnUnavailableReason: z
      .enum(["platform_only_dated_spend_not_served"])
      .nullable(),
    burnWindowDays: z.number(),
    /**
     * The ceilings this org's brands are configured at. A PERMISSION, not a
     * prediction: measured utilisation ran 4% to 146% of it, so it is served
     * beside the realized burn and must not be substituted for it.
     */
    configuredDailyBudgetCents: z.string(),
    /**
     * The share of those ceilings with a campaign actually running behind them.
     * Null when campaign-service could not be read — never the configured total
     * wearing a running label.
     */
    runningDailyBudgetCents: z.string().nullable(),
  })
  .openapi("PaymentOutlookResponse");

// --- Charge schedule (every charge expected over a horizon) ---

export const ExpectedChargeSchema = z
  .object({
    /** When billing expects to PRESENT the card (ISO 8601). An attempt, never a payment. */
    at: z.string(),
    trigger: z.enum(["floor", "month_end", "retry_rung", "subscription_renewal"]),
    /**
     * Integer cents billing would ask for. Null only when the amount cannot be
     * established (the burn is unmeasured) — never 0 as a stand-in.
     */
    expectedAmountCents: z.string().nullable(),
    /** Projected balance just before the charge. Null when the burn is unmeasured. */
    projectedBalanceBeforeCents: z.string().nullable(),
    /** Projected balance just after the charge lands. Null when unmeasured. */
    projectedBalanceAfterCents: z.string().nullable(),
  })
  .openapi("ExpectedCharge");

export const ChargeScheduleResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    paymentMode: PaymentModeSchema,
    /** The payment outlook's state, decided at the same instant. */
    state: z.enum([
      "will_charge",
      "charge_due_now",
      "charge_blocked",
      "no_autopay",
      "idle",
      "unknown",
    ]),
    blockedReason: z
      .enum([
        "card_declined",
        "card_unusable",
        "retries_exhausted",
        "no_chargeable_card",
        "card_country_unsupported",
      ])
      .nullable(),
    asOf: z.string(),
    horizonDays: z.number().int(),
    horizonEndsAt: z.string(),
    balanceCents: z.string(),
    floorCents: z.string(),
    realizedDailyBurnCents: z.string().nullable(),
    burnUnavailableReason: z
      .enum(["platform_only_dated_spend_not_served"])
      .nullable(),
    burnWindowDays: z.number(),
    /** Oldest first. Empty when billing expects no automatic charge. */
    events: z.array(ExpectedChargeSchema),
    /** Sum of the event amounts (integer cents); null when any amount is unknown. */
    expectedTotalCents: z.string().nullable(),
  })
  .openapi("ChargeScheduleResponse");

// --- Daily ceilings per campaign (offer x leg x acquisition channel) ---

/** One campaign's ceiling: one stored row per (offer, leg, channel). */
export const CampaignDailyBudgetSchema = z
  .object({
    /**
     * brand-service offer UUID. `null` only on a ceiling written before offers
     * existed; a per-campaign write always names one.
     */
    offerId: z.string().uuid().nullable(),
    /**
     * features-service's canonical leg id, carried OPAQUE. `null` only on a
     * ceiling written before legs existed.
     */
    legKey: z.string().nullable(),
    /** The acquisition channel (a features-service feature slug) performing the leg. */
    featureSlug: z.string(),
    /** This campaign's daily ceiling. */
    dailyBudgetCents: CentsStringSchema,
    updatedAt: z.string(),
  })
  .openapi("CampaignDailyBudget");

export const ReadBrandOfferDailyBudgetSchema = z
  .object({
    brandId: z.string().uuid(),
    /** Present on the user-facing read only. */
    orgId: z.string().uuid().optional(),
    offerId: z.string().uuid(),
    /**
     * This OFFER's daily ceiling — the SUM of the campaign ceilings funding it.
     * `null` when this offer has NO ceiling, which is a different answer from a
     * ceiling of 0 (funded at nothing) and is never derived from it.
     */
    dailyBudgetCents: CentsStringSchema.nullable(),
    /** The latest of the ceilings funding this offer; null when it has none. */
    updatedAt: z.string().nullable(),
    /** The campaign ceilings that make up the figure above. */
    campaigns: z.array(CampaignDailyBudgetSchema),
  })
  .openapi("ReadBrandOfferDailyBudget");

export const ReadBrandLegDailyBudgetSchema = z
  .object({
    brandId: z.string().uuid(),
    /** Present on the user-facing read only. */
    orgId: z.string().uuid().optional(),
    /** features-service's canonical leg id, echoed back verbatim. */
    legKey: z.string(),
    /**
     * This LEG's daily ceiling - the SUM of the campaign ceilings funding it.
     * `null` when this leg has NO ceiling, which is a different answer from a
     * ceiling of 0 (funded at nothing) and is never derived from it.
     */
    dailyBudgetCents: CentsStringSchema.nullable(),
    /** The latest of the ceilings funding this leg; null when it has none. */
    updatedAt: z.string().nullable(),
    /** The campaign ceilings that make up the figure above. */
    campaigns: z.array(CampaignDailyBudgetSchema),
  })
  .openapi("ReadBrandLegDailyBudget");

export const ReadCampaignDailyBudgetsSchema = z
  .object({
    brandId: z.string().uuid(),
    /** Present on the user-facing read only. */
    orgId: z.string().uuid().optional(),
    /**
     * The brand-level daily budget — byte-identical to what
     * GET /internal/brands/{brandId}/daily-budget serves (null when never set).
     * The campaigns below add up to it.
     */
    dailyBudgetCents: CentsStringSchema.nullable(),
    /** One entry per (offer, leg, channel). Empty when nothing is funded per campaign. */
    campaigns: z.array(CampaignDailyBudgetSchema),
  })
  .openapi("ReadCampaignDailyBudgets");

export const ReadCampaignDailyBudgetSchema = z
  .object({
    brandId: z.string().uuid(),
    /** Present on the user-facing read only. */
    orgId: z.string().uuid().optional(),
    offerId: z.string().uuid(),
    legKey: z.string(),
    featureSlug: z.string(),
    /**
     * This campaign's ceiling. `null` when nothing funds it — a different
     * answer from 0 (funded at nothing), and never derived from it.
     */
    dailyBudgetCents: CentsStringSchema.nullable(),
    updatedAt: z.string().nullable(),
  })
  .openapi("ReadCampaignDailyBudget");

export const SetCampaignDailyBudgetRequestSchema = z
  .object({
    /** brand-service offer UUID. */
    offerId: z.string().uuid(),
    /** features-service's canonical leg id (legs[].legKey on GET /public/channels). */
    legKey: z.string().min(1),
    /** The acquisition channel's features-service feature slug. */
    featureSlug: z.string().min(1),
    /** Non-negative cents. 0 = not funding this campaign right now. */
    dailyBudgetCents: z.union([z.string(), z.number()]),
  })
  .openapi("SetCampaignDailyBudgetRequest");

export const SetCampaignDailyBudgetResponseSchema = z
  .object({
    brandId: z.string().uuid(),
    orgId: z.string().uuid(),
    offerId: z.string().uuid(),
    legKey: z.string(),
    featureSlug: z.string(),
    /** This campaign's ceiling after the write. */
    dailyBudgetCents: CentsStringSchema,
    updatedAt: z.string(),
    /** The brand-level daily budget after the write = the sum of every ceiling. */
    brandDailyBudgetCents: CentsStringSchema,
    /** Every campaign ceiling of the brand after the write. */
    campaigns: z.array(CampaignDailyBudgetSchema),
  })
  .openapi("SetCampaignDailyBudgetResponse");

// --- Public Stats ---

export const BillingGrowthRowSchema = z
  .object({
    period: z.string(),
    /** NET Stripe payments in this period + local promo credits granted in it. */
    credited_cents: CentsStringSchema,
    /** NET Stripe payments in this period. Returns are attributed to the period they happened in. */
    revenue_cents: CentsStringSchema,
    /**
     * Distinct accounts that PAID in this period, taken verbatim from
     * stripe-service. COVERS EVERY ACQUIRER it takes money through — NOT the
     * Stripe-only scope of `accounts_with_payment_method`, which counts saved
     * Stripe cards. These count who PAID, never who has a card on file; the two
     * populations differ substantially and neither contains the other.
     *
     * An account is the org, so an org paying on two acquirers in one period
     * counts once. Distinct counts, so they do NOT sum to
     * `total_paying_accounts` — an account paying every month is in every month.
     * A period carrying only promo credit has no payments and reports 0.
     */
    paying_accounts: z.number().int(),
    /**
     * Of `paying_accounts`, those with no settled payment on ANY acquirer before
     * this period — the numerator of a signup-to-paid conversion rate. Every
     * account is first-time in exactly one period per grain, so summing this
     * over all periods gives `total_paying_accounts`. A later refund never
     * un-counts a payer.
     */
    first_time_paying_accounts: z.number().int(),
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
    /**
     * Distinct accounts that have EVER paid, taken verbatim from stripe-service.
     * COVERS EVERY ACQUIRER it takes money through, which is deliberately NOT
     * the Stripe-only scope of `accounts_with_payment_method` above — an org
     * paying through a wallet or on the second acquirer holds no Stripe card and
     * is counted here.
     *
     * This is who PAID, a different question from who has a card on file. In
     * production the two figures differ and neither is a subset of the other, so
     * a consumer must not read one as the other.
     *
     * Equals the sum of `first_time_paying_accounts` over all buckets, on either
     * grain. Never a fallback zero: a count billing could not read fails the
     * whole endpoint with a 502.
     */
    total_paying_accounts: z.number().int(),
    /**
     * Every account's FIRST settled payment, unix SECONDS, ascending — one entry
     * per account that has ever paid, so `first_payment_times_unix.length`
     * reproduces `total_paying_accounts`. Taken verbatim from stripe-service;
     * this hop neither filters nor re-derives it.
     *
     * THE UNIT IS IN THE NAME because `Date.now()` is MILLISECONDS: a consumer
     * writing `t >= Date.now() - 30 * 86400 * 1000` against a seconds array
     * silently counts zero and renders a dash, which is precisely the false
     * alarm this array was introduced to kill. Every money field here already
     * carries its unit (`_cents`); this one did not.
     *
     * THIS is how a rolling window is answered exactly. The accounts that became
     * customers in the last N days are
     * `first_payment_times.filter(t => t >= nowUnixSeconds - N * 86400).length`.
     * Do NOT get that by summing `first_time_paying_accounts` over buckets:
     * those buckets are calendar months and weeks, a rolling window is anchored
     * on an instant and aligns to neither, and the bucket straddling its edge
     * carries payments on both sides of it — measured against production at 90
     * days, whole-bucket summing read 17 where the truth was 25.
     *
     * Same identity, same acquirer coverage (EVERY acquirer, not the Stripe-only
     * scope of `accounts_with_payment_method`) and same settled-only predicates
     * as `total_paying_accounts`, so the two can never tell different stories. A
     * payment with no resolvable org has no entry here, exactly as it has no
     * account in the counts. No money is published at this grain — only when
     * each account started paying.
     *
     * `null` when stripe-service served neither spelling — NEVER `[]`. An
     * unavailable list and an empty one are different facts: `[]` says nobody
     * has ever paid, and a consumer that cannot tell them apart renders "0 paid
     * users". Its absence never denies the rest of this payload: every money
     * figure here is computable without it, and failing the whole request for it
     * took down the public investor metrics page.
     */
    first_payment_times_unix: z.array(z.number().int()).nullable(),
    /**
     * DEPRECATED — read `first_payment_times_unix` instead.
     *
     * Byte-identical to it (same entries, same order, same `null`), kept for one
     * release because a live consumer still reads this name. The replacement
     * carries the unit its values are in (unix SECONDS), which this name did
     * not.
     */
    first_payment_times: z.array(z.number().int()).nullable(),
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
    "Cross-tenant aggregate billing statistics composed from stripe-service (paid balance) and local promo credits.\n\n" +
    "HOW MANY ACCOUNTS PAID rides the same buckets as how much they paid: `paying_accounts` and " +
    "`first_time_paying_accounts` on every monthly and weekly bucket, plus `total_paying_accounts` for the " +
    "platform. Two things a reader must not assume about them. ACQUIRER COVERAGE IS EVERY ACQUIRER " +
    "stripe-service takes money through, which is deliberately NOT the Stripe-only scope of " +
    "`accounts_with_payment_method` beside them. And they count who PAID, never who has a card on file: those " +
    "populations differ substantially in production and neither contains the other.\n\n" +
    "Taken from stripe-service verbatim — this hop forwards, it does not re-derive, so " +
    "`first_time_paying_accounts` summed over all buckets equals `total_paying_accounts` on either grain while " +
    "`paying_accounts` are distinct counts that do not sum. A count that cannot be read is never reported as " +
    "zero: it fails the endpoint with a 502.\n\n" +
    "A ROLLING WINDOW (last 30 days, last 90 days, since any instant) is answered EXACTLY from " +
    "`first_payment_times_unix` — every account's first settled payment in unix SECONDS, ascending, one entry " +
    "per account that has ever paid. Count the entries at or after your cutoff. THE UNIT IS IN THE NAME " +
    "because `Date.now()` is milliseconds, so comparing against a milliseconds cutoff silently counts zero. " +
    "`first_payment_times` is the DEPRECATED spelling of the same array, byte-identical, kept for one release. " +
    "Summing whole " +
    "`first_time_paying_accounts` buckets CANNOT answer it: those buckets are calendar months and weeks, a " +
    "rolling window aligns to neither, and the bucket straddling its edge holds payments on both sides " +
    "(measured against production at 90 days, whole-bucket summing read 17 where the truth was 25). The array " +
    "carries the same identity, acquirer coverage and settled-only predicates as the counts, and counting all " +
    "of it reproduces `total_paying_accounts`. Both spellings are `null` — never `[]` — when stripe-service " +
    "served neither: an unavailable list and an empty one are different facts, and `[]` would claim nobody has " +
    "ever paid. Their absence never denies the rest of this payload, which every money figure is computable " +
    "without.",
  responses: {
    200: {
      description: "Billing stats",
      content: {
        "application/json": { schema: PublicBillingStatsSchema },
      },
    },
    502: {
      description:
        "stripe-service unavailable, or its reply carried no paying-account counts. Missing first-payment " +
        "instants do NOT produce a 502 — both array fields go out as null and every other figure is served.",
      content: { "application/json": { schema: ErrorResponseSchema } },
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
  summary: "How this org's customer adds a card (historical name)",
  description:
    "Historical name for the card-setup descriptor now also served at POST /v1/accounts/card_setup. " +
    "Not every acquirer has a portal: the response names the MECHANISM (hosted_redirect | embedded_widget) " +
    "and carries only what a browser may hold.",
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
      description: "Card-setup descriptor",
      content: { "application/json": { schema: CardSetupResponseSchema } },
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
  path: "/v1/accounts/card_setup",
  summary: "What the browser needs to render this org's card form",
  description:
    "Org-scoped. Asks stripe-service how THIS org's acquirer saves a card and passes the descriptor " +
    "through without interpreting it: `hosted_redirect` (send the customer to `url`) or `embedded_widget` " +
    "(load `script_url`, initialise the SDK with the per-order PUBLIC `token`, mount the card field and pass " +
    "`save_payment_method_for` on submit). No merchant credential is ever included — card details are entered " +
    "in an iframe the acquirer hosts and never touch the page or this service. Nobody is charged for adding a card.",
  request: {
    headers: protectedHeaders,
    body: {
      content: {
        "application/json": { schema: CardSetupRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Card-setup descriptor",
      content: { "application/json": { schema: CardSetupResponseSchema } },
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
      description: "Card setup could not be described (stripe-service unavailable)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/accounts/saved_payment_method",
  summary: "Does this org have a saved, chargeable card?",
  description:
    "Org-scoped, read live from whichever acquirer holds the org's cards (never cached). THREE answers, kept " +
    "apart on purpose: 200 `{saved:true, method}` there is one; 200 `{saved:false, reason}` the acquirer answered " +
    "and there is none; 502 we could not ask at all. A caller that collapses the last two would either tell a " +
    "customer to re-enter a card we already hold, or arm a recurring charge off a timeout.",
  request: { headers: protectedHeaders },
  responses: {
    200: {
      description: "The acquirer answered — saved true or false",
      content: { "application/json": { schema: SavedPaymentMethodResponseSchema } },
    },
    404: {
      description: "Billing account not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Could not ask the acquirer — NOT the same as 'no card saved'",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/accounts/saved_payment_method",
  summary: "Stop holding this org's card",
  description:
    "Org-scoped, self-serve. TWO actions in one order only this service can put them in: what the org owes is " +
    "COLLECTED first, on the card that is about to go, under the same rule the card-change path uses (the collection " +
    "never gates what the customer came to do); then the card is removed whatever that collection did — charged, " +
    "declined, skipped or backed off. REFUSED FOR NOBODY: no balance, no debt state, no card state and no failed " +
    "charge blocks it, and an org with no card is a 200. Nothing is forgiven — what is owed stays owed and stays " +
    "owned by the existing sweeps and the uncollectable-debt flag. Auto-topup is disarmed, because a threshold that " +
    "can never fire again is a configuration that lies. 502 means the removal could not be performed and must be " +
    "retried — never a silent success.",
  request: { headers: protectedHeaders },
  responses: {
    200: {
      description: "The card is no longer held",
      content: {
        "application/json": { schema: RemoveSavedPaymentMethodResponseSchema },
      },
    },
    404: {
      description: "Billing account not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "The removal could not be performed — retry, the detach is safe to repeat",
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
    "WELCOME GIFT (onboarding): send the FULL daily budget as topup_amount_cents with apply_welcome_gift=true and billing takes the welcome gift the org holds off it as a standard discount line (e.g. $68 budget, -$30 gift, $38 due). The credit that lands is what is actually paid; the gift was granted at signup, so spendable = budget. Without apply_welcome_gift the charge is exactly topup_amount_cents and carries no discount. 409 `welcome_discount_not_first_payment` when the org has already paid; 409 `welcome_gift_covers_budget` when budget <= gift (use mode='setup'); 502 `welcome_discount_not_applied` when the acquirer did not charge exactly budget - gift. " +
    "MATCH-cohort orgs whose free credit is not yet fully granted see a notice that the rest is coming. " +
    "User-entered promotion codes are NOT offered (allow_promotion_codes is never set).",
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
    409: {
      description: "apply_welcome_gift refused: `welcome_discount_not_first_payment` or `welcome_gift_covers_budget` (body carries `code` + `welcome_gift_cents`)",
      content: { "application/json": { schema: WelcomeDiscountRefusalSchema } },
    },
    502: {
      description: "stripe-service unavailable, or `welcome_discount_not_applied`",
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
  method: "post",
  path: "/internal/accounts/by-org/{orgId}/trial-seed",
  summary: "Seed free credit on an organisation that has not signed up",
  description:
    "Puts the whole live welcome amount of credit on an org that exists but has no " +
    "identity-provider identity yet, so the unauthenticated setup a visitor walks " +
    "through can do its metered work. Recorded under its OWN ledger key (trial_seed), " +
    "never as the welcome gift, and never surfaced to the visitor. What caps the " +
    "spend is this credit plus the affordability gate this service already enforces " +
    "— there is no counter and no new threshold. Idempotent: seeding twice does not " +
    "double the seed. 409 when the org already holds the welcome gift (it has signed " +
    "up, or spent before it was seeded), because seeding it would take its free " +
    "credit past the welcome amount. The later signup settle then grants the " +
    "remainder (welcome − seeded), which is 0 for an org seeded this way.",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Org seeded (or already was)",
      content: { "application/json": { schema: TrialSeedResponseSchema } },
    },
    400: {
      description: "orgId is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Org already holds the welcome gift",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "trial_seed ledger key missing (migration 0046 not applied)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/accounts/by-org/{orgId}/signup",
  summary: "Land an organisation's free credit on exactly the welcome amount",
  description:
    "Called when an org signs up. An org with no trial seed receives the whole " +
    "welcome offer, exactly as it always has. A seeded org receives the REMAINDER " +
    "(welcome − seeded), so its TOTAL free credit is the welcome amount rather than " +
    "the welcome amount plus its seed; unspent seed is never clawed back. Idempotent " +
    "— a replay grants nothing. The welcome is once per PERSON: send the person who " +
    "signed up as `x-user-id` (client-service internal user id). When that person " +
    "already received the welcome on another org, this org gets none, its own " +
    "free-credit offer is zero and `welcomeReceivedElsewhere` is true. Without " +
    "`x-user-id` the welcome is checked per org only (historical behaviour).",
  request: {
    headers: internalHeaders.extend({
      "x-user-id": z
        .string()
        .uuid()
        .optional()
        .openapi({
          description:
            "The person who signed up (client-service internal user id). Makes the welcome once per person.",
        }),
    }),
    params: z.object({ orgId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Free credit settled on the welcome amount",
      content: { "application/json": { schema: SignupWelcomeResponseSchema } },
    },
    400: {
      description: "orgId (or x-user-id when sent) is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "welcome ledger key missing",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
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
    "No cross-service fan-out. Idempotent: no rows for the org is still success. " +
    "Deleting an org billing never held an account for is a pure no-op reported as " +
    "billingAccountExisted=false: it never creates a billing account, a Stripe " +
    "customer, or runs a welcome evaluation.",
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
  path: "/internal/accounts/by-org/{orgId}/org-creation-bonus",
  summary: "Grant a newly created organization its one-time creation bonus",
  description:
    "Every newly created organization receives a small free credit ONCE ($5 today; " +
    "billing owns the amount), so its first setup steps can run. Not tied to the " +
    "welcome gift: granted even when the person who created the org already received " +
    "a welcome on another org, and never counted against the welcome offer. It appears " +
    "in the org's grants ledger (GET /v1/credits/grants) under reason=org_creation_bonus. " +
    "Idempotent per org: a retry grants nothing and returns alreadyGranted=true. No " +
    "body. Creates no billing account and no Stripe customer.",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Bonus granted (or already granted — idempotent)",
      content: { "application/json": { schema: OrgCreationBonusResponseSchema } },
    },
    400: {
      description: "orgId is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "org_creation_bonus seed missing or database failure",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/credits/grant",
  summary: "Grant platform-issued credit to an org (no user-redeemable code required)",
  description:
    "Inserts a local_promos row for an org under a reserved platform reason. The " +
    "reason set is CLOSED — a caller can never supply an arbitrary one. " +
    "invite_reward / invite_welcome are ONE-SHOT: idempotent on (orgId, reason), " +
    "and they do not accept a completionId. product_task_completed RECURS (the same " +
    "product task comes round for the same org roughly every month, forever), so it " +
    "STACKS: it requires the caller's own completionId, a fresh one grants again and " +
    "the same one retried never pays twice. It appears in the org's grants ledger " +
    "under reason=product_task_completed, distinct from the invite and staff grants. " +
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
  method: "post",
  path: "/v1/credits/debit",
  summary: "Staff debit: take credit off an org's balance, with a note",
  description:
    "The mirror of POST /v1/credits/grant. Records a staff debit for x-org-id with a " +
    "mandatory note; x-email (required) is recorded as debitedBy. The debit lowers the " +
    "spendable and displayed balance exactly like spend, and is shown as its own line " +
    "(debited_cents on GET /v1/accounts, GET /v1/credits/debits), never as campaign usage. " +
    "Never charges a card. The same idempotencyKey retried debits once; the same key with " +
    "a different amount is refused (409).",
  request: {
    headers: z.object({
      "x-api-key": z.string(),
      "x-org-id": z.string().uuid(),
      "x-email": z.string().openapi({
        description: "Staff email behind the debit; recorded as debitedBy. Required.",
      }),
    }),
    body: { content: { "application/json": { schema: StaffDebitRequestSchema } } },
  },
  responses: {
    200: {
      description: "Debit recorded (or already recorded for this idempotencyKey)",
      content: { "application/json": { schema: StaffDebitResponseSchema } },
    },
    400: {
      description: "Invalid body, missing note, missing x-email, or missing/invalid x-org-id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "idempotencyKey already used for a different amount on this org",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Debit recorded but stripe-service or runs-service unavailable (balance compose failed)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/credits/debits",
  summary: "List this org's staff debits",
  description: "Every staff debit for x-org-id, newest first, with note and debitedBy.",
  request: {
    headers: z.object({
      "x-api-key": z.string(),
      "x-org-id": z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "Org debits",
      content: { "application/json": { schema: StaffDebitsListResponseSchema } },
    },
    400: {
      description: "Missing or invalid x-org-id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/credits/debits",
  summary: "List every org's staff debits (platform oversight ledger)",
  description: "All staff debits across orgs, newest first. x-api-key only.",
  request: { headers: z.object({ "x-api-key": z.string() }) },
  responses: {
    200: {
      description: "All debits",
      content: { "application/json": { schema: StaffDebitsListResponseSchema } },
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
  method: "post",
  path: "/internal/payment-methods/lost",
  summary: "An org's last chargeable payment method is gone",
  description:
    "stripe-service reports the event; billing decides what it means. An org with a negative " +
    "balance and no chargeable card now carries a debt we cannot collect: it is flagged on its " +
    "depletion episode, the customer is emailed that a card is required (with the amount owed), " +
    "staff are notified, and campaigns stop through the existing credit-line floor. An org that " +
    "owes nothing, or still has a card, is a no-op — so a false alarm is free. Idempotent: the " +
    "notification is claimed once per episode, so a redelivered event sends nothing.",
  request: {
    headers: internalHeaders,
    body: {
      content: {
        "application/json": { schema: PaymentMethodLostRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "What the org's debt state is now",
      content: {
        "application/json": { schema: PaymentMethodLostResponseSchema },
      },
    },
    400: {
      description: "orgId missing or not a UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Could not evaluate the org's balance",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/unpaid-debts",
  summary: "Every org currently owing money we cannot collect",
  description:
    "The staff view of unpaid debt. One row per org whose balance is negative and whose last " +
    "chargeable card is gone, with the amount owed (frozen when the debt was flagged and " +
    "refreshed hourly while it persists). A row leaves this list when a card comes back or the " +
    "balance is restored.",
  request: {
    headers: internalHeaders,
  },
  responses: {
    200: {
      description: "Unpaid debts",
      content: { "application/json": { schema: UnpaidDebtsResponseSchema } },
    },
    502: {
      description: "Read failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/accounts/by-org/{orgId}/payment-stopped-periods",
  summary: "When this org's payment had stopped, as periods",
  description:
    "Every stretch of time during which this org was not paying — a failed card or credit " +
    "gone — as periods with a beginning and an end (endedAt null while the org is still in " +
    "one). Two sources, one per half: CREDIT GONE is a credit-depletion episode (it opens " +
    "when the balance falls past the org's credit-line floor and closes when a real recharge " +
    "lands), and a FAILED CARD is an open failed reload streak (the bank refused and the " +
    "spaced retry schedule is still walking its rungs; it ends on a succeeded reload or when " +
    "credited moves). An org blocked by a refused card while its balance is still inside its " +
    "credit-line floor opens no episode at all, so the second source is not a refinement of " +
    "the first. Overlapping stretches are merged, so a day is never described twice. PAST " +
    "failed streaks are not recorded — the attempts row is overwritten in place — so only the " +
    "OPEN one is expressible. " +
    "Service-to-service read with x-api-key only, orgId in the path — no x-org-id / x-user-id " +
    "and no sentinel identity. Pure read. " +
    "recordBeginsAt is the earliest instant either source recorded fleet-wide: a day before it is NOT " +
    "RECORDED, and the absence of a period there is not evidence that payment was on. An " +
    "episode opens on an authorize carrying campaign activity, so a period means payment had " +
    "stopped while the org was trying to spend.",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Payment-stopped periods, oldest first",
      content: {
        "application/json": { schema: PaymentStoppedPeriodsResponseSchema },
      },
    },
    400: {
      description: "orgId is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Read failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/v1/accounts/acquirer",
  summary: "Declare that this NEW org pays through Revolut",
  description:
    "Call right after the org is created and BEFORE any card setup or checkout. Pins the org to Revolut and " +
    "creates its Revolut customer from the creator's email and name. Afterwards POST /v1/accounts/card_setup " +
    "answers `mode: embedded_widget`, and POST /v1/checkout-sessions with ui_mode='embedded' answers the Revolut " +
    "widget (`mode: embedded_widget`) instead of a Stripe client_secret. Idempotent (declaring again is a no-op). " +
    "409 when the org already holds a chargeable card on another acquirer: a saved card cannot move. " +
    "Orgs that never call this stay on Stripe, unchanged.",
  request: {
    headers: protectedHeaders,
    body: { content: { "application/json": { schema: DeclareAcquirerRequestSchema } } },
  },
  responses: {
    200: {
      description: "The org is pinned",
      content: { "application/json": { schema: DeclareAcquirerResponseSchema } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: {
      description: "The org already holds a chargeable card on another acquirer",
      content: { "application/json": { schema: DeclareAcquirerRefusalSchema } },
    },
    502: { description: "stripe-service could not be asked", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/accounts/payment_mode",
  summary: "Read this org's payment mode (prepaid | postpaid)",
  request: {
    headers: protectedHeaders,
  },
  responses: {
    200: {
      description: "Current payment mode",
      content: { "application/json": { schema: PaymentModeResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/v1/accounts/payment_mode",
  summary: "Choose how this org pays (prepaid | postpaid)",
  description:
    "Switch between prepaid and postpaid. Idempotent (same mode = no-op, nothing charged). " +
    "POSTPAID -> PREPAID with a negative balance: what is owed is charged to the saved card FIRST; " +
    "if it cannot be (no card, declined, below the minimum charge) the switch does NOT happen and " +
    "409 names why. Becoming prepaid turns auto top-up ON (the customer can turn it off). " +
    "PREPAID -> POSTPAID: postpaid rules apply from then on (a card becomes required).",
  request: {
    headers: protectedHeaders,
    body: { content: { "application/json": { schema: SetPaymentModeRequestSchema } } },
  },
  responses: {
    200: {
      description: "Payment mode after the switch",
      content: { "application/json": { schema: SetPaymentModeResponseSchema } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: {
      description: "Switch to prepaid refused: the outstanding balance could not be settled",
      content: { "application/json": { schema: PaymentModeRefusalSchema } },
    },
    502: { description: "Could not read the balance or reach the card acquirer", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/accounts/by-org/{orgId}/payment-mode",
  summary: "Staff/service read of an org's payment mode",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Current payment mode",
      content: { "application/json": { schema: PaymentModeResponseSchema } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No billing account for this org", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/internal/accounts/by-org/{orgId}/payment-mode",
  summary: "Staff/service: set an org's payment mode",
  description:
    "Switch between prepaid and postpaid. Idempotent (same mode = no-op, nothing charged). " +
    "POSTPAID -> PREPAID with a negative balance: what is owed is charged to the saved card FIRST; " +
    "if it cannot be (no card, declined, below the minimum charge) the switch does NOT happen and " +
    "409 names why. Becoming prepaid turns auto top-up ON (the customer can turn it off). " +
    "PREPAID -> POSTPAID: postpaid rules apply from then on (a card becomes required). " +
    "-> SUBSCRIPTION (staff only): what is owed is settled first exactly as for prepaid, auto " +
    "top-up is DISARMED (a subscription org never reloads); the org then starts its subscription " +
    "from the dashboard. Leaving subscription does not cancel the Stripe subscription.",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
    body: { content: { "application/json": { schema: StaffSetPaymentModeRequestSchema } } },
  },
  responses: {
    200: {
      description: "Payment mode after the switch",
      content: { "application/json": { schema: SetPaymentModeResponseSchema } },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: {
      description: "Switch to prepaid refused: the outstanding balance could not be settled",
      content: { "application/json": { schema: PaymentModeRefusalSchema } },
    },
    502: { description: "Could not read the balance or reach the card acquirer", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No billing account for this org", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/accounts/by-org/{orgId}/charge-schedule",
  summary: "Every automatic charge billing expects for this org over a horizon",
  description:
    "Replays billing's own charging rules forward from the payment outlook's decision: a " +
    "floor reload when balance minus the next run's estimate falls below the credit-line " +
    "floor (one tier unit), and the month-end settle of a NEGATIVE balance to exactly zero " +
    "(below the 50-cent acquirer minimum it rolls), whichever comes first, re-deriving the " +
    "tier after each charge. The projection carries the MEASURED realized burn forward at a " +
    "constant rate, never the configured ceiling. Same states as the payment outlook: " +
    "no_autopay and charge_blocked (without a retry date) return no events; a refused card " +
    "returns ONE event at its next retry rung and nothing after it, because whether the bank " +
    "says yes is not billing's to predict; unknown (unmeasured burn) returns the month-end " +
    "settle only when the org already owes, with a null amount. Every date is a charge " +
    "ATTEMPT, never a payment. horizonDays defaults to 90 (1 to 366). " +
    "Service-to-service read with x-api-key only, orgId in the path. Pure read: charges " +
    "nothing, reserves nothing, writes nothing.",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
    query: z.object({ horizonDays: z.string().optional() }),
  },
  responses: {
    200: {
      description: "The expected charges, oldest first",
      content: { "application/json": { schema: ChargeScheduleResponseSchema } },
    },
    400: {
      description: "orgId is not a UUID, or horizonDays is not an integer from 1 to 366",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No billing account for this org",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "stripe-service or runs-service unreachable",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/accounts/by-org/{orgId}/payment-outlook",
  summary: "When this org will next be charged, and if never, why not",
  description:
    "Composes what billing already knows into one answer: the spendable balance and the " +
    "postpaid credit-line floor, the retry schedule for a card the bank is refusing, the " +
    "month-end settle date, this org's realized spend per day, and its configured versus " +
    "running daily ceilings. Nothing new is stored and no new rule is introduced — every " +
    "input is already the source of truth for the thing it describes. " +
    "THREE PROPERTIES A CONSUMER MUST NOT COLLAPSE. (1) nextChargeAttemptAt is when billing " +
    "will PRESENT the card, never when the customer will pay: the orgs already past their " +
    "floor are typically the ones whose card is being refused. (2) state no_autopay carries " +
    "NO date, because such an org is never charged automatically — it runs out and stops; " +
    "that was half the spending orgs when this shipped, so rendering a date for every org is " +
    "wrong about half of them. An org with NO chargeable payment method (never added one, " +
    "or removed it) is charge_blocked with blockedReason no_chargeable_card, read from the " +
    "CURRENT state: a card change (new card attached, old detached) is not blocked, and " +
    "adding a card clears it on the next read. (3) realizedDailyBurnCents is measured spend and " +
    "configuredDailyBudgetCents is a permission; measured utilisation ran 4% to 146%, so the " +
    "ceiling is not even an upper bound and must not be substituted for the burn. " +
    "A figure that cannot be established honestly is null with a named reason, never zero. " +
    "Service-to-service read with x-api-key only, orgId in the path — no x-org-id / x-user-id " +
    "and no sentinel identity. Pure read: it opens no episode, charges nothing, and changes " +
    "no retry state. No discount is applied to the floor or the ceilings — both are " +
    "configuration, and the per-org usage modifier applies to charges only.",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "What billing expects to charge this org, and when",
      content: {
        "application/json": { schema: PaymentOutlookResponseSchema },
      },
    },
    400: {
      description: "orgId is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No billing account for this org",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Could not read the org's balance or its realized spend",
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
  method: "get",
  path: "/internal/brands/{brandId}/daily-budget/by-day",
  summary: "What daily amount was in force for this brand on each past UTC day",
  description:
    "Replays the caller org's append-only daily-budget change log to answer what amount " +
    "was IN FORCE for this brand on each UTC day of a range, oldest day first. The amount " +
    "for a day is the last change strictly before the next day's 00:00Z, i.e. the value the " +
    "day finished on. Service-to-service read with x-api-key plus x-org-id, same auth as the " +
    "current-value and history reads. " +
    "GRAIN: the BRAND total, the finest grain billing genuinely records over time — the " +
    "change log carries the brand-level figure on every write (per-campaign writes " +
    "included), while the campaign ceilings are upserted in place " +
    "with no change log of their own, so a past-day answer there would be invented. " +
    "A day before the first recorded change is state not_recorded with a null amount — never " +
    "0, and never the current value back-dated; a recorded \"0\" is a brand the customer " +
    "deliberately defunded and is a different fact. Today is allowed (it answers with the " +
    "amount in force right now); a future day is refused.",
  request: {
    headers: internalOrgHeaders,
    params: z.object({ brandId: z.string().uuid() }),
    query: z.object({
      from: z.string().openapi({ description: "First UTC day, YYYY-MM-DD (inclusive)." }),
      to: z.string().openapi({ description: "Last UTC day, YYYY-MM-DD (inclusive, not in the future)." }),
    }),
  },
  responses: {
    200: {
      description: "One entry per UTC day of the range, oldest first",
      content: {
        "application/json": { schema: ReadBrandDailyBudgetByDaySchema },
      },
    },
    400: {
      description:
        "brandId or x-org-id is not a valid UUID, x-org-id is missing, a date is " +
        "missing/malformed, to is earlier than from, the range is too long, or to is a future day",
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
        "This brand is funded per campaign, so its daily budget is DERIVED " +
        "(the sum of the campaign ceilings). Write the per-campaign route instead.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/offers/{offerId}/daily-budget",
  summary: "Read ONE offer's daily ceiling for a brand",
  description:
    "Returns what the caller org has funded ONE offer at — the SUM of the campaign " +
    "ceilings covering it across every leg and acquisition channel it is sold " +
    "through — plus those campaign ceilings, so a caller never enumerates the " +
    "offer's campaigns nor adds anything up. " +
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
  method: "get",
  path: "/internal/brands/{brandId}/legs/{legKey}/daily-budget",
  summary: "Read ONE leg's daily ceiling for a brand",
  description:
    "Returns what the caller org has funded ONE LEG at — the SUM of the campaign " +
    "ceilings covering it across every acquisition channel and offer it is sold " +
    "through — plus those campaign ceilings, so a caller never enumerates anything " +
    "nor adds anything up. A campaign is (offer, leg, acquisition channel), so " +
    "this is the money that paces one campaign, read on the same key the campaign " +
    "is keyed on. `legKey` is features-service's canonical leg id (published on its " +
    "GET /public/channels as legs[].legKey) and is carried OPAQUE — billing never " +
    "validates or parses it. A ceiling written before legs existed (legKey null) " +
    "counts towards this leg only while it is the brand's SOLE named one, which is " +
    "why a leg that is a brand's only one answers exactly the brand-wide total. " +
    "A leg with NO ceiling returns dailyBudgetCents: null — a different answer from " +
    "a ceiling of 0, and never derived from it. Service-to-service read with " +
    "x-api-key plus x-org-id.",
  request: {
    headers: internalOrgHeaders,
    params: z.object({
      brandId: z.string().uuid(),
      legKey: z.string().min(1),
    }),
  },
  responses: {
    200: {
      description: "This leg's ceiling (null when it has none) + its breakdown",
      content: {
        "application/json": { schema: ReadBrandLegDailyBudgetSchema },
      },
    },
    400: {
      description:
        "brandId or x-org-id is not a valid UUID, x-org-id is missing, or legKey is empty",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/brands/{brandId}/legs/{legKey}/daily-budget",
  summary: "Read one leg's daily ceiling (user, via the gateway)",
  description:
    "Same answer as the internal read, for the user's own org — a campaign screen " +
    "reads the ceiling it paces its spend against. A leg with no ceiling returns " +
    "dailyBudgetCents: null.",
  request: {
    headers: protectedHeaders,
    params: z.object({
      brandId: z.string().uuid(),
      legKey: z.string().min(1),
    }),
  },
  responses: {
    200: {
      description: "This leg's ceiling (null when it has none) + its breakdown",
      content: {
        "application/json": { schema: ReadBrandLegDailyBudgetSchema },
      },
    },
    400: {
      description: "Invalid brandId, empty legKey, or missing org headers",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Move a brand's billing history to another org; its money stays",
  description:
    "Moves the brand's daily budget, its change history and its per-campaign ceilings from sourceOrgId " +
    "to targetOrgId (rewriting the brand id when targetBrandId is given). Moves NO money: credits and " +
    "Stripe customers stay with the org that holds them. runs-service moves the brand's cost rows in the " +
    "same fan-out, so billing first drives runs-service's own (idempotent) transfer, reads what it moved, " +
    "and records it in brand_transfers; balance composition leaves that spend on the source org and off the " +
    "target org, so BOTH balances (spendable and displayed) are unchanged to the cent. balanceAdjustment is " +
    "that audit record. Idempotent: a re-run moves nothing and leaves the record as is.",
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
    409: {
      description: "The target org already holds a budget or ceiling for the brand, or source == target. Nothing moved.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "runs-service could not move the brand or say what it moved. Nothing written.",
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

export const MissionStatusChangedRequestSchema = z
  .object({
    campaignId: z.string().uuid(),
    featureSlug: z.string().min(1).nullable(),
    offerId: z.string().uuid().nullable(),
    legKey: z.string().min(1).nullable(),
    fromStatus: z.string().min(1).nullable(),
    toStatus: z.string().min(1),
  })
  .openapi("MissionStatusChangedRequest");

registry.registerPath({
  method: "post",
  path: "/internal/brands/{brandId}/mission-status-changed",
  summary: "A person paused or restarted a mission: email staff",
  description:
    "campaign-service calls this after a person's status write has committed. " +
    "billing composes the SAME staff email as a budget change (event " +
    "`brand_daily_budget_changed`): the mission and its move, then the daily " +
    "total, reactive caps and paused missions as they stand after the move. " +
    "Only `ongoing` <-> `stopped` moves send; anything else answers notified:false. " +
    "The email is sent in the background; this answers 202 before it goes out. " +
    "Headers: x-api-key, x-org-id; x-user-id, x-run-id and x-email when known.",
  request: {
    headers: internalOrgHeaders,
    params: z.object({ brandId: z.string().uuid() }),
    body: { content: { "application/json": { schema: MissionStatusChangedRequestSchema } } },
  },
  responses: {
    202: {
      description: "Accepted; `notified` says whether an email will be sent",
      content: {
        "application/json": {
          schema: z.object({ notified: z.boolean(), move: z.enum(["paused", "restarted"]).nullable() }),
        },
      },
    },
    400: {
      description: "Invalid brandId, x-org-id or body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const campaignQuery = z.object({
  offerId: z.string().uuid(),
  legKey: z.string().min(1),
  featureSlug: z.string().min(1),
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/campaign-budgets",
  summary: "Read every campaign daily ceiling of a brand",
  description:
    "One entry per campaign — (offer, leg, acquisition channel). The entries add " +
    "up to `dailyBudgetCents`, which is byte-identical to the brand-level read. " +
    "Service-to-service read with x-api-key plus x-org-id.",
  request: {
    headers: internalOrgHeaders,
    params: z.object({ brandId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Every campaign ceiling + the brand total",
      content: { "application/json": { schema: ReadCampaignDailyBudgetsSchema } },
    },
    400: {
      description: "Invalid brandId or x-org-id",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/brands/{brandId}/campaign-budgets",
  summary: "Read every campaign daily ceiling of a brand (user, via the gateway)",
  description: "Same answer as the internal read, for the user's own org.",
  request: {
    headers: protectedHeaders,
    params: z.object({ brandId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Every campaign ceiling + the brand total",
      content: { "application/json": { schema: ReadCampaignDailyBudgetsSchema } },
    },
    400: {
      description: "Invalid brandId or missing org headers",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/campaign-budget",
  summary: "Read ONE campaign's daily ceiling",
  description:
    "A campaign is (offer x leg x acquisition channel); all three are required. " +
    "Answers the SUM of the ceilings that are this campaign's money. A ceiling " +
    "written before offers (or legs) existed counts only while " +
    "the brand names no other offer (the channel no other leg). Nothing funds it -> " +
    "dailyBudgetCents: null, never 0. x-api-key plus x-org-id.",
  request: {
    headers: internalOrgHeaders,
    params: z.object({ brandId: z.string().uuid() }),
    query: campaignQuery,
  },
  responses: {
    200: {
      description: "This campaign's ceiling (null when nothing funds it)",
      content: { "application/json": { schema: ReadCampaignDailyBudgetSchema } },
    },
    400: {
      description: "Invalid brandId / x-org-id, or a missing offerId, legKey or featureSlug",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/brands/{brandId}/campaign-budget",
  summary: "Read ONE campaign's daily ceiling (user, via the gateway)",
  description: "Same answer as the internal read, for the user's own org.",
  request: {
    headers: protectedHeaders,
    params: z.object({ brandId: z.string().uuid() }),
    query: campaignQuery,
  },
  responses: {
    200: {
      description: "This campaign's ceiling (null when nothing funds it)",
      content: { "application/json": { schema: ReadCampaignDailyBudgetSchema } },
    },
    400: {
      description: "Invalid brandId, missing org headers, or an incomplete campaign address",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "put",
  path: "/v1/brands/{brandId}/campaign-budget",
  summary: "Set ONE campaign's daily ceiling",
  description:
    "States the ceiling of one campaign — (offer, leg, acquisition channel) — and " +
    "leaves every other campaign untouched. Ceilings that were this campaign's money " +
    "(including a pre-offer or pre-leg one it resolves to) are CONSOLIDATED into one " +
    "row carrying the new amount; when none exists a ceiling is opened. 0 is legal. A " +
    "funded channel below its published daily floor is refused (400), judged on the " +
    "channel's total across the brand; a channel already funded below its floor may " +
    "be kept or raised. The brand's daily budget is the SUM of every ceiling.",
  request: {
    headers: protectedHeaders,
    params: z.object({ brandId: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: SetCampaignDailyBudgetRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "This campaign's ceiling + every campaign ceiling + the brand total",
      content: {
        "application/json": { schema: SetCampaignDailyBudgetResponseSchema },
      },
    },
    400: {
      description:
        "Invalid address or amount, an unknown acquisition channel, or a funded channel below its floor",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "The acquisition channels' published terms could not be read",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Brand global sales budget -----------------------------------------------

const brandIdParam = z.object({ brandId: z.string().uuid() });

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/sales-budget",
  summary: "Read a brand's funding mode and global sales budget",
  description:
    "Service-to-service read (x-api-key + x-org-id). mode is global when the brand stated ONE " +
    "daily sales budget (dailyBudgetCents), campaigns when every campaign is paced on its own " +
    "ceiling (dailyBudgetCents null), items when the brand budgets each campaign (items[]: one row " +
    "per offer x leg x channel, period day|month, a monthly budget carrying the plan's current " +
    "period, a reactive one being a MAX; outranks global). billing stores and serves; campaign-service " +
    "spends, and owns each campaign's on/off.",
  request: { headers: internalOrgHeaders, params: brandIdParam },
  responses: {
    200: { description: "Mode and amount", content: { "application/json": { schema: BrandSalesBudgetSchema } } },
    400: { description: "Invalid brandId or x-org-id", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/sales-budget/history",
  summary: "Every state and clear of a brand's global sales budget, oldest first",
  request: { headers: internalOrgHeaders, params: brandIdParam },
  responses: {
    200: { description: "History", content: { "application/json": { schema: BrandSalesBudgetHistorySchema } } },
    400: { description: "Invalid brandId or x-org-id", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/brands/{brandId}/sales-budget",
  summary: "Read this brand's funding mode and global sales budget",
  request: { headers: protectedHeaders, params: brandIdParam },
  responses: {
    200: { description: "Mode and amount", content: { "application/json": { schema: BrandSalesBudgetSchema } } },
    400: { description: "Invalid brandId", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/brands/{brandId}/sales-budget/history",
  summary: "Every state and clear of this brand's global sales budget, oldest first",
  request: { headers: protectedHeaders, params: brandIdParam },
  responses: {
    200: { description: "History", content: { "application/json": { schema: BrandSalesBudgetHistorySchema } } },
    400: { description: "Invalid brandId", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/v1/brands/{brandId}/sales-budget",
  summary: "State the brand's ONE daily sales budget (global mode)",
  description:
    "The brand enters global mode: campaign-service allocates this amount to the best-return " +
    "sales path. Non-negative (0 legal). The campaign ceilings are NOT touched, and while it is " +
    "stated the brand's daily budget (GET /internal/brands/{brandId}/daily-budget) answers this amount.",
  request: {
    headers: protectedHeaders,
    params: brandIdParam,
    body: { content: { "application/json": { schema: SetBrandSalesBudgetRequestSchema } } },
  },
  responses: {
    200: { description: "Stated", content: { "application/json": { schema: SetBrandSalesBudgetResponseSchema } } },
    400: { description: "Invalid brandId or dailyBudgetCents", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/brands/{brandId}/sales-budget",
  summary: "Clear the brand's global sales budget (back to campaign ceilings)",
  description: "Idempotent: a brand already in campaigns mode answers cleared: false.",
  request: { headers: protectedHeaders, params: brandIdParam },
  responses: {
    200: { description: "Cleared", content: { "application/json": { schema: ClearBrandSalesBudgetResponseSchema } } },
    400: { description: "Invalid brandId", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// --- Revenue: recurring (DRR/MRR/ARR), one-off, cash flow (lib/revenue) ---

const RevenueClassSchema = z.enum(["recurring", "one_off", "none"]);
const RevenueClassReasonSchema = z.enum([
  "postpaid_chargeable_card",
  "prepaid_auto_topup",
  "prepaid_no_auto_topup",
  "prepaid_no_chargeable_card",
  "postpaid_no_chargeable_card",
  "postpaid_charge_retries_exhausted",
  "postpaid_idle",
  "prepaid_auto_topup_idle",
  "prepaid_balance_spent",
  "subscription",
  "subscription_trialing",
  "subscription_canceling",
  "subscription_paused",
  "subscription_payment_failed",
  "subscription_ended",
  "subscription_not_started",
]);
const DailyBudgetUnknownReasonSchema = z.enum([
  "campaign_service_unconfigured",
  "campaign_service_unavailable",
  "campaign_recurrence_unknown",
]);

export const RevenueSubscriptionSchema = z
  .object({
    /** The brand x offer the plan pays for; null on a plan not attributed yet. */
    brandId: z.string().uuid().nullable(),
    offerId: z.string().uuid().nullable(),
    status: z.string(),
    /** The plan we collect each month: a recurring subscription's MRR. */
    monthlyAmountCents: z.number().int(),
    cancelAtPeriodEnd: z.boolean(),
    trialEndsAt: z.string().nullable(),
    currentPeriodEnd: z.string(),
  })
  .openapi("RevenueSubscription");

export const OneOffRevenueSchema = z
  .object({
    remainingCents: z.string(),
    dailyPaceCents: z.string().nullable(),
    runOutAt: z.string().nullable(),
    runOutUnknownReason: z
      .enum([
        "campaign_service_unconfigured",
        "campaign_service_unavailable",
        "campaign_recurrence_unknown",
        "no_proactive_spend",
      ])
      .nullable(),
  })
  .openapi("OneOffRevenue");

export const ProjectedRevenueSchema = z
  .object({
    horizonDays: z.number().int(),
    recurringCents: z.string().nullable(),
    oneOffCents: z.string().nullable(),
    totalCents: z.string().nullable(),
  })
  .openapi("ProjectedRevenue");

export const RevenueBrandLineSchema = z
  .object({
    brandId: z.string(),
    mode: z.enum(["global", "campaigns", "brand_scalar"]),
    configuredDailyBudgetCents: z.string(),
    proactiveDailyBudgetCents: z.string().nullable(),
    unknownReason: DailyBudgetUnknownReasonSchema.nullable(),
  })
  .openapi("RevenueBrandLine");

export const RevenueCampaignLineSchema = z
  .object({
    campaignId: z.string(),
    brandId: z.string().nullable(),
    offerId: z.string().nullable(),
    legKey: z.string().nullable(),
    featureSlug: z.string().nullable(),
    running: z.boolean(),
    kind: z.enum(["proactive", "reactive"]).nullable(),
    audience: z.enum(["available", "exhausted", "not_recorded"]),
    recurring: z.boolean().nullable(),
    recurringUnknownReason: z.string().nullable(),
    dailyBudgetCents: z.string().nullable(),
    counted: z.boolean(),
  })
  .openapi("RevenueCampaignLine");

const revenueCore = {
  orgId: z.string().uuid(),
  paymentMode: PaymentModeSchema,
  revenueClass: RevenueClassSchema,
  classReason: RevenueClassReasonSchema,
  chargeableCard: z.boolean(),
  autoTopupEnabled: z.boolean(),
  balanceCents: z.string(),
  proactiveDailyBudgetCents: z.string().nullable(),
  proactiveDailyBudgetUnknownReason: DailyBudgetUnknownReasonSchema.nullable(),
  /** Recurring orgs: the proactive daily budget; others "0"; null when unknown. */
  drrCents: z.string().nullable(),
  mrrCents: z.string().nullable(),
  arrCents: z.string().nullable(),
  oneOff: OneOffRevenueSchema.nullable(),
  /** The PRIMARY plan (the oldest live one). */
  subscription: RevenueSubscriptionSchema.nullable(),
  /** Every plan of the org (one per brand x offer); MRR = the sum of the active ones with no cancel pending. */
  subscriptions: z.array(RevenueSubscriptionSchema),
  projections: z.array(ProjectedRevenueSchema),
};

export const OrgRevenueResponseSchema = z
  .object({
    ...revenueCore,
    asOf: z.string(),
    hasPaymentMethod: z.boolean(),
    cardCountrySupported: z.boolean(),
    cardUnusable: z.boolean(),
    cash: ChargeScheduleResponseSchema,
    brands: z.array(RevenueBrandLineSchema),
    campaigns: z.array(RevenueCampaignLineSchema),
  })
  .openapi("OrgRevenueResponse");

const CashBucketSchema = z
  .object({
    start: z.string(),
    amountCents: z.string(),
    eventCount: z.number().int(),
    unknownAmountEventCount: z.number().int(),
  })
  .openapi("CashBucket");

export const FleetRevenueResponseSchema = z
  .object({
    asOf: z.string(),
    cashHorizonDays: z.number().int(),
    accountCount: z.number().int(),
    classCounts: z.object({ recurring: z.number(), one_off: z.number(), none: z.number() }),
    totals: z.object({
      drrCents: z.string(),
      mrrCents: z.string(),
      arrCents: z.string(),
      drrUnknownOrgIds: z.array(z.string()),
      oneOffRemainingCents: z.string(),
      /** Subscriptions in their free trial: not revenue yet, shown apart. */
      subscriptionTrials: z.object({ count: z.number().int(), monthlyAmountCents: z.string() }),
      windows: z.array(
        z.object({
          horizonDays: z.number().int(),
          projectedRevenueCents: z.string(),
          recurringCents: z.string(),
          oneOffCents: z.string(),
          unknownOrgIds: z.array(z.string()),
          cashCents: z.string(),
          cashEventCount: z.number().int(),
          unknownAmountCashEventCount: z.number().int(),
        })
      ),
    }),
    cashFlow: z.object({ byDay: z.array(CashBucketSchema), byWeek: z.array(CashBucketSchema) }),
    orgs: z.array(
      z.object({
        ...revenueCore,
        cashState: ChargeScheduleResponseSchema.shape.state,
        cashBlockedReason: ChargeScheduleResponseSchema.shape.blockedReason,
        cashEvents: z.array(ExpectedChargeSchema),
      })
    ),
    unreadableOrgs: z.array(z.object({ orgId: z.string(), error: z.string() })),
  })
  .openapi("FleetRevenueResponse");

registry.registerPath({
  method: "get",
  path: "/internal/revenue/by-org/{orgId}",
  summary: "One org's recurring revenue, one-off money and expected cash",
  description:
    "Class (recurring: postpaid with a chargeable card, or prepaid with auto top-up and a " +
    "chargeable card; one_off: prepaid otherwise, still holding money; none otherwise, with " +
    "the reason). DRR = the daily budgets of the org's proactive campaigns (entry legs) that " +
    "are running and not audience-exhausted, per campaign-service's recurring-status; reactive " +
    "legs never count. MRR = DRR x 30, ARR = MRR x 12. A one-off org states its remaining " +
    "spendable money, its pace and its run-out date and contributes no MRR. 30/90-day " +
    "projections, and the org's charge schedule as its cash. Unknown figures are null with a " +
    "reason, never 0. x-api-key only; pure read.",
  request: {
    headers: internalHeaders,
    params: z.object({ orgId: z.string().uuid() }),
    query: z.object({ cashHorizonDays: z.string().optional() }),
  },
  responses: {
    200: { description: "The org's revenue", content: { "application/json": { schema: OrgRevenueResponseSchema } } },
    400: { description: "Bad orgId or cashHorizonDays", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No billing account", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "A sibling read failed", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/revenue/fleet",
  summary: "Every org's revenue row, fleet totals, projections and cash flow by day/week",
  description:
    "One row per billing account (same fields as the per-org read, minus the campaign detail), " +
    "the fleet totals (DRR/MRR/ARR = sum of the known per-org rows; unknown orgs listed, never " +
    "counted as 0), 30/90-day projected revenue, and the expected cash (sum of every org's " +
    "charge schedule) in 30/90-day windows and bucketed by UTC day and ISO week. Orgs whose " +
    "read failed are listed in unreadableOrgs. cashHorizonDays 90 to 366 (default 90). " +
    "x-api-key only, org-less; pure read.",
  request: {
    headers: internalHeaders,
    query: z.object({ cashHorizonDays: z.string().optional() }),
  },
  responses: {
    200: { description: "Fleet revenue", content: { "application/json": { schema: FleetRevenueResponseSchema } } },
    400: { description: "Bad cashHorizonDays", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "The account list could not be read", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// --- Subscription (third payment mode, owned by billing; lib/subscription) ---

const MonthlyAmountSchema = z
  .number()
  .int()
  .positive()
  .openapi({
    description:
      "Monthly plan in cents: any whole-dollar amount from 2900 ($29). 400 code amount_below_minimum " +
      "(< 2900) | amount_not_whole_dollars (not a multiple of 100).",
  });

export const SubscriptionCheckoutRequestSchema = z
  .object({
    /** The plan the customer picked. Default 9900. */
    monthly_amount_cents: MonthlyAmountSchema.optional(),
    /** How the card form is presented (same as POST /v1/accounts/card_setup). Default embedded. */
    ui_mode: z.enum(["embedded", "hosted"]).optional(),
    /** Where a hosted card form returns to. Required for hosted. */
    return_url: z.string().url().optional(),
  })
  .openapi("SubscriptionCheckoutRequest");

export const SubscriptionCheckoutResponseSchema = z
  .object({
    monthly_amount_cents: z.number().int(),
    currency: z.literal("usd"),
    /** 3 for an org that never had a trial; null otherwise (the first month is charged at start). */
    trial_days: z.number().int().nullable(),
    /** false = a chargeable card is already on file: call POST /v1/accounts/subscription/start now. */
    card_required: z.boolean(),
    /**
     * The card form to render, exactly as POST /v1/accounts/card_setup returns it
     * (switch on `mode`: embedded_widget = Revolut widget, embedded_checkout = Stripe,
     * hosted_redirect = redirect to url). Null when card_required is false.
     */
    card_setup: z.record(z.unknown()).nullable(),
  })
  .openapi("SubscriptionCheckoutResponse");

export const StartSubscriptionRequestSchema = z
  .object({
    /** Overrides the amount picked at checkout. */
    monthly_amount_cents: MonthlyAmountSchema.optional(),
  })
  .openapi("StartSubscriptionRequest");

export const ChangeSubscriptionAmountRequestSchema = z
  .object({
    monthly_amount_cents: MonthlyAmountSchema,
    /**
     * TRIALING plan only: end the free trial NOW and charge monthly_amount_cents today
     * (the current amount or any other amount from $29). Paid → active at that amount,
     * period restarts today (next charge one month out), credit lands now. Refused →
     * nothing changes (still trialing, old amount). Absent/false on a trialing plan →
     * 409 subscription_trialing, exactly as before. Never sent implicitly: the
     * customer confirms the charge first.
     */
    start_now: z.boolean().optional(),
  })
  .openapi("ChangeSubscriptionAmountRequest");

export const SubscriptionViewSchema = z
  .object({
    id: z.string().uuid(),
    /** The brand x offer this plan pays for. Null on an onboarding plan not attributed yet. */
    brand_id: z.string().uuid().nullable(),
    offer_id: z.string().uuid().nullable(),
    status: z.enum(["trialing", "active", "past_due", "canceled"]),
    trial_end: z.string().nullable(),
    /** true = ends at current_period_end, no further charge. */
    cancel_at_period_end: z.boolean(),
    current_period_start: z.string(),
    current_period_end: z.string(),
    /**
     * When billing next charges the card (trial end / renewal); null once ending or ended.
     * Paused: the pause end + the time the period had left when it was paused.
     */
    next_charge_at: z.string().nullable(),
    ended_at: z.string().nullable(),
    monthly_amount_cents: z.number().int(),
    currency: z.literal("usd"),
    has_payment_method: z.boolean().nullable(),
    /** Active, no cancel pending: the plan can be changed (any amount from $29, up or down). */
    can_change_amount: z.boolean(),
    /** Trialing, no cancel pending: the customer may end the trial and pay today (PATCH with start_now: true, any amount from $29). */
    can_start_now: z.boolean(),
    /** Paused by the customer: no charge, no credit expiry; sending stops once every live plan is paused. */
    paused: z.boolean(),
    paused_at: z.string().nullable(),
    /** When the pause ends on its own; the plan then resumes and charges at next_charge_at. */
    pause_ends_at: z.string().nullable(),
    /** Trialing or active, not paused, no cancel pending: POST .../pause. */
    can_pause: z.boolean(),
    /** Paused: POST .../unpause. */
    can_unpause: z.boolean(),
    /** This plan no longer sends: paused, cancelled (stops at once, not at period end) or ended. */
    sending_stopped: z.boolean(),
    /** Same as can_change_amount (kept for the first shape). */
    can_raise: z.boolean(),
    next_raise_monthly_amount_cents: z.number().int().nullable(),
  })
  .openapi("SubscriptionView");

export const SubscriptionReadResponseSchema = z
  .object({
    /**
     * The ORG no longer sends (authorize + affordability refuse spend): every live plan
     * is paused or cancelled, or the plan has ended. A cancel stops sending AT ONCE;
     * resume (keep the plan) or unpause restarts it.
     */
    sending_stopped: z.boolean(),
    /** plan_canceled | plan_paused; null while sending. */
    sending_stopped_reason: z.enum(["plan_paused", "plan_canceled"]).nullable(),
    org_id: z.string().uuid(),
    payment_mode: PaymentModeSchema.nullable(),
    subscription: SubscriptionViewSchema.nullable(),
    /** Spendable credit right now (= balance_cents on GET /v1/accounts). */
    credits_remaining_cents: z.string(),
    /** The one-shot trial grant this org received; null when it has had none. */
    trial_grant_cents: z.number().nullable(),
    /** Total credit expired unspent at renewals (= expired_cents on GET /v1/accounts). */
    expired_cents: z.string(),
  })
  .openapi("SubscriptionReadResponse");

export const SubscriptionActionResponseSchema = z
  .object({
    /**
     * The ORG no longer sends (authorize + affordability refuse spend): every live plan
     * is paused or cancelled, or the plan has ended. A cancel stops sending AT ONCE;
     * resume (keep the plan) or unpause restarts it.
     */
    sending_stopped: z.boolean(),
    /** plan_canceled | plan_paused; null while sending. */
    sending_stopped_reason: z.enum(["plan_paused", "plan_canceled"]).nullable(),
    org_id: z.string().uuid(),
    subscription: SubscriptionViewSchema,
    credits_remaining_cents: z.string(),
  })
  .openapi("SubscriptionActionResponse");

export const SubscriptionRefusalSchema = z
  .object({
    error: z.string(),
    code: z.enum([
      "subscription_exists",
      "existing_paying_org",
      "card_required",
      "first_charge_declined",
      "no_subscription",
      "subscription_trialing",
      "subscription_not_trialing",
      "start_now_in_progress",
      "subscription_not_active",
      "subscription_cancel_pending",
      "subscription_not_cancel_pending",
      "amount_unchanged",
      "plan_exists_for_offer",
      "offer_not_found",
      "charge_unavailable",
      "subscription_paused",
      "subscription_not_paused",
      "subscription_ended",
      "amount_below_minimum",
      "amount_not_whole_dollars",
    ]),
  })
  .openapi("SubscriptionRefusal");

export const PauseSubscriptionRequestSchema = z
  .object({
    /** How long the break lasts: 1, 2 or 3 months. The plan resumes on its own after it. */
    months: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  })
  .strict()
  .openapi("PauseSubscriptionRequest");

export const StartPlanRequestSchema = z
  .object({
    brand_id: z.string().uuid(),
    offer_id: z.string().uuid(),
    monthly_amount_cents: MonthlyAmountSchema,
  })
  .strict()
  .openapi("StartPlanRequest");

export const PlanListResponseSchema = z
  .object({
    /**
     * The ORG no longer sends (authorize + affordability refuse spend): every live plan
     * is paused or cancelled, or the plan has ended. A cancel stops sending AT ONCE;
     * resume (keep the plan) or unpause restarts it.
     */
    sending_stopped: z.boolean(),
    /** plan_canceled | plan_paused; null while sending. */
    sending_stopped_reason: z.enum(["plan_paused", "plan_canceled"]).nullable(),
    org_id: z.string().uuid(),
    payment_mode: PaymentModeSchema.nullable(),
    /** Every plan of the org, live ones first (oldest first), then ended ones (newest first). */
    subscriptions: z.array(SubscriptionViewSchema),
    /** Spendable credit right now, shared by every plan (= balance_cents on GET /v1/accounts). */
    credits_remaining_cents: z.string(),
    expired_cents: z.string(),
  })
  .openapi("PlanListResponse");

const subscriptionRefusal = (description: string) => ({
  description,
  content: { "application/json": { schema: SubscriptionRefusalSchema } },
});
const subscriptionUpstream = {
  description: "The card acquirer or the balance could not be read",
  content: { "application/json": { schema: ErrorResponseSchema } },
};

registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscription/checkout_session",
  summary: "Prepare a subscription: the chosen plan + the card form (no charge)",
  description:
    "Records the plan the customer picked and returns the card form of whichever acquirer holds " +
    "the org (Revolut by default, Stripe for legacy orgs), exactly as POST /v1/accounts/card_setup. " +
    "When the card is saved (widget callback / return from the hosted form), call " +
    "POST /v1/accounts/subscription/start. card_required=false means a chargeable card is already " +
    "on file: call start directly. Nothing is charged here. 409 subscription_exists | existing_paying_org.",
  request: {
    headers: protectedHeaders,
    body: { content: { "application/json": { schema: SubscriptionCheckoutRequestSchema } } },
  },
  responses: {
    200: { description: "Plan recorded", content: { "application/json": { schema: SubscriptionCheckoutResponseSchema } } },
    400: { description: "Amount refused (amount_below_minimum | amount_not_whole_dollars) or missing return_url", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: subscriptionRefusal("subscription_exists | existing_paying_org"),
    502: subscriptionUpstream,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscription/start",
  summary: "Start the subscription once the card is saved",
  description:
    "First subscription: 3-day free trial with $99 of credit, nothing charged; billing charges the " +
    "plan at trial end, then every month on that anniversary, on the saved card. An org that already " +
    "had its trial is charged the first month now (409 first_charge_declined if the card refuses; " +
    "nothing starts). 409 card_required when no chargeable card is on file yet. Returns the same " +
    "body as GET /v1/accounts/subscription. (The read also starts it on its own once the card is on " +
    "file, so a missed call is caught.)",
  request: {
    headers: protectedHeaders,
    body: { content: { "application/json": { schema: StartSubscriptionRequestSchema } } },
  },
  responses: {
    200: { description: "Started", content: { "application/json": { schema: SubscriptionReadResponseSchema } } },
    400: { description: "Amount refused (amount_below_minimum | amount_not_whole_dollars)", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: subscriptionRefusal("card_required | first_charge_declined | subscription_exists | existing_paying_org"),
    502: subscriptionUpstream,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/accounts/subscription",
  summary: "Read this org's subscription, payment mode and remaining credits",
  description:
    "Settles first: starts a subscription whose card is now on file, and applies any renewal that " +
    "fell due (unspent credit expires, the month is charged). subscription is null when the org " +
    "never subscribed.",
  request: { headers: protectedHeaders },
  responses: {
    200: { description: "The subscription view", content: { "application/json": { schema: SubscriptionReadResponseSchema } } },
    502: subscriptionUpstream,
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/accounts/subscription",
  summary: "Change the plan (any amount from $29, up or down), from the next charge; or start a trialing plan now",
  description:
    "Active subscriptions: the new amount applies from the next charge. Trialing subscriptions: send " +
    "start_now: true to end the trial and charge the chosen amount today (see can_start_now). " +
    "400 amount_below_minimum | amount_not_whole_dollars; 404 no_subscription; 409 subscription_trialing | " +
    "subscription_not_active | subscription_cancel_pending | amount_unchanged | subscription_not_trialing | " +
    "card_required | first_charge_declined | start_now_in_progress; 502 charge_unavailable.",
  request: {
    headers: protectedHeaders,
    body: { content: { "application/json": { schema: ChangeSubscriptionAmountRequestSchema } } },
  },
  responses: {
    200: { description: "The subscription after the change", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    400: { description: "Amount refused (amount_below_minimum | amount_not_whole_dollars)", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: subscriptionRefusal("no_subscription"),
    409: subscriptionRefusal(
      "subscription_trialing | subscription_not_active | subscription_cancel_pending | amount_unchanged; " +
        "with start_now: subscription_not_trialing | subscription_cancel_pending | card_required | first_charge_declined | start_now_in_progress"
    ),
    502: subscriptionRefusal("charge_unavailable (start_now: the charge could not be attempted; nothing changed) or an upstream read failed"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscription/cancel",
  summary: "Cancel: no further charge",
  description:
    "No further charge. SENDING STOPS AT ONCE (authorize + affordability refuse spend; " +
    "sending_stopped=true, reason plan_canceled). Trialing / active: the plan ends at " +
    "current_period_end (undo with /resume until then, which restarts sending); unspent credit " +
    "expires then. past_due: ends now. Idempotent.",
  request: { headers: protectedHeaders },
  responses: {
    200: { description: "The subscription after the cancel", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    404: subscriptionRefusal("no_subscription"),
    502: subscriptionUpstream,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscription/resume",
  summary: "Undo a pending cancel",
  request: { headers: protectedHeaders },
  responses: {
    200: { description: "The subscription after the resume", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    404: subscriptionRefusal("no_subscription"),
    409: subscriptionRefusal("subscription_not_cancel_pending"),
    502: subscriptionUpstream,
  },
});


registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscription/pause",
  summary: "Pause the subscription for 1, 2 or 3 months",
  description:
    "PAUSE (\"I need a break\"): the plan stops for 1, 2 or 3 months, then resumes on its own. " +
    "While paused: no charge, no credit expiry, the time left in the current period (trial included) " +
    "is kept and resumes at the pause end; when every live plan of the org is paused, sending stops " +
    "(authorize and the affordability pre-flight refuse spend). The credit is kept. Unpause ends it " +
    "earlier. A cancel during the pause applies at the (pushed) period end, as usual. 400 months not " +
    "1|2|3; 404 no_subscription; 409 subscription_ended | subscription_paused | subscription_not_active " +
    "(past_due) | subscription_cancel_pending.",
  request: { headers: protectedHeaders, body: { content: { "application/json": { schema: PauseSubscriptionRequestSchema } } } },
  responses: {
    200: { description: "The plan after the action", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    400: { description: "months is not 1, 2 or 3", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: subscriptionRefusal("no_subscription"),
    409: subscriptionRefusal("subscription_ended | subscription_paused | subscription_not_active | subscription_cancel_pending"),
    502: subscriptionUpstream,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscription/unpause",
  summary: "Unpause the subscription now",
  description:
    "UNPAUSE: the paused plan resumes now; its period (trial included) is pushed by the time it was " +
    "paused, so next_charge_at = now + the time it had left. 404 no_subscription; 409 subscription_ended " +
    "| subscription_not_paused.",
  request: { headers: protectedHeaders },
  responses: {
    200: { description: "The plan after the action", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    404: subscriptionRefusal("no_subscription"),
    409: subscriptionRefusal("subscription_ended | subscription_not_paused"),
    502: subscriptionUpstream,
  },
});

// --- Plans per brand x offer (one live plan per brand x offer; lib/subscription) ---

const planIdParams = z.object({ subscriptionId: z.string().uuid() });

registry.registerPath({
  method: "get",
  path: "/v1/accounts/subscriptions",
  summary: "List every plan of this org, each tied to one brand x offer",
  description:
    "Settles first (renewals due are applied). An onboarding plan started before plans were per " +
    "offer is attributed to the org's first brand x offer (oldest brand, its oldest active offer) on " +
    "this read and keeps that pair. A brand x offer with a live plan (status trialing | active | " +
    "past_due) can send; one without needs a plan.",
  request: { headers: protectedHeaders },
  responses: {
    200: { description: "Every plan", content: { "application/json": { schema: PlanListResponseSchema } } },
    502: subscriptionUpstream,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscriptions",
  summary: "Buy a plan for one brand x offer: no trial, charged now on the saved card",
  description:
    "Charges the first month at once on the card already on file; the plan then renews every month " +
    "on that anniversary. Refusals (body {error, code}): 404 offer_not_found; 409 plan_exists_for_offer " +
    "| card_required | first_charge_declined | existing_paying_org; 502 charge_unavailable (the charge " +
    "could not be attempted, nothing started). 400 amount_below_minimum | amount_not_whole_dollars, or bad body.",
  request: {
    headers: protectedHeaders,
    body: { content: { "application/json": { schema: StartPlanRequestSchema } } },
  },
  responses: {
    201: { description: "The plan, active and paid", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    400: { description: "Bad body, or amount refused (amount_below_minimum | amount_not_whole_dollars)", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: subscriptionRefusal("offer_not_found"),
    409: subscriptionRefusal("plan_exists_for_offer | card_required | first_charge_declined | existing_paying_org"),
    502: subscriptionRefusal("charge_unavailable (or brand-service / acquirer unreadable: {error} only)"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/accounts/subscriptions/{subscriptionId}",
  summary: "Change one plan's amount (any amount from $29), from its next charge; or start a trialing plan now (start_now: true)",
  request: {
    headers: protectedHeaders,
    params: planIdParams,
    body: { content: { "application/json": { schema: ChangeSubscriptionAmountRequestSchema } } },
  },
  responses: {
    200: { description: "The plan after the change", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    400: { description: "Amount refused (amount_below_minimum | amount_not_whole_dollars)", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: subscriptionRefusal("no_subscription (no live plan with this id in this org)"),
    409: subscriptionRefusal(
      "subscription_trialing | subscription_not_active | subscription_cancel_pending | amount_unchanged; " +
        "with start_now: subscription_not_trialing | subscription_cancel_pending | card_required | first_charge_declined | start_now_in_progress"
    ),
    502: subscriptionRefusal("charge_unavailable (start_now: the charge could not be attempted; nothing changed) or an upstream read failed"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscriptions/{subscriptionId}/cancel",
  summary: "Cancel one plan: no further charge (at period end; now when past_due)",
  description:
    "This plan stops sending AT ONCE; the org stops sending once every live plan is paused or " +
    "cancelled (sending_stopped). Resume undoes the cancel and restarts sending.",
  request: { headers: protectedHeaders, params: planIdParams },
  responses: {
    200: { description: "The plan after the cancel", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    404: subscriptionRefusal("no_subscription"),
    502: subscriptionUpstream,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscriptions/{subscriptionId}/resume",
  summary: "Undo a pending cancel on one plan",
  request: { headers: protectedHeaders, params: planIdParams },
  responses: {
    200: { description: "The plan after the resume", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    404: subscriptionRefusal("no_subscription"),
    409: subscriptionRefusal("subscription_not_cancel_pending"),
    502: subscriptionUpstream,
  },
});


registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscriptions/{subscriptionId}/pause",
  summary: "Pause one plan for 1, 2 or 3 months",
  description:
    "PAUSE (\"I need a break\"): the plan stops for 1, 2 or 3 months, then resumes on its own. " +
    "While paused: no charge, no credit expiry, the time left in the current period (trial included) " +
    "is kept and resumes at the pause end; when every live plan of the org is paused, sending stops " +
    "(authorize and the affordability pre-flight refuse spend). The credit is kept. Unpause ends it " +
    "earlier. A cancel during the pause applies at the (pushed) period end, as usual. 400 months not " +
    "1|2|3; 404 no_subscription; 409 subscription_ended | subscription_paused | subscription_not_active " +
    "(past_due) | subscription_cancel_pending.",
  request: { headers: protectedHeaders, params: planIdParams, body: { content: { "application/json": { schema: PauseSubscriptionRequestSchema } } } },
  responses: {
    200: { description: "The plan after the action", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    400: { description: "months is not 1, 2 or 3", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: subscriptionRefusal("no_subscription"),
    409: subscriptionRefusal("subscription_ended | subscription_paused | subscription_not_active | subscription_cancel_pending"),
    502: subscriptionUpstream,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/accounts/subscriptions/{subscriptionId}/unpause",
  summary: "Unpause one plan now",
  description:
    "UNPAUSE: the paused plan resumes now; its period (trial included) is pushed by the time it was " +
    "paused, so next_charge_at = now + the time it had left. 404 no_subscription; 409 subscription_ended " +
    "| subscription_not_paused.",
  request: { headers: protectedHeaders, params: planIdParams },
  responses: {
    200: { description: "The plan after the action", content: { "application/json": { schema: SubscriptionActionResponseSchema } } },
    404: subscriptionRefusal("no_subscription"),
    409: subscriptionRefusal("subscription_ended | subscription_not_paused"),
    502: subscriptionUpstream,
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/accounts/by-org/{orgId}/subscription",
  summary: "Staff/service: read an org's subscription, payment mode and remaining credits",
  description: "Same body as GET /v1/accounts/subscription. x-api-key only, org in the path.",
  request: { headers: internalHeaders, params: z.object({ orgId: z.string().uuid() }) },
  responses: {
    200: { description: "The subscription view", content: { "application/json": { schema: SubscriptionReadResponseSchema } } },
    400: { description: "Bad orgId", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No billing account", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: subscriptionUpstream,
  },
});

// --- Item budgets per campaign (lib/campaign-items, migrations 0062 + 0063) ---

export const SetCampaignItemBudgetsRequestSchema = z
  .object({
    /**
     * One budget per campaign (featureSlug x legKey on this offer); listed campaigns
     * are upserted, the others untouched. Integer cents; per DAY for prepaid / postpaid,
     * per MONTH (whole dollars) for a subscriber. A reactive campaign's budget is a MAX.
     */
    items: z
      .array(
        z.object({
          featureSlug: z.string().trim().min(1),
          legKey: z.string().trim().min(1),
          budgetCents: z.number().int(),
        })
      )
      .min(1),
  })
  .openapi("SetCampaignItemBudgetsRequest");

const CampaignItemViewSchema = z
  .object({
    featureSlug: z.string(),
    legKey: z.string(),
    /** proactive = finds leads (daily/monthly spend); reactive = fires on a step (a MAX); null = unknown leg. */
    role: z.enum(["proactive", "reactive"]).nullable(),
    period: ItemPeriodSchema,
    /** null = not set. In the item's period (a daily one may be fractional cents). */
    budgetCents: z.number().nullable(),
    /** The daily ceiling campaign-service paces on (monthly / 30 for a subscriber); null = not set. */
    dailyBudgetCents: CentsStringSchema.nullable(),
    /** false = a channel we do not run yet: recorded, charged nothing until it launches. */
    managed: z.boolean().nullable(),
    /** The minimum in this period (a daily one = monthly minimum / 30, rounded up). */
    minimumCents: z.number().int().nullable(),
    /** Reactive only: the most it may carry, half the offer's entry budgets. */
    capCents: z.number().int().nullable(),
    /** false for a customer-team leg (carries no budget) or an unknown one. */
    budgetable: z.boolean(),
    updatedAt: z.string().nullable(),
  })
  .openapi("CampaignItemBudget");

const ItemsPlanPricingSchema = z
  .object({
    monthlyAmountCents: z.number().int(),
    reactiveMonthlyCents: z.number().int(),
    deferredMonthlyCents: z.number().int(),
    offMonthlyCents: z.number().int(),
  })
  .openapi("CampaignItemsPlanPricing");

export const CampaignItemBudgetsSchema = z
  .object({
    orgId: z.string().uuid(),
    brandId: z.string().uuid(),
    offerId: z.string().uuid(),
    period: ItemPeriodSchema,
    items: z.array(CampaignItemViewSchema),
    /** Subscriber: the offer's live plan (null when none, or not a subscriber). */
    plan: z.object({ subscriptionId: z.string().uuid(), monthlyAmountCents: z.number().int() }).nullable(),
    /** Subscriber: what the budgets cost; null when nothing is charged (or not a subscriber). */
    pricing: ItemsPlanPricingSchema.nullable(),
  })
  .openapi("CampaignItemBudgets");

export const SetCampaignItemBudgetsResponseSchema = CampaignItemBudgetsSchema.extend({
  /** Follow-up (reactive) budget charged on the card now (subscriber, active plan). */
  reactiveChargedCents: z.number().int(),
  /** true when this write took the brand out of its global sales budget. */
  globalBudgetCleared: z.boolean(),
}).openapi("SetCampaignItemBudgetsResponse");

export const ItemBudgetRefusalSchema = z
  .object({
    error: z.string(),
    code: z.enum([
      "invalid_ids",
      "invalid_items",
      "duplicate_item",
      "unknown_item",
      "customer_leg_has_no_budget",
      "amount_not_whole_cents",
      "amount_not_whole_dollars",
      "below_minimum",
      "entry_item_required",
      "reactive_above_cap",
      "no_plan_for_offer",
      "subscription_not_active",
      "reactive_charge_declined",
      "charge_unavailable",
      "minimums_unavailable",
      "campaign_status_unavailable",
    ]),
    featureSlug: z.string().optional(),
    legKey: z.string().optional(),
    minimumCents: z.number().int().optional(),
    capCents: z.number().int().optional(),
    period: ItemPeriodSchema.optional(),
    amountCents: z.number().int().optional(),
  })
  .openapi("ItemBudgetRefusal");

const brandOfferParams = z.object({ brandId: z.string().uuid(), offerId: z.string().uuid() });
const campaignsQuerySchema = z.object({
  campaigns: z
    .string()
    .optional()
    .openapi({ description: "Comma list of featureSlug:legKey to get a row for even when not set." }),
});
const itemRefusal = (description: string) => ({
  description,
  content: { "application/json": { schema: ItemBudgetRefusalSchema } },
});

registry.registerPath({
  method: "get",
  path: "/v1/brands/{brandId}/offers/{offerId}/campaign-budgets",
  summary: "Read this offer's budget per campaign (offer x leg x channel)",
  description:
    "Every stored campaign budget of the offer, plus a 'not set' row (budgetCents null) for each " +
    "featureSlug:legKey listed in ?campaigns=. Each row carries its minimum (in its period), its cap " +
    "(reactive: half the offer's entry budgets) and whether we run the channel. period follows the " +
    "payment mode (subscription = month, else day). On/off is the campaign's status in campaign-service.",
  request: { headers: protectedHeaders, params: brandOfferParams, query: campaignsQuerySchema },
  responses: {
    200: { description: "Campaign budgets", content: { "application/json": { schema: CampaignItemBudgetsSchema } } },
    400: itemRefusal("Invalid ids or campaigns query"),
    502: itemRefusal("minimums_unavailable | campaign_status_unavailable"),
  },
});

registry.registerPath({
  method: "put",
  path: "/v1/brands/{brandId}/offers/{offerId}/campaign-budgets",
  summary: "Set one or several campaign budgets of an offer",
  description:
    "Upserts the listed campaigns. Each clears its published minimum (a daily budget: monthly " +
    "minimum / 30, rounded up); a reactive campaign's MAX is at most 50% of the SUM of the offer's " +
    "entry (proactive) budgets; customer-team legs carry none. Subscriber: monthly budgets; the " +
    "offer's plan becomes the SUM of its budgets on channels we run whose campaign is ON (min $99) " +
    "from the next charge, and ON follow-up budgets not yet collected this period are charged now " +
    "(unspent follow-up credit carries over). A channel we do not run is recorded and charged " +
    "nothing until it launches. Nothing is written on any refusal.",
  request: {
    headers: protectedHeaders,
    params: brandOfferParams,
    body: { content: { "application/json": { schema: SetCampaignItemBudgetsRequestSchema } } },
  },
  responses: {
    200: { description: "Set", content: { "application/json": { schema: SetCampaignItemBudgetsResponseSchema } } },
    400: itemRefusal("below_minimum | reactive_above_cap | entry_item_required | unknown_item | ..."),
    409: itemRefusal("no_plan_for_offer | subscription_not_active | reactive_charge_declined"),
    502: itemRefusal("minimums_unavailable | campaign_status_unavailable | charge_unavailable"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/brands/{brandId}/offers/{offerId}/campaign-budgets",
  summary: "Remove one campaign's budget (back to not set)",
  description:
    "Idempotent (removed: false when nothing was stored). Refused (400 reactive_above_cap) when it " +
    "would leave a follow-up budget above half of the entry budgets left.",
  request: {
    headers: protectedHeaders,
    params: brandOfferParams,
    query: z.object({ featureSlug: z.string(), legKey: z.string() }),
  },
  responses: {
    200: {
      description: "Removed",
      content: { "application/json": { schema: CampaignItemBudgetsSchema.extend({ removed: z.boolean() }) } },
    },
    400: itemRefusal("Invalid ids, missing featureSlug/legKey, or reactive_above_cap"),
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/offers/{offerId}/campaign-budgets",
  summary: "Read an offer's budget per campaign (service)",
  request: { headers: internalOrgHeaders, params: brandOfferParams, query: campaignsQuerySchema },
  responses: {
    200: { description: "Campaign budgets", content: { "application/json": { schema: CampaignItemBudgetsSchema } } },
    400: itemRefusal("Invalid ids, campaigns query or x-org-id"),
    502: itemRefusal("minimums_unavailable | campaign_status_unavailable"),
  },
});
