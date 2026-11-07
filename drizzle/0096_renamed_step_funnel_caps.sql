-- A STEP RENAMED in features-service's catalogue re-keys every sales funnel id that
-- spells it (DELETE-POST-PUBLISHED-1107, owner 2026-11-07: the coarse outcome
-- `post_published` is retired, every leg spelled with it is a Threads leg and becomes
-- `threads_post_published`). campaign-service re-keys its funnel campaigns in
-- parallel; whichever service deploys first, the campaign must stay held to the
-- SAME cap. So each cap stated under an old id is stated AGAIN, unchanged, under its
-- new id (same amounts, periods, `*_since`, type, refusal state), and its history is
-- copied under the new id too (same values, same author, same dates), so the cap reads
-- the same under both ids. A campaign carries ONE id at a time, so it is held by one
-- row, never two. Nothing is deleted: the old-id row is retired, through the normal
-- clear (a history row), by `retireRenamedFunnelCaps` once no funnel campaign of the
-- org carries the old id (lib/renamed-funnel-ids.ts, same rename rule).
--
-- Rename rule (a token of the id, never a substring of a fine key): `post_published`
-- at the start of the id or after `@` / `+` / `_to_`, followed by the end, `@`, `+` or
-- `_to_`. `threads_post_published`, `x_post_published`, `linkedin_post_published` are
-- left alone.
--
-- Measured in prod at ship time: 1 cap row (distribute.you's Threads funnel, max
-- volume 5 daily, no budget, so no brand daily figure moves) + 1 history row.
-- Idempotent (ON CONFLICT DO NOTHING / NOT EXISTS). Reverse: delete the new-id rows
-- this wrote (same values, same changed_at).
INSERT INTO "sales_funnel_caps" (
  "org_id", "brand_id", "offer_id", "sales_funnel_id", "sales_funnel_campaign_id",
  "max_budget_cents", "max_budget_period", "max_budget_since",
  "max_volume", "max_volume_period", "max_volume_since",
  "sales_funnel_type",
  "max_budget_refused_at", "max_budget_refused_cents", "max_budget_refused_window_start", "max_budget_refused_cap_cents",
  "created_at", "updated_at"
)
SELECT
  c."org_id", c."brand_id", c."offer_id",
  regexp_replace(c."sales_funnel_id", '(^|[@+]|_to_)post_published(?=$|[@+]|_to_)', '\1threads_post_published', 'g'),
  c."sales_funnel_campaign_id",
  c."max_budget_cents", c."max_budget_period", c."max_budget_since",
  c."max_volume", c."max_volume_period", c."max_volume_since",
  c."sales_funnel_type",
  c."max_budget_refused_at", c."max_budget_refused_cents", c."max_budget_refused_window_start", c."max_budget_refused_cap_cents",
  c."created_at", c."updated_at"
FROM "sales_funnel_caps" c
WHERE c."sales_funnel_id" ~ '(^|[@+]|_to_)post_published(?=$|[@+]|_to_)'
ON CONFLICT ON CONSTRAINT "sales_funnel_caps_key" DO NOTHING;
--> statement-breakpoint
INSERT INTO "sales_funnel_cap_changes" (
  "org_id", "brand_id", "offer_id", "sales_funnel_id", "sales_funnel_campaign_id",
  "max_budget_cents", "max_budget_period", "max_volume", "max_volume_period",
  "changed_by_user_id", "changed_at"
)
SELECT
  h."org_id", h."brand_id", h."offer_id",
  regexp_replace(h."sales_funnel_id", '(^|[@+]|_to_)post_published(?=$|[@+]|_to_)', '\1threads_post_published', 'g'),
  h."sales_funnel_campaign_id",
  h."max_budget_cents", h."max_budget_period", h."max_volume", h."max_volume_period",
  h."changed_by_user_id", h."changed_at"
FROM "sales_funnel_cap_changes" h
WHERE h."sales_funnel_id" ~ '(^|[@+]|_to_)post_published(?=$|[@+]|_to_)'
  AND NOT EXISTS (
    SELECT 1 FROM "sales_funnel_cap_changes" n
    WHERE n."org_id" = h."org_id" AND n."brand_id" = h."brand_id" AND n."offer_id" = h."offer_id"
      AND n."sales_funnel_id" = regexp_replace(h."sales_funnel_id", '(^|[@+]|_to_)post_published(?=$|[@+]|_to_)', '\1threads_post_published', 'g')
      AND n."sales_funnel_campaign_id" IS NOT DISTINCT FROM h."sales_funnel_campaign_id"
      AND n."changed_at" = h."changed_at"
      AND n."max_budget_cents" IS NOT DISTINCT FROM h."max_budget_cents"
      AND n."max_budget_period" IS NOT DISTINCT FROM h."max_budget_period"
      AND n."max_volume" IS NOT DISTINCT FROM h."max_volume"
      AND n."max_volume_period" IS NOT DISTINCT FROM h."max_volume_period"
  );
