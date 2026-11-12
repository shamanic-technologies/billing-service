-- campaign-service tells billing when a brand's spendable budget may have changed on
-- ITS side (a campaign started, paused, stopped; MON-PAGE-SPEED-2-1112). The stored
-- answer then stops being served: a row is served only when it was fetched AFTER
-- its last invalidation (`fetched_at` = when the read STARTED). Billing's own budget
-- writes are still caught by `billing_fingerprint`. NULL = never invalidated.
ALTER TABLE campaign_spendable_snapshots ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
