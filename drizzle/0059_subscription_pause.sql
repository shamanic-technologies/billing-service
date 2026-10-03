-- A customer can PAUSE a monthly plan ("I need a break") and unpause it later
-- (lib/subscription, pauseSubscription / unpauseSubscription).
--
--   paused_at          set while the plan is paused: the plan's clock is frozen
--                      (no charge, no expiry), and when every live plan of the org
--                      is paused, spending is refused (authorize + affordability).
--   pause_ends_at      when the pause ends on its own (1, 2 or 3 months out).
--   renewal_anchor_at  the date renewals are counted from after an unpause, which
--                      pushes the period end by exactly the paused time. NULL =
--                      the historical anchor (trial end, else creation).
--
-- Additive, writes no row. Prod at ship time: no plan paused (the feature is new).
-- Idempotent. Reverse:
--   ALTER TABLE subscriptions DROP COLUMN IF EXISTS paused_at, DROP COLUMN IF EXISTS pause_ends_at, DROP COLUMN IF EXISTS renewal_anchor_at;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "pause_ends_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "renewal_anchor_at" timestamp with time zone;
