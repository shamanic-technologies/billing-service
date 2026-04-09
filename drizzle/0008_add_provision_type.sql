ALTER TABLE "credit_provisions" ADD COLUMN "type" text DEFAULT 'debit' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_provisions" ADD COLUMN "stripe_payment_intent_id" text;
