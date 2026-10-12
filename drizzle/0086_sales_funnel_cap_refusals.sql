-- A spend billing REFUSED because it would take a sales funnel (campaign) past its
-- stated max budget (lib/funnel-cap-authorize.ts). Recorded on the cap row so the
-- caps read serves `reached: true` for the rest of that window at that amount, and
-- campaign-service stops dispatching runs the authorize would refuse anyway.
-- Valid only while window_start = the cap's current window start AND cap_cents =
-- the cap's current amount (a new period or a raised cap frees it). Idempotent.
ALTER TABLE "sales_funnel_caps" ADD COLUMN IF NOT EXISTS "max_budget_refused_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_funnel_caps" ADD COLUMN IF NOT EXISTS "max_budget_refused_cents" numeric(22, 10);
--> statement-breakpoint
ALTER TABLE "sales_funnel_caps" ADD COLUMN IF NOT EXISTS "max_budget_refused_window_start" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sales_funnel_caps" ADD COLUMN IF NOT EXISTS "max_budget_refused_cap_cents" numeric(22, 10);
