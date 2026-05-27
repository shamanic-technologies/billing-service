-- Seed platform-issued grant promo codes for DIS-64 (Wave 0.5 invite-only gate).
--
-- These two codes back the `POST /internal/credits/grant` endpoint:
--   - invite_reward:  $25 to the inviter when an invitee signs up
--   - invite_welcome: $25 to the invitee (replaces the $2 welcome via DELETE
--     of the existing welcome row in the same tx — see lib/promos.ts grantCredit)
--
-- max_redemptions = NULL: cap is enforced upstream (3 invites/org in client-service),
-- not by the promo code row.

INSERT INTO "local_promo_codes" ("code", "amount_cents", "max_redemptions", "expires_at")
VALUES ('invite_reward', 2500, NULL, NULL),
       ('invite_welcome', 2500, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;
