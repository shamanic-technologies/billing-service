-- One campaign, one ceiling: drop an unscoped ceiling a named offer superseded.
--
-- Migration 0037 gave the ceiling an offer. Resolution was written in one
-- direction only: a write that names NO offer resolves against what the pair
-- already funds, so a ceiling written before 0037 is understood as the money of
-- the pair's only offer and is updated in place. The mirror was missing. A write
-- that NAMED an offer inserted a new row beside that unscoped ceiling, so the
-- same campaign was stored twice — and since the per-funnel figure is a SUM,
-- the brand was authorized at more than the customer funded.
--
-- Prod carried exactly one such pair when this shipped (the only pair anywhere
-- holding both an unscoped and a scoped ceiling):
--
--   org b645207b-d8e9-40b0-9391-072b777cd9a9
--   brand 75d7e3e8-6926-4f85-a557-976895400666
--   funnel reply_meeting, channel sales-cold-email-outreach
--     offer d5ecba00-783a-4939-b5bd-f85b9e6b7d9e   $40   written 2026-08-20 09:08
--     (no offer)                                   $40   written 2026-08-19 13:59
--
-- The customer funded that campaign once, at $40, through the offer-scoped
-- settings page. The unscoped row is the same $40 restated before the offer
-- dimension existed, so it goes; the offer-scoped one — the grain that addresses
-- the campaign — stays. The brand's other ceiling ($10 on the feedback-request
-- channel) is untouched, so the funnel total and the brand daily budget both
-- move from $90/day to the $50/day that was actually funded.
--
-- NO ATTRIBUTION IS INVENTED. This only ever deletes an unscoped ceiling that a
-- named-offer ceiling for the SAME (org, brand, funnel, channel) already
-- supersedes. A pair holding only an unscoped ceiling keeps it exactly as it is:
-- that is a permanent, first-class value ("not scoped to an offer"), not a
-- placeholder, and only brand-service could say which offer it belongs to.
--
-- IDEMPOTENT. Re-applying deletes nothing: after the first run no pair holds
-- both. The same statement is also what makes the state unreachable going
-- forward together with the write-side adoption, so it stays a one-shot repair
-- rather than a rule that has to keep running.
--
-- REVERSIBLE — restore the one row this removed in prod:
--
--   INSERT INTO brand_funnel_daily_budgets
--     (org_id, brand_id, funnel_key, feature_slug, offer_id,
--      daily_budget_cents, updated_at)
--   VALUES
--     ('b645207b-d8e9-40b0-9391-072b777cd9a9',
--      '75d7e3e8-6926-4f85-a557-976895400666',
--      'reply_meeting', 'sales-cold-email-outreach', NULL,
--      4000.0000000000, '2026-08-19 13:59:39.396+00');

DELETE FROM brand_funnel_daily_budgets AS unscoped
WHERE unscoped.offer_id IS NULL
  AND EXISTS (
    SELECT 1
      FROM brand_funnel_daily_budgets AS scoped
     WHERE scoped.org_id = unscoped.org_id
       AND scoped.brand_id = unscoped.brand_id
       AND scoped.funnel_key = unscoped.funnel_key
       AND scoped.feature_slug = unscoped.feature_slug
       AND scoped.offer_id IS NOT NULL
  );
