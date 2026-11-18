-- ANSWERING A PERSON WHO WROTE TO US IS NEVER BLOCKED BY AN EMPTY BALANCE (REPLY-NO-BALANCE-1118).
-- campaign-service admits a run that carries ONE person waiting on our answer even when the
-- org's prepaid balance cannot afford it, and records the admission here. While a pass of the
-- campaign is live, `POST /v1/customer_balance/authorize` grants that campaign's spends that the
-- balance alone would refuse (no reload possible): the spend lands on the balance like any other.
-- One row per admitted run, append-only, expires after its TTL. Never written by hand.
CREATE TABLE IF NOT EXISTS answer_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  run_id uuid NOT NULL,
  brand_id uuid,
  lead_id uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answer_passes_live ON answer_passes (org_id, campaign_id, expires_at);
