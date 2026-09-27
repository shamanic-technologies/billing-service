-- The welcome gift is granted once per PERSON, not once per organisation.
--
-- Until now the gift was redeemed per org on the first billing touch, so one person
-- collected it once per organisation they created (prod 2026-09-27: 118 welcome rows
-- for 84 distinct user ids, one person holding 10). The dashboard is replacing its
-- "New organization" page with an in-dashboard modal, which makes that trivial.
--
-- One row per person: the org where that person's welcome lives. The PRIMARY KEY on
-- the person is the whole guarantee — two orgs racing for the same person's welcome
-- cannot both win. A person is the client-service internal user id (`x-user-id`, 1:1
-- with the identity-provider user); the all-zeros platform sentinel is never a person
-- and is never written here.
--
-- Backfill: every person who ALREADY received a welcome, bound to the FIRST org it
-- landed on. Only rows carrying a real user id qualify — the anonymous-claim settle
-- and an early era wrote welcome rows under the zero sentinel, and nothing in this
-- database says whose they were. Nothing already granted is touched or clawed back.
--
-- Idempotent — safe to re-run (ON CONFLICT DO NOTHING on the person).
-- Reverse: DROP TABLE "welcome_recipients";

CREATE TABLE IF NOT EXISTS "welcome_recipients" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_welcome_recipients_org" ON "welcome_recipients" ("org_id");

INSERT INTO "welcome_recipients" ("user_id", "org_id", "created_at")
SELECT DISTINCT ON (p."user_id") p."user_id", p."org_id", p."created_at"
  FROM "local_promos" p
  JOIN "local_promo_codes" c ON c."id" = p."promo_code_id"
 WHERE c."code" = 'welcome'
   AND p."user_id" <> '00000000-0000-0000-0000-000000000000'
 ORDER BY p."user_id", p."created_at", p."id"
ON CONFLICT ("user_id") DO NOTHING;
