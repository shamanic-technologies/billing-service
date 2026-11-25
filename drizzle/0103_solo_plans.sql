-- SOLO-PLAN-1125: the solo-founder plan (owner 2026-11-25), lib/solo-plan.
-- One row per org on the plan; nothing existing is touched (an org is on the plan only
-- once a caller enrols it, and its billing account then carries free_credit_offer
-- 'solo_founder'). Unspent credit expiring at a cycle end reuses
-- subscription_credit_expiries (subscription_id = this plan's id), so every balance path
-- already subtracts it.
CREATE TABLE IF NOT EXISTS solo_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  -- free | trialing | active | past_due
  status text NOT NULL DEFAULT 'free',
  monthly_amount_cents integer NOT NULL DEFAULT 9900,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  -- The spendable balance the trial may not go below: balance at trial start - $10.
  trial_floor_cents numeric(16,10),
  trial_hold_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  renewal_anchor_at timestamptz,
  -- A card page was handed out: the read / sweep start the plan once the card is on file (48 h).
  start_requested_at timestamptz,
  -- A layer charge in flight (optimistic claim, released after the charge).
  pending_change_at timestamptz,
  started_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT solo_plans_org_unique UNIQUE (org_id),
  CONSTRAINT solo_plans_status_check CHECK (status IN ('free', 'trialing', 'active', 'past_due'))
);
--> statement-breakpoint
-- Every charge of the plan: trial conversion, renewal, a +$100 layer, start without trial.
CREATE TABLE IF NOT EXISTS solo_plan_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL,
  org_id uuid NOT NULL,
  -- trial_conversion | renewal | layer | first_month
  kind text NOT NULL,
  period_start timestamptz NOT NULL,
  monthly_amount_cents integer NOT NULL,
  -- What was asked of the card (a layer: new amount - unspent credit).
  amount_cents integer NOT NULL,
  unspent_discount_cents integer NOT NULL DEFAULT 0,
  -- pending | paid | failed
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  first_failed_at timestamptz,
  last_attempt_at timestamptz,
  paid_at timestamptz,
  reference text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT solo_plan_charges_period_kind UNIQUE (plan_id, period_start, kind)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_solo_plan_charges_org ON solo_plan_charges (org_id);
