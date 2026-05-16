# billing-service — repo conventions

## Vocabulary (Stripe-aligned)

Naming follows Stripe Topups + Refunds APIs. When in doubt, search Stripe docs for the same term.

### Core money concepts

| Term | Definition | Source of truth |
|---|---|---|
| **balance** | Org's prepaid credit liability (what we owe the org). | `SUM(succeeded payment_intents.amount_received)` via stripe-service + `SUM(local_promos.amount_cents)` |
| **usage** | Platform AI cost consumed by org. Lifetime, all-time. | runs-service `GET /internal/org-usage-total` |
| **available** | Funds usable right now for new work. `balance − usage`. | computed at request time |
| **topup** | Auto/manual Stripe payment that increases balance. | stripe-service `payment_intents` (status='succeeded') |
| **gift / promo** | Non-payment credit (welcome bonus, promo redemption, manual adjustment). | `local_promos.amount_cents` |
| **refund** | Funds returned to org. | stripe-service `refunds` (visibility only — does not auto-deduct from billing balance) |

### Stripe `customer.balance` is NOT used

Pre-#104, billing-service wrote `usage_applied` CBTs to Stripe via `customers.createBalanceTransaction`. Those debits contaminated `customer.balance` (it no longer represented pure prepaid credit). Post-#0016 stripe-service v0.16.3 dropped `customer.balance` from its API surface entirely. Billing-service must **never read `customer.balance`** — derive `balance` from `payment_intents.amount_received` (real money paid) plus local promo grants.

## BYOK (Bring Your Own Key) cost source

`runs_costs.cost_source` ∈ `'platform' | 'org'`. ONLY `platform` rows are billed.

| `cost_source` | Who paid AI provider | We bill the org? |
|---|---|---|
| `platform` | Distribute (our API key) | **Yes** — counted in usage from runs-service |
| `org` | The org (their own API key) | **No** — tracking only, never deducted |

When reconciling or computing real cost: `WHERE rc.status='actual' AND rc.cost_source='platform'`. Including `org` rows would over-state.

## Local promos (`local_promos` table)

The only persistent ledger billing-service owns. One row per (org, promo_code) — `UNIQUE (org_id, promo_code_id)`. Welcome trial = `code='welcome'` ($2 grant), seeded by migration 0016. Other codes are admin-managed.

`amount_cents` is positive (these are credits). `numeric(16,10)` — Drizzle returns it as a JS string. Use Decimal.js (via `src/lib/cents.ts` helpers) for arithmetic; never cast to Number for math.

## Billing/runs ownership target

- **Billing-service** owns: local promo grants (`local_promos`), topup config (`billing_accounts.topup_amount_cents`, `topup_threshold_cents`).
- **Stripe-service** owns: Stripe customers, payment methods, payment intents, refunds, checkout sessions, billing portal sessions. Mirror DB synced via webhooks + boot back-fill.
- **Runs-service** owns: run-level usage truth. `spent_cents` from `GET /internal/org-usage-total?org_id=...` includes platform `actual + provisioned` costs, excludes canceled and `org`/BYOK costs.

Billing never duplicates Stripe state and never persists run-level usage rows.

## Fractional cents

`local_promos.amount_cents` is `numeric(16,10)`. Drizzle returns it as a JS string — never cast with `Number()` for math (precision loss). Use the `addCents/subCents/cmpCents/isDepleted/gte` helpers in `src/lib/cents.ts` (Decimal.js-backed, precision 50). `parseFloat` is for display only.

`payment_intents.amount_received` from Stripe is **integer cents** (Stripe's `amount` minor unit). Sum returns a `Decimal.toFixed(10)` string for arithmetic-compatibility with the helpers above.

## Public surface field names

### `GET /v1/accounts` and `PATCH/DELETE /v1/accounts/auto_topup`

```jsonc
{
  "id": "<uuid>",
  "org_id": "<uuid>",
  "balance_cents": "55200.0000000000",       // SUM(succeeded PI.amount_received) + SUM(local_promos.amount_cents)
  "usage_cents": "38289.2958000000",         // runs-service spent_cents (platform actual+provisioned)
  "available_cents": "16910.7042000000",     // balance_cents − usage_cents; USE THIS for depletion/budget gates
  "topup_amount_cents": 2500,                // auto-topup amount
  "topup_threshold_cents": 500,              // auto-topup triggers when available_cents < threshold
  "has_payment_method": true,                // derived from customer.invoice_settings.default_payment_method != null
  "has_auto_topup": true,
  "created_at": "...",
  "updated_at": "..."
}
```

All three balance/usage/available endpoints fail loud (502) when runs-service or stripe-service is unreachable.

`balance_cents` composition (`src/routes/accounts.ts:composeAccountFunds`):
1. `getCustomerByOrg(identity)` → Stripe customer (for `id` and `default_payment_method`)
2. `sumSucceededTopupsForCustomer(identity, customer.id)` → paginates `GET /v1/payment_intents?customer=cus_X` and sums `amount_received` where `status='succeeded'`
3. `sumLocalPromoCreditsForOrg(orgId)` → SUM `local_promos.amount_cents`
4. `fetchRunsOrgUsageTotal(orgId, identity)` → runs-service `spent_cents`
5. `balance_cents = paid_topups + local_credits` ; `available_cents = balance_cents − usage`

### `GET /public/stats/billing`

Composed from stripe-service `getStats()` + local `localPromos`:

```jsonc
{
  "total_accounts": 2,
  "accounts_with_payment_method": 1,                // from stripe-service
  "total_credited_cents": "15400.0000000000",       // total_paid_cents + total_local_credits_cents
  "total_paid_cents": "15000.0000000000",           // stripe-service Stripe payments (gross)
  "total_revenue_cents": "15000.0000000000",        // cumulative all-time Stripe revenue
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
| `PATCH` | `/v1/accounts/auto_topup` | configure auto-topup |
| `DELETE` | `/v1/accounts/auto_topup` | disable auto-topup |
| `POST` | `/v1/checkout-sessions` | one-shot top-up via Stripe Checkout |
| `POST` | `/v1/portal-sessions` | Stripe Customer Portal session |
| `POST` | `/v1/customer_balance/authorize` | check if `available_cents >= amount` ; auto-reload via PI if configured |
| `POST` | `/v1/customer_balance/usage_apply` | proactive topup hint after a run; no-op for the ledger |
| `POST` | `/v1/promotion_codes/redeem` | redeem promo code → insert `local_promos` row |
