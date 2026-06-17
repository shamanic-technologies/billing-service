# billing-service — repo conventions

## Tests need a local Postgres (not mocked) — start it before `pnpm test`

The suite hits a real Postgres: `tests/setup.ts` connects to `process.env.BILLING_SERVICE_DATABASE_URL || "postgresql://test:test@localhost/test"` and hand-builds the schema in `beforeAll`. With no DB running, EVERY suite that imports `src/db` fails with `AggregateError [ECONNREFUSED] ::1:5432` (looks like a code break — it is NOT). First-time setup on this machine:

```bash
brew services start postgresql@14
psql -d postgres -c "CREATE ROLE test LOGIN PASSWORD 'test' SUPERUSER"
createdb -O test test
```

Then `pnpm test` (vitest, `fileParallelism:false`, `maxWorkers:1`). Diagnose an ECONNREFUSED as "Postgres not running", never as a regression from the diff.

## Migrations are hand-authored AND hand-journaled — the journal is the apply-gate

This repo does NOT use `drizzle-kit generate`. `drizzle/meta/` snapshots stop at `0007`; every migration from `0008` onward is hand-written SQL, and `drizzle/meta/_journal.json` is maintained by hand. The boot migrator (`drizzle-orm/postgres-js/migrator` in `src/index.ts`, run before `app.listen()`) applies **only migrations listed in `_journal.json`** — a `drizzle/NNNN_*.sql` file with **no journal entry is silently skipped at boot and never runs in prod.**

When adding a migration:
1. Write `drizzle/NNNN_<name>.sql` (idempotent — `IF NOT EXISTS` / `ON CONFLICT` / single-row `UPDATE`).
2. Add a matching `_journal.json` entry with `when` **strictly greater than the previous entry's `when`** (the migrator gates on `when > last_applied.created_at`; the `idx`/filename number is cosmetic, drizzle reads by `tag`).
3. Verify on a Neon temp branch off production: run the real `migrate()` and confirm the row count / column change, plus that no unintended rows moved.

**Known live trap:** `0017_invite_promo_codes.sql` is unjournaled → it **never ran in prod**, so `invite_reward`/`invite_welcome` codes are absent and `POST /internal/credits/grant` throws `GrantPromoCodeMissingError` in prod (DIS-64 latent bug). Don't copy the "just drop a .sql file" pattern — always journal. (`0018` bumped the welcome gift to $25 and IS journaled.)

**Parallel-branch collision (Conductor):** because both the filename number AND `when` are hand-picked, two branches developed in parallel routinely both claim the same next number (`0019`) with the **same `when`**. They merge cleanly as files (different tag = different filename) but the journal entries collide: each branch's boot already recorded its own migration at that `when`, so the OTHER migration fails the `when > max` gate and is **silently skipped forever** on that branch. Resolution at sync time: keep BOTH journal entries and give each a `when` **strictly greater than the highest already-applied** (e.g. `+86400000` apart). This forces a one-time **idempotent re-apply** of the already-applied one on its own branch — which is why migrations MUST be idempotent (step 1). Verify both tags appear in `_journal.json` with strictly increasing `when` before merging the sync PR. (Incident 2026-06-12: `0019_welcome_amount_200` (main, v0.28.3) vs `0019_credit_depletion_episodes` (staging, dunning) both at `when:1789725600000` → main→staging auto-sync PR #153 conflicted; resolved in #154.)

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

The only persistent ledger billing-service owns. One row per (org, promo_code) — `UNIQUE (org_id, promo_code_id)`. Welcome trial = `code='welcome'` ($2 grant; seeded @$2 by migration 0016, bumped to $25 by 0018, reverted to $2 by 0019). First paid wallet load match = `code='first_load_match'` (technical code seeded at 0; actual dynamic match amount is stored on the `local_promos` row, dollar-for-dollar capped at $25, once per org). Other codes are admin-managed.

