-- The $500 referral reward belongs to the REFERRER, earned on the REFERRED org's
-- payments (owner 2026-10-06: "Nag (Ascend) dont get any free credits. It is Senthil
-- who gets that money because of referral").
--
-- Before: the INVITEE held a promise (org_id = invitee, referrer_org_id = inviter),
-- earned on its own payments; granting it opened a second promise for the inviter.
-- After: ONE promise, held by the referrer (org_id = referrer, referred_org_id =
-- invitee), bar = its own amount, measured on the invitee's payments.
--
-- 1. Move every UNGRANTED invitee-held referral promise onto its referrer. At ship
--    time prod holds exactly one (AscendQE referred by NOVEMIQ, $500 @ $500, not
--    granted). Its bar becomes its own amount: a referral no longer stacks.
--    Re-applying matches nothing (referrer_org_id is NULL after the move).
UPDATE "free_credit_promises" p
   SET "org_id" = p."referrer_org_id",
       "referred_org_id" = p."org_id",
       "referrer_org_id" = NULL,
       "paid_trigger_cents" = p."amount_cents",
       "opened_notified_at" = NULL
 WHERE p."kind" = 'referral'
   AND p."referrer_org_id" IS NOT NULL
   AND p."granted_at" IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM "free_credit_promises" q
      WHERE q."kind" = 'referral' AND q."referred_org_id" = p."org_id"
   );

-- 2. An org is referred ONCE, now enforced on the referrer-held row.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_free_credit_promises_referred_once"
  ON "free_credit_promises" ("referred_org_id")
  WHERE "kind" = 'referral' AND "referred_org_id" IS NOT NULL;
