# billing-service — repo conventions

## BYOK (Bring Your Own Key) cost source

`runs_costs.cost_source` ∈ `'platform' | 'org'`. ONLY `platform` rows are billed.

| `cost_source` | Who paid AI provider | We bill the org? |
|---|---|---|
| `platform` | Distribute (our API key) | **Yes** — debits balance via `POST /v1/credits/deduct` |
| `org` | The org (their own API key) | **No** — tracking only, never deducted |

When reconciling or computing real cost: `WHERE rc.status='actual' AND rc.cost_source='platform'`. Including `org` rows would over-state.

## Ledger sources

Canonical `transactions.source` values (post-#82/#83):

| source | type | meaning |
|---|---|---|
| `reload` | credit | Stripe top-up succeeded |
| `welcome` | credit | $2 trial credit on signup |
| `promo` | credit | promo code redemption |
| `charge` | debit | run consumption (lifecycle: `pending` -> `confirmed` or `cancelled`) |
| `refund` | credit | exceptional refund |

`charge` lifecycle: provision inserts `(debit, pending)`; confirm with same amount mutates row to `confirmed`; confirm with $Y != $X mutates original to `cancelled` and inserts a new `(debit, confirmed, $Y)`; cancel mutates to `cancelled`. **No miroir credit rows are ever inserted.** `provision_cancel` and `provision_adjust` are dead sources from the pre-#82 era.

## `cost_id` natural key (post-#92)

`transactions.cost_id` (uuid, nullable, indexed) decouples external callers from the billing-internal `transactions.id`. runs-service issues one provision per `runs_costs.id` and confirms/cancels via `POST /v1/credits/provision/by-cost/:cost_id/{confirm,cancel}` — no billing-side id needed.

By-cost lookup picks the **most recent** row by `created_at` (one cost_id can produce a `pending → cancelled` row plus a fresh `confirmed` replacement when the actual amount differs). Only one row per cost_id is non-terminal at a time. Replacement rows carry the same `cost_id` so subsequent calls still hit the active row.

When confirm produces a replacement (amount mismatch), the `provision_id` field in the response points to the **new** confirmed row, not the cancelled original. By-id endpoints (`/provision/:id/{confirm,cancel}`) remain unchanged for back-compat.

## Fractional cents

`transactions.amount_cents` and `billing_accounts.credit_balance_cents` are `numeric(16,10)`. Drizzle returns them as JS strings — never cast with `Number()` for math (precision loss). Use `parseFloat` for display only; for arithmetic in JS, use `BigInt`-scaled or `numeric.js`-style. Do NOT round inside billing — runs-service sends raw fractional, ledger preserves it.

Stripe `customers.createBalanceTransaction` only takes integer cents. The Stripe-sync layer in `src/lib/ledger.ts` ceils ledger balance and only fires a balance txn when the integer floor crosses a boundary. Stripe is fire-and-forget visibility; ledger is source of truth.
