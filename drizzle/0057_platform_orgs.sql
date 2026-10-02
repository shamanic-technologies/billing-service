-- Platform orgs: OUR OWN internal organizations, which spend on the platform's own
-- behalf and must never be refused by their balance or a declined card.
--
-- Why a table and not a flag in code or an env var: the exemption is a decision
-- about money, so it must be explicit and auditable. One row per org, with the
-- reason and who added it, readable with one SELECT. Nothing else creates a row.
--
-- What a row changes (lib/platform-org.ts):
--   * authorize answers sufficient, the affordability pre-flight answers affordable,
--     and no reload is ever attempted for that org (no card is ever presented);
--   * no depletion episode, no dunning mail, no uncollectable-debt flag, no
--     month-end settle charge, no campaign reload sweep charge;
--   * payment outlook answers no_autopay (no automatic charge, ever) and the
--     revenue read classifies it `none` / `platform_org` (internal spend is not revenue).
-- What it does NOT change: usage is still recorded in runs-service at full price,
-- and every balance figure stays TRUE (it may go deeply negative; that negative
-- figure is the platform's own cost of running that org, not a customer debt).
--
-- Seed: distribute.you (f0420eb5-…), which sends our own newsletter. On 2026-10-01
-- its card declined a $500 reload at the -$500 credit-line floor and every authorize
-- was refused for ~17h (3,279 refused verifications, 20,364 newsletter recipients held).
--
-- Idempotent. Reverse: DROP TABLE IF EXISTS platform_orgs;
CREATE TABLE IF NOT EXISTS "platform_orgs" (
  "org_id" uuid PRIMARY KEY NOT NULL,
  "reason" text NOT NULL,
  "added_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "platform_orgs" ("org_id", "reason", "added_by")
VALUES (
  'f0420eb5-8f72-4f0a-a150-f473746df1e6',
  'distribute.you internal org: sends our own newsletter and runs our own outreach. Platform spend, never blocked by its balance or a declined card.',
  'migration 0057 (daily debrief 2026-10-02, bug #1)'
)
ON CONFLICT ("org_id") DO NOTHING;
