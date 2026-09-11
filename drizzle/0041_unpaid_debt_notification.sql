-- 0041 — an unpaid debt we cannot collect is VISIBLE, never silently skipped.
--
-- An org with a negative balance and no chargeable card owes us money we have no
-- way to take. Before this, the month-end sweep counted it as `skipped` and the
-- debt disappeared from every surface: no email, no staff signal, campaigns
-- still running and the debt still growing.
--
-- Two ADDITIVE columns on the existing depletion episode — the dunning state we
-- already open for an out-of-credit org — rather than a new table, so the
-- existing recovery path (credited rising closes the episode) keeps owning the
-- lifecycle and nothing new has to be reconciled:
--
--   card_required_notified_at  claims the ONE "a card is required" notification
--                              (customer + staff) per episode. "Did we grant"
--                              and "did we tell them" are different questions,
--                              and the hourly sweep re-examines every open
--                              episode, so without a marker a customer would be
--                              mailed about the same debt forever.
--   uncollectable_debt_cents   the amount owed at flag time, refreshed on each
--                              tick while still uncollectable, so the staff read
--                              is a plain DB read with no per-org fan-out.
--
-- Both NULL on every existing row: an episode that has never been flagged reads
-- exactly as it did. NULL is a permanent first-class value ("this debt is
-- collectable / was never uncollectable"), not a placeholder.
--
-- Reverse:
--   ALTER TABLE "credit_depletion_episodes" DROP COLUMN "card_required_notified_at";
--   ALTER TABLE "credit_depletion_episodes" DROP COLUMN "uncollectable_debt_cents";

ALTER TABLE "credit_depletion_episodes"
  ADD COLUMN IF NOT EXISTS "card_required_notified_at" timestamp with time zone;

ALTER TABLE "credit_depletion_episodes"
  ADD COLUMN IF NOT EXISTS "uncollectable_debt_cents" numeric(16,10);