**Re-pricing a promo code at runtime (NO migration):** `PATCH /internal/promo-codes/:code` body `{ amountCents }` updates `local_promo_codes.amount_cents` in place (`GET /internal/promo-codes/:code` reads it). This is the live source read at redeem time, so it changes what NEW signups receive immediately — use this to re-price the welcome gift, not a migration. Service-auth only; the gateway must gate it to staff. Migrations are now only for the SEED DEFAULT (a fresh prod DB) — a `WELCOME_PROMO_AMOUNT_CENTS` change still wants a migration so the default is right on the next deploy, but day-to-day amount tweaks go through the endpoint.

**Changing the welcome SEED DEFAULT (migration path) = 4 sites in lockstep (tests do NOT run drizzle migrations — they hand-build schema + seed in `tests/setup.ts`):** (1) `drizzle/NNNN_*.sql` migration row + journal entry, (2) `WELCOME_PROMO_AMOUNT_CENTS` in `src/db/schema.ts` + its comment, (3) the `local_promo_codes` welcome seed in `tests/setup.ts`, (4) the welcome-amount assertions in `tests/integration/{promo,accounts}.test.ts`. Miss (3)/(4) and the suite goes red (or worse, silently asserts the old amount). The `INVITE_GRANT_AMOUNT_CENTS` / `invite_welcome` / `invite_reward` path is independent — leave it at 2500.

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

