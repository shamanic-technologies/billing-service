-- One owner Telegram per client going through the card page (lib/stripe-step-alert,
-- OWNER-PING-BUDGET-1027). Written at the card step, sent once the campaign budgets
-- the client states seconds later have landed: `due_at` starts a minute out and each
-- cap write pushes it back (bounded). `settled_at` = sent, skipped or given up.
CREATE TABLE IF NOT EXISTS "owner_stripe_step_alerts" (
  "dedup_key" text PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "stripe_line" text NOT NULL,
  "accepted_line" text,
  "actor_email" text,
  "actor_user_id" text,
  "due_at" timestamp with time zone NOT NULL,
  "settled_at" timestamp with time zone,
  "outcome" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_owner_stripe_step_alerts_pending" ON "owner_stripe_step_alerts" ("org_id") WHERE "settled_at" IS NULL;
