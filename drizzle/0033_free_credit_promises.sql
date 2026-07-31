-- Free-credit promises: an org may carry SEVERAL outstanding free-credit promises
-- at once, each with its own frozen amount and its own frozen bar.
--
-- Until now an org had exactly ONE outstanding promise, expressed as two columns on
-- billing_accounts (free_credit_entitlement_cents / free_credit_paid_trigger_cents)
-- and settled once by the welcome-completion path. The referral offer breaks that
-- shape: a customer who invites someone gets $500, and so does the person they
-- invited, and an inviter who converts ten referrals carries ten promises at once.
-- A single pair of numbers on the account cannot express that.
--
-- One row per promise:
--   amount_cents        what lands when it is earned (FROZEN at creation)
--   paid_trigger_cents  the bar: cumulative SUCCEEDED payments, net of refunds and
--                       lost disputes, that earn it (FROZEN at creation)
--   referrer_org_id     set on the INVITEE's promise — who referred this org. It is
--                       what lets the invitee's grant open the inviter's promise.
--   referred_org_id     set on the INVITER's promise — which referred org converted
--                       and caused it. The dashboard renders that org.
--   granted_at          NULL while outstanding. An outstanding promise is a promise,
--                       not money: no local_promos row exists until it is granted, so
--                       it never enters credited / balance / spendable anywhere.
--
-- The bar of a NEW promise is (highest bar this org already carries) + (its own
-- amount), whether or not the earlier one has been earned — cumulative payments only
-- go up, so the ladder is the same either way. A $400 account referred a $500 promise
-- carries $400 @ $400 and $500 @ $900; a third promise sits at $1,400; no ceiling.
--
-- Grandfathering, same discipline as 0032: amount + bar are written once and never
-- updated, so re-pricing the referral offer reaches only promises created after the
-- re-price, with no cutoff date and no backfill. The amount a NEW referral promise
-- freezes is read from the `referral_reward` local_promo_codes row, which is already
-- re-priceable at runtime through PATCH /internal/promo-codes/:code.
--
-- Idempotency is structural, three partial unique indexes:
--   - one welcome promise per org
--   - one referred-claim per org (an org is referred once; a re-claimed invite is a
--     no-op, a claim by a DIFFERENT inviter is rejected)
--   - one inviter promise per (inviter, invitee) pair, so a replayed settle or a
--     concurrent one can never open two.

CREATE TABLE IF NOT EXISTS "free_credit_promises" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "paid_trigger_cents" integer NOT NULL,
  "referrer_org_id" uuid,
  "referred_org_id" uuid,
  "granted_at" timestamp with time zone,
  "granted_local_promo_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "free_credit_promises_kind_check"
    CHECK ("kind" IN ('welcome', 'referral'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_free_credit_promises_org_welcome"
  ON "free_credit_promises" ("org_id") WHERE "kind" = 'welcome';

CREATE UNIQUE INDEX IF NOT EXISTS "idx_free_credit_promises_org_referrer"
  ON "free_credit_promises" ("org_id") WHERE "referrer_org_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_free_credit_promises_org_referred"
  ON "free_credit_promises" ("org_id", "referred_org_id") WHERE "referred_org_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_free_credit_promises_org"
  ON "free_credit_promises" ("org_id");

CREATE INDEX IF NOT EXISTS "idx_free_credit_promises_outstanding"
  ON "free_credit_promises" ("granted_at") WHERE "granted_at" IS NULL;

-- Ledger key for a granted referral promise. Per-row amount lives on local_promos
-- (like admin_grant / welcome_completion), so the code row's amount_cents is NOT a
-- placeholder here: it is the amount a NEW referral promise freezes ($500 today).
-- Re-price it through PATCH /internal/promo-codes/referral_reward — no migration,
-- and every promise already created keeps its own frozen figure.
INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('referral_reward', 50000, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;

-- Backfill the welcome promise every eligible account already carries, from the
-- figures frozen on its own row — so an existing org's amount and bar are copied,
-- never recomputed, and nothing about its offer changes. An account already granted
-- its welcome completion is backfilled as GRANTED (linked to the row that granted
-- it), so it is not re-offered and does not show as outstanding.
--
-- Ineligible accounts are deliberately skipped: their welcome promise can never be
-- granted (they crossed the trigger before the automation launched), so materialising
-- one would put a promise on the dashboard that is not coming.
INSERT INTO "free_credit_promises"
  ("org_id", "kind", "amount_cents", "paid_trigger_cents", "granted_at", "granted_local_promo_id")
SELECT
  a."org_id",
  'welcome',
  a."free_credit_entitlement_cents",
  a."free_credit_paid_trigger_cents",
  g."created_at",
  g."id"
FROM "billing_accounts" a
LEFT JOIN LATERAL (
  SELECT p."id", p."created_at"
  FROM "local_promos" p
  JOIN "local_promo_codes" c ON c."id" = p."promo_code_id"
  WHERE p."org_id" = a."org_id" AND c."code" = 'welcome_completion'
  ORDER BY p."created_at"
  LIMIT 1
) g ON true
WHERE a."welcome_completion_eligible" = true
ON CONFLICT DO NOTHING;
