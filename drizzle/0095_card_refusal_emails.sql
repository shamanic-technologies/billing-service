-- REFUSED-CARD-EMAIL-EACH-1103 (owner 2026-11-03): « ca doit etre un email
-- transactionnel automatique a chaque fois quon essaie et que sa carte est refusée ».
-- One row per refused charge the customer was mailed about, keyed on the
-- acquirer's charge reference: an idempotent replay of the same charge answers the
-- same reference and is not a new attempt, so it mails nothing (lib/card-refused-email).
-- New table only, no row touched. Idempotent.
CREATE TABLE IF NOT EXISTS "card_refusal_emails" (
  "charge_key" text PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "amount_cents" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
