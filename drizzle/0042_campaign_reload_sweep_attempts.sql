-- One row per org the blocked-campaign reload sweep has already attempted a
-- charge for, keyed on the CREDITED total it saw at that moment.
--
-- The sweep exists to break a deadlock, not to collect a debt. Once it has
-- presented a card and the card refused, the org is no longer blocked by US —
-- it is blocked by its own card, which is a state the depletion-episode dunning
-- engine already owns. Re-presenting that card on every hourly tick would
-- degrade it at its issuer and our decline rate at the acquirer (documented at
-- length in lib/reload-coalescer), for no chance of a different answer.
--
-- `credited_cents_at_attempt` is what makes "something changed" answerable with
-- no new lifecycle: credited only ever RISES, so a recharge of any kind (a paid
-- top-up, a promo, a staff grant) moves it and re-arms the sweep for that org.
-- A dead card moves nothing, so it is attempted exactly once.
--
-- Reverse: DROP TABLE IF EXISTS campaign_reload_sweep_attempts;
CREATE TABLE IF NOT EXISTS campaign_reload_sweep_attempts (
  org_id uuid PRIMARY KEY,
  credited_cents_at_attempt numeric(16,10) NOT NULL,
  last_outcome text NOT NULL,
  attempted_at timestamp with time zone NOT NULL DEFAULT now()
);
