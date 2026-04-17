CREATE TABLE IF NOT EXISTS "promo_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "max_redemptions" integer,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_promo_codes_code" ON "promo_codes" USING btree ("code");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promo_redemptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promo_code_id" uuid NOT NULL REFERENCES "promo_codes"("id"),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "amount_cents" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_promo_redemptions_org_code" ON "promo_redemptions" USING btree ("promo_code_id", "org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_promo_redemptions_org_id" ON "promo_redemptions" USING btree ("org_id");
