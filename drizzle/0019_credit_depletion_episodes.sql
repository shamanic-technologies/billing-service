-- Out-of-credit dunning engine (issue #147).
-- Tracks one depletion "episode" per org: opened when an authorize concludes
-- depleted with campaign activity, closed (recovered_at) when balance is
-- restored. Per-stage *_sent_at stamps enforce at-most-once-per-stage emails.
-- Idempotent: safe to re-run on partial apply.
CREATE TABLE IF NOT EXISTS "credit_depletion_episodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "run_id" uuid,
  "campaign_id" uuid,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "t0_sent_at" timestamp with time zone,
  "followup_3d_sent_at" timestamp with time zone,
  "followup_10d_sent_at" timestamp with time zone,
  "recovered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- At most one OPEN (un-recovered) episode per org. A fresh depletion after a
-- recovery is allowed (recovered_at set on the prior row) → the sequence re-arms.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_one_open_episode_per_org"
  ON "credit_depletion_episodes" ("org_id")
  WHERE "recovered_at" IS NULL;

-- Scheduler scans open episodes (recovered_at IS NULL).
CREATE INDEX IF NOT EXISTS "idx_credit_depletion_open"
  ON "credit_depletion_episodes" ("recovered_at");
