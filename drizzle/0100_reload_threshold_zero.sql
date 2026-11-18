-- The reload threshold is $0 for EVERY org, editable nowhere (owner 2026-11-18:
-- « enelveant definitivement le seuil de $5. On mets $0 pour tout le monde. On ne
-- permet as de changer cette valeur nulle part »). RELOAD-RULE-ONE-HOME-1118.
-- The code reads RELOAD_THRESHOLD_CENTS (0) whatever is stored; this aligns the rows.
-- topup_threshold_cents stays non-null where it was (non-null + amount = auto top-up on).
-- Idempotent.
ALTER TABLE "billing_accounts" ALTER COLUMN "topup_threshold_cents" SET DEFAULT 0;--> statement-breakpoint
UPDATE "billing_accounts" SET "topup_threshold_cents" = 0 WHERE "topup_threshold_cents" IS NOT NULL AND "topup_threshold_cents" <> 0;--> statement-breakpoint
UPDATE "billing_accounts" SET "reload_threshold_minimum_cents" = NULL WHERE "reload_threshold_minimum_cents" IS NOT NULL;
