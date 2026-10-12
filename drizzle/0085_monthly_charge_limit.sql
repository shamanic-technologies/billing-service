-- MONTHLY CHARGE LIMIT (owner 2026-10-12): « whatever happens, my card is never
-- charged more than $X a month ». ONE limit per org, everything included, monthly
-- only (UTC calendar month). No row = no limit = today's behaviour exactly; no
-- default is written onto any existing account.
--
-- monthly_charge_limits: the limit the customer stated (cents, >= 0).
-- monthly_charge_limit_refusals: one row per (org, month) once an AUTOMATIC charge
-- was refused because it would pass the limit. Positive evidence for "the limit is
-- why spending stopped", and the once-per-month claim of the customer email
-- (notified_at). Any change of the limit deletes the current month's row.
--
-- Writes no rows. Idempotent. Reverse:
--   DROP TABLE monthly_charge_limit_refusals; DROP TABLE monthly_charge_limits;
CREATE TABLE IF NOT EXISTS "monthly_charge_limits" (
  "org_id" uuid PRIMARY KEY NOT NULL,
  "limit_cents" integer NOT NULL,
  "set_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "monthly_charge_limits_non_negative" CHECK ("limit_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monthly_charge_limit_refusals" (
  "org_id" uuid NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "limit_cents" integer NOT NULL,
  "charged_cents" integer NOT NULL,
  "refused_amount_cents" integer NOT NULL,
  "first_refused_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_refused_at" timestamp with time zone DEFAULT now() NOT NULL,
  "notified_at" timestamp with time zone,
  CONSTRAINT "monthly_charge_limit_refusals_pk" PRIMARY KEY ("org_id", "period_start")
);
