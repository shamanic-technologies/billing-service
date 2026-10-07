-- Split every FUNDED live campaign ceiling (owner 2026-10-07, verbatim: "on garde le
-- meme total, reparti selon ce que chaque campagne a vraiment depense sur ses 30
-- derniers jours"). daily_budget_cents is NOT touched: the customer's max daily
-- spend is unchanged to the cent; only the part sourcing may spend is stated.
--
-- Share per row, measured in prod on 2026-10-07 over the last 30 days (runs-service,
-- committed NET, campaign ids resolved to ceilings with billing's own rule):
--   - own share = sourcing subtree spend / total spend of the campaign, when it spent
--     on BOTH parts;
--   - otherwise its channel's fleet share over the same window (sales-cold-email-
--     outreach 45.1%; channels that never sourced: 0%).
-- sourcing = total x share rounded to the whole dollar (cents when a dollar rounding
-- would zero a part whose share is strictly between 0 and 1). $0 rows stay unsplit.
--
-- Each UPDATE is guarded on the total it was computed from and on the row being
-- unsplit, so a ceiling moved since the measurement is left alone (and re-applying
-- touches nothing). Reverse: UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = NULL;
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 0 WHERE org_id = '8bfec2f4-6184-40b7-b1aa-c8933d506a87' AND brand_id = 'f2408cfb-4f02-4910-acec-e61fc8edb9cf' AND feature_slug = 'ai-instant-call' AND offer_id = '58e1affd-701e-41bf-afa8-66d1072870c3' AND leg_key = 'conversation_to_booking_call' AND daily_budget_cents = 500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 0 WHERE org_id = '91e76989-71ba-420d-ba73-bb3961430aa7' AND brand_id = '75d7e3e8-6926-4f85-a557-976895400666' AND feature_slug = 'ai-instant-call' AND offer_id = 'd5ecba00-783a-4939-b5bd-f85b9e6b7d9e' AND leg_key = 'conversation_to_booking_call' AND daily_budget_cents = 2000.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 0 WHERE org_id = '22ffb00a-b7da-4453-9bf2-1784c2d2bf9e' AND brand_id = '933d4abb-9695-4fcb-b3aa-354d61565798' AND feature_slug = 'ai-meeting-booking' AND offer_id = 'e59646e4-e351-462d-a8a7-618098e7e5c1' AND leg_key = 'conversation_to_meeting_booked' AND daily_budget_cents = 100.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 0 WHERE org_id = '8bfec2f4-6184-40b7-b1aa-c8933d506a87' AND brand_id = 'f2408cfb-4f02-4910-acec-e61fc8edb9cf' AND feature_slug = 'ai-meeting-booking' AND offer_id = '58e1affd-701e-41bf-afa8-66d1072870c3' AND leg_key = 'conversation_to_meeting_booked' AND daily_budget_cents = 500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 0 WHERE org_id = '91e76989-71ba-420d-ba73-bb3961430aa7' AND brand_id = '75d7e3e8-6926-4f85-a557-976895400666' AND feature_slug = 'ai-meeting-booking' AND offer_id = 'd5ecba00-783a-4939-b5bd-f85b9e6b7d9e' AND leg_key = 'conversation_to_meeting_booked' AND daily_budget_cents = 2000.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 0 WHERE org_id = 'f00c29d0-a41f-41a3-b8b3-471a10c96277' AND brand_id = 'fbe7898b-70d8-4468-ae54-59604e018d63' AND feature_slug = 'ai-meeting-booking' AND offer_id = '96fb8cea-dced-4347-bc13-b669e9299535' AND leg_key = 'conversation_to_meeting_booked' AND daily_budget_cents = 500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 0 WHERE org_id = 'f0420eb5-8f72-4f0a-a150-f473746df1e6' AND brand_id = 'f4d73dab-1f9d-49b2-b16e-63ecde76a5eb' AND feature_slug = 'ai-meeting-booking' AND offer_id = '5a2868bb-ac88-42f6-a00a-e49b89b04079' AND leg_key IS NULL AND daily_budget_cents = 100.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 0 WHERE org_id = 'fa3f049d-c881-4456-8402-b366253e328a' AND brand_id = '0d05c796-39dd-4642-9750-bd7405122e9d' AND feature_slug = 'ai-meeting-booking' AND offer_id = 'be466fa3-c416-4823-b90c-1f7eaa542770' AND leg_key = 'conversation_to_meeting_booked' AND daily_budget_cents = 500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 0 WHERE org_id = '91e76989-71ba-420d-ba73-bb3961430aa7' AND brand_id = '75d7e3e8-6926-4f85-a557-976895400666' AND feature_slug = 'feedback-request-cold-email-outreach' AND offer_id IS NULL AND leg_key = 'start_to_conversation' AND daily_budget_cents = 1000.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 200 WHERE org_id = '00673148-ce8e-4bd8-816f-8d6e6d2facff' AND brand_id = '9abe30d6-391c-445f-9efd-57a2ee5940dc' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = '068a2e09-e233-45ab-ac03-7769502849bc' AND leg_key IS NULL AND daily_budget_cents = 500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 500 WHERE org_id = '22ffb00a-b7da-4453-9bf2-1784c2d2bf9e' AND brand_id = '933d4abb-9695-4fcb-b3aa-354d61565798' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = 'e59646e4-e351-462d-a8a7-618098e7e5c1' AND leg_key = 'start_to_conversation' AND daily_budget_cents = 1000.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 1700 WHERE org_id = '308f528f-03ad-44b1-9cbc-623a6af9ba0e' AND brand_id = 'c4b5284d-5add-440d-917e-0c79d920a0d4' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = '7b5c063d-e33f-4440-87fb-1f1e6aa4e850' AND leg_key = 'start_to_website_visit' AND daily_budget_cents = 2000.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 200 WHERE org_id = '35f259d0-bd6e-4283-91e7-5258aeb3b80a' AND brand_id = '51aa330c-583a-45cc-8f4f-b840822beafd' AND feature_slug = 'sales-cold-email-outreach' AND offer_id IS NULL AND leg_key IS NULL AND daily_budget_cents = 500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 300 WHERE org_id = '5fefaf5a-8d50-4c5f-aa4b-3d35bcd1de93' AND brand_id = 'a179bbd9-8eed-4dba-9338-78125922b0c6' AND feature_slug = 'sales-cold-email-outreach' AND offer_id IS NULL AND leg_key = 'start_to_conversation' AND daily_budget_cents = 800.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 3200 WHERE org_id = '81b34252-61e3-47b5-9293-5294b6fb51b6' AND brand_id = '9546c4b2-c4c8-4a0e-a4e6-cf486d5bcf22' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = '3043b0ec-49eb-4db4-a665-dc5e7fe06b0e' AND leg_key IS NULL AND daily_budget_cents = 4900.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 100 WHERE org_id = '8bfec2f4-6184-40b7-b1aa-c8933d506a87' AND brand_id = 'f2408cfb-4f02-4910-acec-e61fc8edb9cf' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = '58e1affd-701e-41bf-afa8-66d1072870c3' AND leg_key = 'start_to_conversation' AND daily_budget_cents = 500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 4200 WHERE org_id = '91e76989-71ba-420d-ba73-bb3961430aa7' AND brand_id = '75d7e3e8-6926-4f85-a557-976895400666' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = 'd5ecba00-783a-4939-b5bd-f85b9e6b7d9e' AND leg_key = 'start_to_conversation' AND daily_budget_cents = 10700.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 500 WHERE org_id = 'a81327ee-727a-4978-ab5d-6503658a9abf' AND brand_id = '7604c385-1f02-4016-b42f-344565bcd36d' AND feature_slug = 'sales-cold-email-outreach' AND offer_id IS NULL AND leg_key = 'start_to_website_visit' AND daily_budget_cents = 1000.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 700 WHERE org_id = 'd3367008-29cd-4dc5-a57e-d0d825bf1630' AND brand_id = 'b97440f6-5822-43de-ad1d-9886723536d6' AND feature_slug = 'sales-cold-email-outreach' AND offer_id IS NULL AND leg_key = 'start_to_conversation' AND daily_budget_cents = 1500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 700 WHERE org_id = 'e4fc3f44-17a8-418b-9ec0-a7eb492f437d' AND brand_id = '73f4706e-0706-4f8c-a2af-14d9d645b93e' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = '90a51a50-78f4-4e10-a3d2-1c7cad666ed4' AND leg_key IS NULL AND daily_budget_cents = 2500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 400 WHERE org_id = 'f00c29d0-a41f-41a3-b8b3-471a10c96277' AND brand_id = 'fbe7898b-70d8-4468-ae54-59604e018d63' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = '96fb8cea-dced-4347-bc13-b669e9299535' AND leg_key = 'start_to_conversation' AND daily_budget_cents = 500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 45 WHERE org_id = 'f0420eb5-8f72-4f0a-a150-f473746df1e6' AND brand_id = 'f4d73dab-1f9d-49b2-b16e-63ecde76a5eb' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = '5a2868bb-ac88-42f6-a00a-e49b89b04079' AND leg_key IS NULL AND daily_budget_cents = 100.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 1200 WHERE org_id = 'f0420eb5-8f72-4f0a-a150-f473746df1e6' AND brand_id = 'f4d73dab-1f9d-49b2-b16e-63ecde76a5eb' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = '832126f3-f3f1-4601-885d-bc8e101e5680' AND leg_key = 'start_to_website_visit' AND daily_budget_cents = 2000.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 500 WHERE org_id = 'f74660b1-2b0a-4366-b1f8-b0d9129cfabd' AND brand_id = 'c992c378-caa8-49fa-b914-3628ee99c404' AND feature_slug = 'sales-cold-email-outreach' AND offer_id IS NULL AND leg_key = 'start_to_website_visit' AND daily_budget_cents = 1000.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 300 WHERE org_id = 'fa3f049d-c881-4456-8402-b366253e328a' AND brand_id = '0d05c796-39dd-4642-9750-bd7405122e9d' AND feature_slug = 'sales-cold-email-outreach' AND offer_id = 'be466fa3-c416-4823-b90c-1f7eaa542770' AND leg_key = 'start_to_conversation' AND daily_budget_cents = 500.0000000000 AND sourcing_ceiling_cents IS NULL;
--> statement-breakpoint
UPDATE campaign_daily_budgets SET sourcing_ceiling_cents = 100.0000000000 WHERE org_id = 'b645207b-d8e9-40b0-9391-072b777cd9a9' AND brand_id = 'ccc29ba2-78ce-48fc-a57c-16c4fa0e1449' AND feature_slug = 'sales-crm-email-outreach' AND offer_id IS NULL AND leg_key = 'start_to_website_visit' AND daily_budget_cents = 100.0000000000 AND sourcing_ceiling_cents IS NULL;
