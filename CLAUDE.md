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

## Fractional cents

`transactions.amount_cents` and `billing_accounts.credit_balance_cents` are `numeric(16,10)`. Drizzle returns them as JS strings — never cast with `Number()` for math (precision loss). Use `parseFloat` for display only; for arithmetic in JS, use `BigInt`-scaled or `numeric.js`-style. Do NOT round inside billing — runs-service sends raw fractional, ledger preserves it.

Stripe `customers.createBalanceTransaction` only takes integer cents. The Stripe-sync layer in `src/lib/ledger.ts` ceils ledger balance and only fires a balance txn when the integer floor crosses a boundary. Stripe is fire-and-forget visibility; ledger is source of truth.
