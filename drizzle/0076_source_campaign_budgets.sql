-- SOURCE CAMPAIGNS (owner 2026-10-07, features-service v0.179.79): a lead SOURCE is a
-- campaign of its own, keyed (offer, feature_slug = <origin slug>, leg_key =
-- 'start_to_lead_found'). The sourcing part of an OUTREACH campaign's budget (its
-- sourcing_ceiling_cents, migrations 0074 + 0075) moves onto the source campaign that
-- feeds it; the outreach row keeps the outreach part only, unsplit:
--
--   before: Jubilation (sales-cold-email-outreach)  daily 10700, sourcing up to 4200
--   after:  Jubilation                              daily  6500, unsplit
--           Apollo Cold Filters (source campaign)   daily  4200
--
-- Origin per outreach channel: sales-cold-email-outreach and
-- feedback-request-cold-email-outreach -> sourcing-apollo-cold-filters (the cold
-- filters origin every split was measured on); sales-crm-email-outreach ->
-- sourcing-crm-contacts. Several outreach rows of one offer fed by one origin add up
-- on its one source row (ON CONFLICT adds to an existing one).
--
-- SUM per offer (and per brand) is unchanged to the cent: the same money, cut on
-- another row. Nothing is charged, no balance moves, brand_daily_budget_changes gets
-- no row (the brand total did not move).
--
-- Scope: DAILY rows (monthly_budget_cents IS NULL) naming an OFFER on a sourcing
-- channel with a stated split. An offer-less legacy row keeps its split (a source
-- campaign is keyed on its offer; never guess one). Re-applying finds no split row
-- left and moves nothing.
--
-- Reverse (per moved offer): UPDATE the outreach row daily += source daily, sourcing =
-- source daily; DELETE the source row.
WITH src AS (
  SELECT org_id, brand_id, feature_slug, offer_id, leg_key, sourcing_ceiling_cents,
         CASE feature_slug WHEN 'sales-crm-email-outreach' THEN 'sourcing-crm-contacts'
                           ELSE 'sourcing-apollo-cold-filters' END AS origin
  FROM campaign_daily_budgets
  WHERE offer_id IS NOT NULL
    AND monthly_budget_cents IS NULL
    AND sourcing_ceiling_cents IS NOT NULL
    AND feature_slug IN ('sales-cold-email-outreach', 'feedback-request-cold-email-outreach', 'sales-crm-email-outreach')
  FOR UPDATE
),
moved AS (
  SELECT org_id, brand_id, offer_id, origin, SUM(sourcing_ceiling_cents) AS cents
  FROM src GROUP BY org_id, brand_id, offer_id, origin
  HAVING SUM(sourcing_ceiling_cents) > 0
),
ins AS (
  INSERT INTO campaign_daily_budgets (org_id, brand_id, feature_slug, offer_id, leg_key, daily_budget_cents, updated_at)
  SELECT org_id, brand_id, origin, offer_id, 'start_to_lead_found', cents, now() FROM moved
  ON CONFLICT ON CONSTRAINT campaign_daily_budgets_campaign_key
  DO UPDATE SET daily_budget_cents = campaign_daily_budgets.daily_budget_cents + EXCLUDED.daily_budget_cents,
                updated_at = now()
  RETURNING 1
)
UPDATE campaign_daily_budgets c
SET daily_budget_cents = c.daily_budget_cents - src.sourcing_ceiling_cents,
    sourcing_ceiling_cents = NULL,
    updated_at = now()
FROM src
WHERE c.org_id = src.org_id AND c.brand_id = src.brand_id AND c.feature_slug = src.feature_slug
  AND c.offer_id = src.offer_id AND c.leg_key IS NOT DISTINCT FROM src.leg_key;
-- (ins is a data-modifying CTE: Postgres runs it to completion even unreferenced.)
