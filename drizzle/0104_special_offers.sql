-- Special offers (SPECIAL-OFFER-BF-1127, owner 2026-11-27): a NAMED, dated commercial
-- offer (first: "Black Friday 2026") kept apart from the standing offers (welcome,
-- referral rewards, trial seed, staff admin_grant), so a client can later see what
-- that offer brought him: the payments he made under it and the free credit it gave.
--
--   special_offers            one row per offer: slug, name, window, default bonus ratio.
--   special_offer_payments    one row per PAYMENT counted under an offer, with the free
--                             credit it granted (a local_promos row under the
--                             `special_offer` ledger key). A payment counts under ONE
--                             offer, once: UNIQUE (payment_acquirer, payment_id).
--
-- The credit is an ordinary local_promos row, so it adds to credited / balance like any
-- grant. It is NOT part of the welcome entitlement and never touches a referral promise
-- (owner: "not cumulative with other offers").
--
-- Idempotent, safe to re-run. Writes no existing row.
-- Reverse: DROP TABLE IF EXISTS special_offer_payments; DROP TABLE IF EXISTS special_offers;
--          DELETE FROM local_promo_codes WHERE code = 'special_offer' AND NOT EXISTS
--            (SELECT 1 FROM local_promos p WHERE p.promo_code_id = local_promo_codes.id);
CREATE TABLE IF NOT EXISTS "special_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "bonus_ratio_bps" integer NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "special_offers_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "special_offers_window" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "special_offers_bonus_ratio" CHECK ("bonus_ratio_bps" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "special_offer_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "special_offer_id" uuid NOT NULL REFERENCES "special_offers" ("id"),
  "org_id" uuid NOT NULL,
  "payment_acquirer" text NOT NULL,
  "payment_id" text NOT NULL,
  "paid_cents" integer NOT NULL,
  "paid_at" timestamp with time zone NOT NULL,
  "free_credit_cents" numeric(16, 10) NOT NULL,
  "local_promo_id" uuid NOT NULL REFERENCES "local_promos" ("id") ON DELETE CASCADE,
  "applied_by" text NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "special_offer_payments_payment_unique" UNIQUE ("payment_acquirer", "payment_id"),
  CONSTRAINT "special_offer_payments_local_promo_unique" UNIQUE ("local_promo_id"),
  CONSTRAINT "special_offer_payments_paid_positive" CHECK ("paid_cents" > 0),
  CONSTRAINT "special_offer_payments_credit_positive" CHECK ("free_credit_cents" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_special_offer_payments_org" ON "special_offer_payments" ("org_id");
--> statement-breakpoint
INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('special_offer', 0, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;
