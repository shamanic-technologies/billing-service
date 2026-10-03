-- A plan may carry any whole-dollar amount from $29 (owner 2026-10-03: "stay for
-- less" in the cancel flow). The $99 + k x $100 ladder is gone; the rule lives in
-- lib/subscription `monthlyAmountRefusal`. This only relaxes the floor check.
--
-- Writes no row. Idempotent (drop + re-add). Reverse (only while no plan is below $99):
--   ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_amount_check;
--   ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_amount_check CHECK (monthly_amount_cents >= 9900);
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_amount_check";
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_amount_check" CHECK ("monthly_amount_cents" >= 2900);
