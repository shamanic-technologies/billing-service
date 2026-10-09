-- Wave 2 of the outbound leg-key rename (owner 2026-10-09, LOCKED fleet table).
--
-- "Lead found" is a normal funnel step: an OUTBOUND campaign starts at a found
-- lead, so on the ten outbound feature slugs below two leg keys are renamed:
--
--     start_to_conversation   ->  lead_found_to_conversation
--     start_to_website_visit  ->  lead_found_to_website_visit
--
-- The same keys on any NON-outbound channel (ads, SEO, organic, PR) are NOT
-- renamed. Wave 1 (lib/leg-identity) already treats both spellings as one
-- identity; this moves every stored row to the new spelling, and the code now
-- writes only the new one.
--
-- ONE table carries a leg key: campaign_daily_budgets. Frozen backups
-- (`*_2026*` snapshot tables) are deliberately left as they are.
--
-- Collisions: UNIQUE NULLS NOT DISTINCT (org_id, brand_id, feature_slug, offer_id,
-- leg_key) means a legacy row and a new-spelling row for the same campaign could
-- not both survive the rename. Measured in prod at ship time: 23 legacy rows,
-- ZERO collisions (wave 1 refuses to create the second spelling of a stored leg).
-- Should one exist anyway, the migration FAILS LOUD rather than guess which
-- budget is the customer's: nothing is moved, the boot refuses.
--
-- Idempotent: a re-run finds no legacy outbound row and changes nothing.
-- Reverse: the same UPDATE with the two spellings swapped.

DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT count(*) INTO collisions
    FROM campaign_daily_budgets l
    JOIN campaign_daily_budgets n
      ON n.org_id = l.org_id
     AND n.brand_id = l.brand_id
     AND n.feature_slug = l.feature_slug
     AND n.offer_id IS NOT DISTINCT FROM l.offer_id
     AND n.leg_key = CASE l.leg_key
                       WHEN 'start_to_conversation' THEN 'lead_found_to_conversation'
                       WHEN 'start_to_website_visit' THEN 'lead_found_to_website_visit'
                     END
   WHERE l.leg_key IN ('start_to_conversation', 'start_to_website_visit')
     AND l.feature_slug IN (
       'sales-cold-email-outreach', 'feedback-request-cold-email-outreach',
       'sales-crm-email-outreach', 'cold-call-outreach', 'cold-instagram-outreach',
       'cold-linkedin-outreach', 'cold-reddit-outreach', 'cold-sms-outreach',
       'cold-whatsapp-outreach', 'cold-x-outreach'
     );
  IF collisions > 0 THEN
    RAISE EXCEPTION 'outbound leg rename: % campaign(s) hold both spellings; resolve by hand before migrating', collisions;
  END IF;
END $$;
--> statement-breakpoint
UPDATE campaign_daily_budgets
   SET leg_key = CASE leg_key
                   WHEN 'start_to_conversation' THEN 'lead_found_to_conversation'
                   WHEN 'start_to_website_visit' THEN 'lead_found_to_website_visit'
                 END
 WHERE leg_key IN ('start_to_conversation', 'start_to_website_visit')
   AND feature_slug IN (
     'sales-cold-email-outreach', 'feedback-request-cold-email-outreach',
     'sales-crm-email-outreach', 'cold-call-outreach', 'cold-instagram-outreach',
     'cold-linkedin-outreach', 'cold-reddit-outreach', 'cold-sms-outreach',
     'cold-whatsapp-outreach', 'cold-x-outreach'
   );
