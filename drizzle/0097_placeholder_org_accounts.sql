-- Remove the two billing accounts opened for PLACEHOLDER org ids
-- (MON-FLEET-REVENUE-NIL-ORG-1111, 2026-11-11). Probes sent placeholder identities
-- (`x-org-id: 00000000-0000-0000-0000-000000000001` on 2026-06-12, the nil UUID on
-- 2026-07-31) and `findOrCreateAccount` opened a real account for each, with a trial
-- gift ($2 / $5) and a welcome promise. Every fleet sweep then read them: the fleet
-- revenue read (staff Revenue page, the daily X bio) and the unpaid-debt scan asked
-- runs-service for `org_id=00000000-…-0001` and got `400 Invalid UUID` on every run,
-- listing it as an unreadable org. No client, no run, no card, no payment stands
-- behind either id; `requireOrgHeaders` now refuses a placeholder org, so neither can
-- come back.
--
-- Measured in prod at ship time (only rows any table holds for these ids):
-- billing_accounts 2, local_promos 2 ($2 + $5 gifts), free_credit_promises 2,
-- welcome_recipients 1. Idempotent (keyed DELETE). Reverse: the rows are quoted in
-- the PR (shamanic-technologies/billing-service, MON-FLEET-REVENUE-NIL-ORG-1111).
DELETE FROM "local_promos" WHERE "org_id" IN ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001');
--> statement-breakpoint
DELETE FROM "free_credit_promises" WHERE "org_id" IN ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001');
--> statement-breakpoint
DELETE FROM "welcome_recipients" WHERE "org_id" IN ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001');
--> statement-breakpoint
DELETE FROM "billing_accounts" WHERE "org_id" IN ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001');
