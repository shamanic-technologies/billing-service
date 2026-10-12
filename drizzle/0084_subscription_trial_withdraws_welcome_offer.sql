-- A subscription trial IS the org's whole free offer (owner 2026-10-12: « Le gars est
-- arrivé avec un $99/mo - 3 day trial: ok. On ne devrait donc pas lui donner $30 de
-- free credits en plus »). From now on grantSubscriptionTrial withdraws the welcome /
-- match offer in the same transaction (lib/welcome-recipient withdrawFreeCreditOffer).
-- This backfills the orgs that already hold a trial grant: offer columns to 0 and the
-- ungranted welcome promise mirror to 0 (worth nothing = no longer listed, never
-- granted). Nothing granted is touched. Prod at ship time: 2 orgs
-- (62594115-… match_100 $100 promise, fc600ac6-… legacy $30 promise), 0 granted.
-- Idempotent: re-applying finds every target already at 0.
-- Reverse: not applicable (the offers were never owed to a trial org).
UPDATE billing_accounts a
   SET free_credit_entitlement_cents = 0,
       free_credit_paid_trigger_cents = 0,
       updated_at = now()
 WHERE (a.free_credit_entitlement_cents <> 0 OR a.free_credit_paid_trigger_cents <> 0)
   AND EXISTS (
     SELECT 1 FROM local_promos p
       JOIN local_promo_codes c ON c.id = p.promo_code_id AND c.code = 'subscription_trial'
      WHERE p.org_id = a.org_id);
--> statement-breakpoint
UPDATE free_credit_promises f
   SET amount_cents = 0,
       paid_trigger_cents = 0
 WHERE f.kind = 'welcome'
   AND f.granted_at IS NULL
   AND (f.amount_cents <> 0 OR f.paid_trigger_cents <> 0)
   AND EXISTS (
     SELECT 1 FROM local_promos p
       JOIN local_promo_codes c ON c.id = p.promo_code_id AND c.code = 'subscription_trial'
      WHERE p.org_id = f.org_id);
