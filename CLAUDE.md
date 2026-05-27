# billing-service — repo conventions

## Vocabulary (Stripe-aligned)

Naming follows Stripe Topups + Refunds APIs. When in doubt, search Stripe docs for the same term.

### Core money concepts

| Term | Definition | Source of truth |
|---|---|---|
| **credited** | Lifetime credits added to org (paid topups + promos). | `SUM(succeeded payment_intents.amount_received)` via stripe-service + `SUM(local_promos.amount_cents)` |
| **usage** | Platform AI cost consumed by org. Lifetime, all-time. | runs-service `GET /internal/org-usage-total` |
| **balance** | Funds usable right now for new work. `credited − usage`. **Use this for depletion/budget gates.** | computed at request time |
| **topup** | Auto/manual Stripe payment that increases credited. | stripe-service `payment_intents` (status='succeeded') |
| **gift / promo** | Non-payment credit (welcome bonus, promo redemption, manual adjustment). | `local_promos.amount_cents` |
| **refund** | Funds returned to org. | stripe-service `refunds` (visibility only — does not auto-deduct from billing) |

### Stripe `customer.balance` is NOT used

Pre-#104, billing-service wrote `usage_applied` CBTs to Stripe via `customers.createBalanceTransaction`. Those debits contaminated `customer.balance` (it no longer represented pure prepaid credit). Post-#0016 stripe-service v0.16.3 dropped `customer.balance` from its API surface entirely. Billing-service must **never read `customer.balance`** — derive `credited` from `payment_intents.amount_received` (real money paid) plus local promo grants.

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

## stripe-service integration shape

`src/lib/stripe-service-client.ts` only calls Stripe-shape primitives. stripe-service deliberately exposes no billing-specific shortcuts.

- Customer fetch is **org-implicit** via `GET /v1/customers?limit=1` (resolved server-side from `x-org-id`). No `stripe_customer_id` is stored in billing.
- Balance is derived from the Stripe customer object: `balance_cents = -customer.balance` (sign-flip, Stripe convention is `balance > 0` = customer owes).
- `has_payment_method` is derived from `customer.invoice_settings.default_payment_method != null`.
- Reload is composed billing-side via `POST /v1/payment_intents` with `confirm:true, off_session:true` + `Idempotency-Key` header. Stripe status flattened to `{succeeded|failed}` in `src/lib/reload.ts`.
- Balance transactions list uses the org-implicit `GET /v1/balance_transactions` (no customer id needed).

## transfer-brand SS-side semantics

`POST /internal/transfer-brand` patches Stripe customer metadata via list-by-metadata + per-customer PATCH:

- **List filter:** `GET /v1/customers?metadata[org_id]=sourceOrgId` (org-scoped, paginated 100/page).
- **Brand filter (client-side):** `customer.metadata.brand_id` is treated as a **comma-separated UUID string**. Only customers whose `brand_id` parses to exactly one UUID matching `sourceBrandId` are patched. Multi-brand customers are skipped and logged (would orphan co-brands). Mirrors the `local_promos array_length(brand_ids,1)=1` solo-brand semantics on the billing-DB side.
- **PATCH:** sets `metadata.org_id=targetOrgId` (and `brand_id=targetBrandId` if provided). Preserves other metadata keys.
- **Partial failure:** if a PATCH fails mid-loop, returns 502 with `{ partial: { stripe_service_customers_patched, total_targets } }`. Stripe metadata PATCH is idempotent — caller can resume.

The same CSV convention applies to the `x-brand-id` header forwarded by workflow-service for multi-brand campaigns.

## Public surface field names

### `GET /v1/accounts` and `PATCH/DELETE /v1/accounts/auto_topup`

```jsonc
{
  "id": "<uuid>",
  "org_id": "<uuid>",
  "credited_cents": "55200.0000000000",      // SUM(succeeded PI.amount_received) + SUM(local_promos.amount_cents)
  "usage_cents": "38289.2958000000",         // runs-service spent_cents (platform actual+provisioned)
  "balance_cents": "16910.7042000000",       // credited_cents − usage_cents; USE THIS for depletion/budget gates
  "topup_amount_cents": 2500,                // auto-topup amount
  "topup_threshold_cents": 500,              // auto-topup triggers when balance_cents < threshold
  "has_payment_method": true,                // derived from customer.invoice_settings.default_payment_method != null
  "has_auto_topup": true,
  "created_at": "...",
  "updated_at": "..."
}
```

All three credited/usage/balance endpoints fail loud (502) when runs-service or stripe-service is unreachable.

Composition (`src/routes/accounts.ts:composeAccountFunds`):
1. `getCustomerByOrg(identity)` → Stripe customer (for `id` and `default_payment_method`)
2. `sumSucceededTopupsForCustomer(identity, customer.id)` → paginates `GET /v1/payment_intents?customer=cus_X` and sums `amount_received` where `status='succeeded'`
3. `sumLocalPromoCreditsForOrg(orgId)` → SUM `local_promos.amount_cents`
4. `fetchRunsOrgUsageTotal(orgId, identity)` → runs-service `spent_cents`
5. `credited_cents = paid_topups + local_credits` ; `balance_cents = credited_cents − usage`

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
| `GET` | `/v1/accounts` | account snapshot (credited, usage, balance, topup config) |
| `GET` | `/v1/accounts/balance` | shortcut: `{ balance_cents, depleted }` |
| `PATCH` | `/v1/accounts/auto_topup` | configure auto-topup |
| `DELETE` | `/v1/accounts/auto_topup` | disable auto-topup |
| `POST` | `/v1/checkout-sessions` | one-shot top-up via Stripe Checkout |
| `POST` | `/v1/portal-sessions` | Stripe Customer Portal session |
| `POST` | `/v1/customer_balance/authorize` | check if `balance_cents >= amount` ; auto-reload via PI if configured |
| `POST` | `/v1/customer_balance/usage_apply` | proactive topup hint after a run; no-op for the ledger |
| `POST` | `/v1/promotion_codes/redeem` | redeem promo code → insert `local_promos` row |
| `POST` | `/internal/credits/grant` | platform-issued grant — body `{orgId, amountCents, reason: invite_reward\|invite_welcome}` → `{ok, newBalanceCents}`. Idempotent on `(orgId, reason)`. `invite_welcome` replaces the existing `$2` welcome row. Used by api-service invite claim handler (DIS-64). |
