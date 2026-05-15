# billing-service — repo conventions

## Vocabulary (Stripe-aligned)

Naming follows Stripe Customer Balance + Topups + Refunds APIs. When in doubt, search Stripe docs for the same term.

### Core money concepts

| Term | Definition | Source of truth |
|---|---|---|
| **balance** | Org's prepaid balance liability (what we owe the org). Net of all succeeded customer-balance transactions. | `billing_accounts.balance_cents` |
| **usage** | Platform AI cost consumed by org. Lifetime, all-time. | runs-service `GET /internal/org-usage-total` |
| **available** | Funds usable right now for new work. `balance − usage`. | computed at request time |
| **topup** | Auto/manual Stripe payment that increases balance. | `customer_balance_transactions WHERE type='payment'` |
| **gift** | Non-payment credit (welcome bonus, manual adjustment). | `customer_balance_transactions WHERE type='gift'` |
| **promo** | Promo-code redemption credit. | `customer_balance_transactions WHERE type='promo'` |
| **refund** | Funds returned to org (or to org's card). | `customer_balance_transactions WHERE type='refund'` |

### Signed amount convention

`customer_balance_transactions.amount_cents` is **signed**, matching Stripe `customer_balance_transactions.amount`:

| Sign | Meaning | Examples |
|---|---|---|
| **negative** | balance increases (org receives credit) | topup, gift, promo, refund |
| **positive** | balance decreases (org spends) | usage_applied (legacy, frozen post-#104) |

So `balance_cents = − SUM(amount_cents) WHERE status='succeeded'`.

> Convention rationale: Stripe `customer.balance` is negative when customer has credit, positive when customer owes. We mirror their sign on per-transaction `amount` so `customer.balance = SUM(cbt.amount)` works out of the box.

### Status lifecycle (Stripe PaymentIntent semantics)

| Status | Impact on balance | Stripe analog |
|---|---|---|
| `requires_capture` | none — authorization only | PaymentIntent `requires_capture` |
| `succeeded` | applied to balance | PaymentIntent `succeeded` |
| `canceled` | none — never applied | PaymentIntent `canceled` (single L, US spelling) |

Only `succeeded` rows affect `balance`. `requires_capture` and `canceled` are visible in history but do not move money.

## BYOK (Bring Your Own Key) cost source

`runs_costs.cost_source` ∈ `'platform' | 'org'`. ONLY `platform` rows are billed.

| `cost_source` | Who paid AI provider | We bill the org? |
|---|---|---|
| `platform` | Distribute (our API key) | **Yes** — counted in usage from runs-service |
| `org` | The org (their own API key) | **No** — tracking only, never deducted |

When reconciling or computing real cost: `WHERE rc.status='actual' AND rc.cost_source='platform'`. Including `org` rows would over-state.

## Customer balance transaction types (`type` column)

| type | direction | meaning |
|---|---|---|
| `payment` | credit (negative amount) | Stripe top-up succeeded (auto or manual) |
| `gift` | credit (negative amount) | $2 welcome bonus on signup; manual adjustments |
| `promo` | credit (negative amount) | promo code redemption |
| `refund` | credit (negative amount) | exceptional refund |
| `usage_applied` | debit (positive amount) | **Frozen post-#104.** Usage now tracked in runs-service, not in billing ledger. Legacy rows archived to `cbt_archive_pre104_usage`. |

`usage_applied` lifecycle (historical only, pre-#104): provision inserted `(positive amount, requires_capture)`; confirm mutated to `succeeded`; cancel mutated to `canceled`. **No mirror credit rows ever inserted.**

Post-#107: legacy `usage_applied` rows deleted from prod and copied to `cbt_archive_pre104_usage` (same DB, audit-only). `GET /v1/customer_balance_transactions` filters `type != 'usage_applied'` as defense-in-depth.

## `cost_id` natural key (post-#92)

`customer_balance_transactions.cost_id` (uuid, nullable, indexed) decouples external callers from the billing-internal `customer_balance_transactions.id`. runs-service issues one provision per `runs_costs.id` and confirms/cancels via the by-cost endpoints — no billing-side id needed.

By-cost lookup picks the **most recent** row by `created_at` (one cost_id can produce a `requires_capture → canceled` row plus a fresh `succeeded` replacement when the actual amount differs). Only one row per cost_id is non-terminal at a time. Replacement rows carry the same `cost_id` so subsequent calls still hit the active row.

> **Note**: provision/confirm/cancel endpoints on `/v1/customer_balance` are documented for completeness but **currently no-op** (frozen post-#104). Usage truth lives in runs-service. See "Billing/runs ownership target" below.

## `balance_transaction_id` canonical key (post-#96)

There is **one** id surfaced in billing responses: `balance_transaction_id` (= `customer_balance_transactions.id`). Internal code uses `balanceTransactionId` consistently. The deprecated `provision_id` and `transaction_id` aliases were removed in v3.

## Fractional cents

`customer_balance_transactions.amount_cents` and `billing_accounts.balance_cents` are `numeric(16,10)`. Drizzle returns them as JS strings — never cast with `Number()` for math (precision loss). Use `parseFloat` for display only; for arithmetic in JS, use `BigInt`-scaled or `numeric.js`-style. Do NOT round inside billing — runs-service sends raw fractional, ledger preserves it.

Stripe `customers.createBalanceTransaction` only takes integer cents. The Stripe-sync layer in `src/lib/ledger.ts` ceils ledger balance and only fires a balance txn when the integer floor crosses a boundary. Stripe is fire-and-forget visibility; ledger is source of truth.

## Billing/runs ownership target

Runs-service owns run-level usage truth. Billing-service must not create new run-cost provision/confirm/cancel rows. Authorize computes available credits as:

```
balance (from billing) − usage (from runs-service)
```

The runs-service total is fetched from `GET /internal/org-usage-total?org_id=...` and includes platform `actual + provisioned` costs, excluding canceled and org/BYOK costs. Billing-service owns Stripe customers, payment methods, topups, gift/promo grants, and Stripe payment/refund records.

Do not sync Stripe Customer Balance Transactions for internal balance. Stripe is payment processor + audit; available credits come from billing balance minus runs usage.

## Public surface field names

### `GET /v1/accounts` and `PATCH/DELETE /v1/accounts/auto_topup`

```jsonc
{
  "balance_cents": "2091.0000000000",     // billing-owned credit balance
  "usage_cents": "136803.0000000000",     // mirrored from runs-service
  "available_cents": "-134712.0000000000", // balance − usage; USE THIS for depletion/budget gates
  "topup_amount_cents": 2500,             // auto-topup amount per Stripe Topups API
  "topup_threshold_cents": 500,           // auto-topup triggers when available_cents < threshold
  "has_payment_method": true,                // derived from customer.invoice_settings.default_payment_method != null
  "has_auto_topup": true
}
```

All three balance/usage/available endpoints fail loud (502) when runs-service or stripe-service is unreachable. PATCH/DELETE call runs-service to keep the response shape consistent.

`balance_cents` is derived from Stripe `customer.balance` with sign-flipped semantics: Stripe convention is `balance > 0` = customer owes, `balance < 0` = customer has credit. Billing surfaces the credit-positive value (`balance_cents = -customer.balance`).

### `GET /v1/customer_balance_transactions`

```jsonc
{
  "object": "list",
  "data": [
    {
      "id": "<uuid>",
      "object": "customer_balance_transaction",
      "amount_cents": "-2500.0000000000",          // signed: negative = credit, positive = debit
      "type": "payment",                          // 'payment' | 'gift' | 'promo' | 'refund'
      "status": "succeeded",                      // 'requires_capture' | 'succeeded' | 'canceled'
      "stripe_payment_intent_id": "pi_xxx",
      "stripe_balance_transaction_id": "txn_xxx", // Stripe-side CBT id (visibility only)
      "cost_id": null,                            // present only for legacy usage_applied rows
      "created": 1234567890                       // unix seconds, Stripe convention
    }
  ]
}
```

### `GET /public/stats/billing`

Composed from stripe-service `getStats()` + local `localPromos` (post-#112):

```jsonc
{
  "total_accounts": 2,
  "accounts_with_payment_method": 1,                // from stripe-service
  "total_credited_cents": "15400.0000000000",       // total_paid_cents + total_local_credits_cents
  "total_paid_cents": "15000.0000000000",           // stripe-service Stripe payments (gross)
  "total_revenue_cents": "15000.0000000000",        // cumulative all-time Stripe revenue (currently = total_paid_cents; will become net once stripe-service exposes refund totals)
  "total_local_credits_cents": "400.0000000000",    // SUM(local_promos.amount_cents)
  "monthly_growth": [
    { "period": "2026-05-01", "credited_cents": "25000.0000000000", "revenue_cents": "23000.0000000000" }
  ],
  "weekly_growth": [ ... ]
}
```

Growth rows expose `credited_cents` and `revenue_cents` only. Total consumed lives in runs-service. Endpoint returns 502 if stripe-service unreachable.

## Endpoints reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/accounts` | account snapshot (balance, usage, available, topup config) |
| `GET` | `/v1/accounts/balance` | shortcut: `{ available_cents, depleted }` |
| `GET` | `/v1/customer_balance_transactions` | paginated ledger history (filters `type != 'usage_applied'`) |
| `PATCH` | `/v1/accounts/auto_topup` | configure auto-topup |
| `DELETE` | `/v1/accounts/auto_topup` | disable auto-topup |
| `POST` | `/v1/checkout-sessions` | one-shot top-up via Stripe Checkout |
| `POST` | `/v1/portal-sessions` | Stripe Customer Portal session |
| `POST` | `/v1/customer_balance/authorize` | check if `available_cents >= amount` (auth-only, no balance impact) |
| `POST` | `/v1/customer_balance/usage_apply` | notify-only endpoint (post-#104 placeholder; runs-service is truth) |
| `POST` | `/v1/promotion_codes/redeem` | redeem promo code → insert `type='promo'` CBT |
| `POST` | `/v1/webhooks/stripe` | Stripe webhook receiver |
