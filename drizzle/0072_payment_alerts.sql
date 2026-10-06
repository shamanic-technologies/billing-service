-- Owner Telegram alert when a customer pays (owner 2026-10-06: "JE NE RECOIS PAS DE
-- NOTIF QUAND ON A UN CLIENT QUI A PAYE"). Two tables, no row written here.
--
-- payment_alerts: ONE row per payment ever considered, keyed on the acquirer's own
-- payment id (namespaced by acquirer). The primary key IS the exactly-once guarantee:
-- a scan claims a payment with INSERT ... ON CONFLICT DO NOTHING before it sends, so
-- a re-scan, a restart or a second replica can never send twice.
CREATE TABLE IF NOT EXISTS "payment_alerts" (
  "payment_key" text PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "acquirer" text NOT NULL,
  "amount_minor" integer NOT NULL,
  "currency" text NOT NULL,
  "kind" text NOT NULL,
  "payment_number" integer NOT NULL,
  "outcome" text NOT NULL,
  "skip_reason" text,
  "paid_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_alerts_org" ON "payment_alerts" ("org_id");
--> statement-breakpoint
-- payment_alert_signals: what billing itself knows about a payment it caused (an
-- off-session charge and its reason) or a payment a person is about to make (a
-- checkout opened, and by whom). Read only to LABEL a payment and to skip staff's
-- own payments; never to decide whether money moved.
CREATE TABLE IF NOT EXISTS "payment_alert_signals" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "signal" text NOT NULL,
  "kind" text,
  "reference" text,
  "amount_minor" integer,
  "actor_email" text,
  "matched_payment_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_alert_signals_org_created" ON "payment_alert_signals" ("org_id", "created_at");