- **Two read surfaces, split by whether an end-user is in context:**
  - **Real-user paths** (`GET /v1/accounts`, `POST /v1/customer_balance/usage_apply` direct compose, `redeem`, `checkout`, `reload`): customer fetch is **org-implicit** via `GET /v1/customers?limit=1` (resolved server-side from `x-org-id`). **stripe-service still REQUIRES `x-user-id` on these `/v1/*` reads (its header validation 400s without it) even though the lookup keys on `x-org-id` only** — so any identity passed to `getCustomerByOrg`/`sumSucceededTopupsForCustomer`/`hasAttachedCardPm`/`listCustomersByMetadata`/`updateCustomer` MUST carry `x-user-id`. When there's no real user (the `transfer-brand` admin op), pass the `INTERNAL_IDENTITY` sentinel (`x-user-id: 00000000-0000-0000-0000-000000000000`). Tests that mock these do NOT catch a missing `x-user-id` — it 500s only against the live service.
  - **Balance path** (`computeBalance` → affordability gate + dunning scheduler + authorize): reads stripe-service via the **user-less, org-keyed `/internal/<resource>/by-org/{orgId}` routes** (stripe-service#77/#79) — `fetchOrgCustomer` / `sumSucceededTopupsForOrg` / `hasChargeablePmForOrg` send **X-API-Key + org ONLY: NO `x-user-id`, NO sentinel**. There is no end-user on this path, so no fake identity is invented. `computeBalance(orgId)` takes no `identity` arg (the runs-service `/internal/org-usage-total` read needs only `org_id`). **Never reintroduce an `x-user-id` sentinel on the balance path** — that was the v0.31.1 band-aid (PR #176/#178), superseded once stripe-service shipped the user-less surface. The `/v1/*` real-user reads above are a SEPARATE surface — do not collapse `computeBalance` onto them, and do not move the `/v1/*` callers onto `/internal/*by-org`.
- Balance is derived from the Stripe customer object: `balance_cents = -customer.balance` (sign-flip, Stripe convention is `balance > 0` = customer owes).
- `has_payment_method` is derived from whether the customer has ≥1 attached **chargeable** PM — a `card` **or** a `link` PM (`hasAttachedCardPm` → `GET /v1/payment_methods?type=card`, then `type=link` if no card). **Link PMs ARE chargeable off_session** when passed as an explicit `payment_method` id (Stripe documents `off_session:true, confirm:true` on a saved `type:link` PM exactly like a card — https://docs.stripe.com/payments/link/save-and-reuse). A normal Checkout setup-mode flow offers card+link and saves `type:link` for Link-enabled emails, so a **card-only gate wrongly reported "no payment method"** for those orgs and 400'd `PATCH /v1/accounts/auto_topup` forever (v0.29.1 fix, GH #162). It deliberately does **not** read `customer.invoice_settings.default_payment_method`: Stripe leaves it null after `setup_future_usage`, AND the **default-PM *fallback* path** (PI with no explicit `payment_method`) genuinely fails for Link (the original DIS-43 400) — but that is the fallback, not an explicit link-PM charge. We list PMs by type and pass an explicit id instead. This mirrors exactly what `reload.ts` charges (first card, then link fallback). The same `hasAttachedCardPm` gate fronts auto-reload in `authorize` + `usage_apply` and the `PATCH /v1/accounts/auto_topup` PM requirement. Fail-loud: a stripe-service error propagates (502); only an empty card AND link list → false.
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
  "has_payment_method": true,                // ≥1 chargeable PM: card OR link (GET /v1/payment_methods?type=card, then type=link); NOT invoice_settings.default_payment_method
  "has_auto_topup": true,
  "created_at": "...",
  "updated_at": "..."
}
```

All three credited/usage/balance endpoints fail loud (502) when runs-service or stripe-service is unreachable.

Composition (`src/routes/accounts.ts:composeAccountFunds`):
1. `getCustomerByOrg(identity)` → Stripe customer (for `id`)
2. `sumSucceededTopupsForCustomer(identity, customer.id)` → paginates `GET /v1/payment_intents?customer=cus_X` and sums `amount_received` where `status='succeeded'`
3. `sumLocalPromoCreditsForOrg(orgId)` → SUM `local_promos.amount_cents`
4. `fetchRunsOrgUsageTotal(orgId, identity)` → runs-service `spent_cents`
5. `hasAttachedCardPm(identity, customer.id)` → `has_payment_method` (≥1 chargeable PM: card or link)
6. `credited_cents = paid_topups + local_credits` ; `balance_cents = credited_cents − usage`

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
| `PATCH` | `/v1/accounts/auto_topup` | configure auto-topup; body must include both `topup_amount_cents` and `topup_threshold_cents` |
| `POST` | `/v1/accounts/wallet_setup` | first-campaign wallet setup: requires `initial_load_amount_cents`, `topup_amount_cents`, `topup_threshold_cents`; charges the initial load, stores org auto-topup config, grants `first_load_match` up to $25 once |
| `DELETE` | `/v1/accounts/auto_topup` | disable auto-topup |
| `POST` | `/v1/checkout-sessions` | one-shot top-up or setup-mode PM capture via Stripe Checkout; does NOT configure auto-topup |
| `POST` | `/v1/portal-sessions` | Stripe Customer Portal session |
| `POST` | `/v1/customer_balance/authorize` | check if `balance_cents >= amount` ; auto-reload via PI if configured |
| `POST` | `/v1/customer_balance/usage_apply` | proactive topup hint after a run; no-op for the ledger |
| `POST` | `/v1/promotion_codes/redeem` | redeem promo code → insert `local_promos` row |
| `DELETE` | `/internal/accounts/by-org/:orgId` | client-service org teardown leg. Service-auth only; `:orgId` is the internal org UUID. Deletes billing-owned org rows (`billing_accounts`, `local_promos`, `credit_depletion_episodes`, `campaign_authorize_costs`, `brand_daily_budgets`, `welcome_credit_claims`) in one transaction. Idempotent: no rows → success. No cross-service fan-out. |
| `POST` | `/internal/credits/grant` | platform-issued grant — body `{orgId, amountCents, reason: invite_reward\|invite_welcome}` → `{ok, newBalanceCents}`. Idempotent on `(orgId, reason)`. `invite_welcome` replaces the existing `$25` welcome row. Used by api-service invite claim handler (DIS-64). |
| `POST` | `/internal/dunning/tick` | run one out-of-credit dunning pass (ops/manual). Same pass runs on the in-process hourly scheduler. → `{processed, recovered, followup3dSent, followup10dSent}`. |
| `GET` | `/internal/campaigns/:campaignId/affordability` | READ-ONLY pre-flight gate (campaign-service). → `{affordable, balanceCents, lastRequiredCents, hasHistory}`. ZERO side effects. See "Campaign affordability gate" below. |
| `GET` | `/internal/brands/:brandId/daily-budget` | READ a brand's current daily budget (campaign-service, api-key only, no user). → `{brandId, dailyBudgetCents, updatedAt}`; unset brand → `dailyBudgetCents:null, updatedAt:null`. See "Per-brand daily budget" below. |
| `PATCH` | `/v1/brands/:brandId/daily-budget` | SET/UPDATE a brand's daily budget (user via gateway, org headers). body `{dailyBudgetCents}` (non-negative; 0 = pause). → `{brandId, orgId, dailyBudgetCents, updatedAt}`. |

## Per-brand daily budget (pacing ceiling — NOT affordability)

Each brand carries exactly ONE current **daily budget** — the per-day spend ceiling for that brand's active work. A scalar, mutable: changing it re-paces future work on campaign-service's next loop. This is an **allocation / pacing** concept ("how much should THIS brand spend per day"), DISTINCT from the org credit balance/affordability ("can the org pay right now") — the two never mix. billing-service only **stores + serves** this value; **enforcement** (summing today's spend vs the ceiling, stop-when-exceeded) is **campaign-service's job**.

**State:** one table, `brand_daily_budgets` (migration `0022`, hand-journaled) — `brand_id` PK, `org_id`, `daily_budget_cents numeric(16,10)`, `updated_at`. One row per brand, upserted in place (`ON CONFLICT (brand_id) DO UPDATE`). `src/lib/brand-budgets.ts` owns the upsert + read. Mirrors the per-campaign `campaign_authorize_costs` single-row pattern.

- **Read** (`GET /internal/brands/:brandId/daily-budget`, `src/routes/brand_budgets.ts`, **api-key only — no user context**): campaign-service calls this per loop on a scheduler, keyed by brandId. No row → `dailyBudgetCents:null` (a legitimate unset state, distinct from an explicit `0` pause). 400 on a non-UUID brandId.
- **Write** (`PATCH /v1/brands/:brandId/daily-budget`, requireOrgHeaders): the user via the gateway. `org_id` captured from `x-org-id` for provenance; value keyed by brandId. `dailyBudgetCents` validated via `parseNonNegativeCents` (allows 0, rejects negative; fractional cents OK). A subsequent read reflects the latest write.

**Follow-ups (other repos, not built here):** api-service gateway proxy for the user `PATCH`; campaign-service reads the internal `GET` per loop + enforces; dashboard UI to set it.

## Campaign affordability gate (read-only pre-flight)

Stops a credit "retry storm": an out-of-credit org's recurring campaign was re-triggered every minute by campaign-service, each run doing paid Apollo enrichment then 402-ing at the LLM step. campaign-service now asks billing "can this org afford another run of campaign X?" BEFORE dispatching — billing answers live, per-campaign, **without charging or reloading**.

**Cost estimate (no up-front truth).** The run's cost isn't known before the run. We use the `required_cents` of the **LAST authorize attempt for that campaign** as the estimate — a campaign re-runs the same workflow, so cost is ~constant. The estimate is upserted in `POST /v1/customer_balance/authorize`: when `x-campaign-id` is present, `upsertCampaignAuthorizeCost(campaignId, orgId, requiredCents)` runs right after `requiredCents` resolves, on **both sufficient and insufficient** outcomes (it's the cost of the last attempted run). Absent `x-campaign-id` (dashboard chats) → skipped; never fails the authorize. Fail-loud on a write error. Does NOT touch the reload / depletion / response-shape flow.

**State:** one table, `campaign_authorize_costs` (migration `0021`, hand-journaled) — `campaign_id` PK, `org_id`, `last_authorize_required_cents numeric(16,10)`, `updated_at`. One row per campaign, upserted in place (`ON CONFLICT (campaign_id) DO UPDATE`). `src/lib/campaign-costs.ts` owns the upsert + read.

**`GET /internal/campaigns/:campaignId/affordability`** (`src/routes/internal.ts`, service-auth, READ-ONLY — no charge, no reload, no episode mutation):
- No stored cost → `{affordable:true, balanceCents:"0", lastRequiredCents:null, hasHistory:false}` (first-run default — a brand-new campaign runs once to establish its cost; the org isn't resolvable without a stored row, hence `balanceCents:"0"`).
- Stored cost → live balance via `computeBalance(stored.orgId)` (user-less balance path — X-API-Key + org only, NO `x-user-id`/sentinel, see stripe-service integration shape); `affordable = balanceCents >= lastRequiredCents`, `hasHistory:true`. Fail-loud 502 if stripe/runs unreachable. 400 on non-UUID `campaignId`.

## Out-of-credit dunning engine (issue #147)

Emails a customer whose recurring campaign stopped because credit hit zero — instant, then +3d and +10d while still depleted; stops the moment they recharge. billing-service owns it because it knows both the balance and the auto-topup/reload lifecycle. The dashboard banner/modal (distribute.you#1418) is the in-app half; this is the email half. Email **copy** is owned by the dashboard (templates registered in `instrumentation.ts`, distribute.you#1420) — billing only triggers by `eventType`.

**State:** one table, `credit_depletion_episodes` (migration `0019`, hand-journaled). A **partial unique index `(org_id) WHERE recovered_at IS NULL`** enforces at-most-one OPEN episode per org — this is the idempotency + re-arm mechanism (a fresh depletion only opens after the prior episode recovered). Per-stage `t0_sent_at` / `followup_3d_sent_at` / `followup_10d_sent_at` give at-most-once-per-stage. `credited_cents_at_open` (migration `0020`, `numeric(16,10)`, nullable) records the `credited` snapshot at depletion — the recovery baseline (see Scheduler).

**Detect (T0):** in `customer_balance/authorize`, every `sufficient:false` return calls `openDepletionEpisodeIfDepleted` (`src/lib/dunning.ts`). It self-gates: opens only when `isDepleted(balance)` (balance ≤ 0) AND the request carries **campaign activity** (`x-campaign-id` OR `x-workflow-slug` OR `x-feature-slug`). Open = INSERT relying on the partial-unique index; a `23505` unique violation means "already open" → no-op (T0 not re-sent). Other errors fail loud. On a fresh open it fires the `credit-depleted` email. (Replaced the old un-idempotent inline `credits-depleted` sends; the legacy `credits-reload-failed` send is unchanged.)

**Scheduler (`src/lib/dunning-scheduler.ts`):** in-process self-rescheduling `setTimeout` loop started after `migrate()`, before `app.listen()` (mirrors campaign-service). Hourly. `runDunningTick` scans open episodes, recomputes balance via `src/lib/balance.ts` (shared with the route), and per episode: **real recharge** (`credited` rose above `credited_cents_at_open`) → set `recovered_at`, no email (stop-on-recharge); still depleted → send due `+3d`/`+10d` via **atomic claim** (`UPDATE … WHERE <stage> IS NULL RETURNING`) so overlapping ticks / multiple replicas never double-send. A per-episode balance-recompute failure is logged and skipped (retried next tick) — never blocks other orgs.

**Recovery is keyed on `credited` rising, NOT on `balance > 0` (migration 0020, v0.30.1, GH #170).** `usage` (runs-service `spent_cents`) includes **provisioned holds**, so `balance = credited − usage` flutters around zero as holds reserve/release on an org running campaigns at ~0 balance. The pre-0020 code closed the episode on any `balance > 0` tick, then the next depleted authorize re-armed a fresh episode + fired a **new T0 email** — customers got duplicate "out of credit" emails (3 orgs, up to 5× each). `credited` (paid topups + promos) only ever *rises*, so it never flutters: a recharge is the only thing that closes an episode. Follow-ups still gate on `isDepleted(balance)` at tick time (a transient positive balance sends nothing, leaves the episode open). Rows opened before `0020` (null baseline) are lazily backfilled on the next tick (`credited_cents_at_open = creditedNow`, no recovery that tick). **Never revert recovery to a `balance`-based check** — that reintroduces the duplicate-email bug.

**Recipient:** `recipientEmail` = the Stripe customer billing email (`customer.email`, on the wire from stripe-service `GET /v1/customers`); when null the email-service resolves via `x-user-id`. eventTypes are **byte-equal** to the dashboard templates (`DUNNING_EVENT_*` in `schema.ts`): `credit-depleted`, `credit-depleted-followup-3d`, `credit-depleted-followup-10d` — these are NOT in transactional-email-service's dedup sets, so dedup is entirely billing-side. No new env vars (reuses `TRANSACTIONAL_EMAIL_SERVICE_*`, `STRIPE_SERVICE_*`, `RUNS_SERVICE_*`).
