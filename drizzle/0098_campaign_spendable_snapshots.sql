-- The last campaign-service spendable-budget answer billing read, per (org, brand)
-- (MON-PAGE-SPEED-1111). GET /v1/accounts/runway sits on every dashboard page and
-- campaign-service took 0.24-2 s to answer it for one brand (prod 2026-11-12), so
-- the runway serves the stored answer at once and refreshes it behind the read.
-- `billing_fingerprint` hashes billing's OWN budget rows for the brand (daily
-- budget, sales budget, funnel caps) at read time: any billing budget write
-- changes it, and a row whose fingerprint no longer matches is never served.
-- A cache of campaign-service's answer, never a source of truth: every successful
-- read overwrites it. Never written by hand.
CREATE TABLE IF NOT EXISTS campaign_spendable_snapshots (
  org_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  body jsonb NOT NULL,
  billing_fingerprint text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id)
);
