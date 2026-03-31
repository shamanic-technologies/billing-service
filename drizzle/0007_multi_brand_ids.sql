-- Migrate brand_id (single text) to brand_ids (text array) for multi-brand support
ALTER TABLE "credit_provisions" ADD COLUMN "brand_ids" text[];--> statement-breakpoint
UPDATE "credit_provisions" SET "brand_ids" = ARRAY["brand_id"] WHERE "brand_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_provisions" DROP COLUMN "brand_id";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credit_provisions_brand_ids" ON "credit_provisions" USING gin ("brand_ids");
