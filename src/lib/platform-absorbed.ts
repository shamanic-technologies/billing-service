/**
 * Google-Ads billing: the customer pays what its CAMPAIGNS spend, nothing else
 * (owner 2026-10-13: « Il faudrait arrêter de prélever plus à un user que ce qu'il
 * définit par campagne. Ça voudrait dire prendre sur nous: Stripe fees, Copilot chat
 * fees, onboarding cost. »). Every org, existing customers included.
 *
 * Spend with NO campaign (Copilot chat, onboarding site reads, A/B work, card fees)
 * is still declared to runs-service exactly as before and stays in the platform's
 * cost records. It no longer lowers the org's balance and never triggers a charge:
 * the platform absorbs it.
 *
 *   example: a campaign spends $10 today and the user chats with the Copilot for
 *   $0.40 → the balance moves by $10, the $0.40 is a cost we absorb.
 *
 * Two halves, one rule:
 *   - authorize: a spend that names no campaign (no `x-campaign-id`) is always
 *     sufficient, charges nothing, opens no episode (`isPlatformAbsorbedSpend`);
 *   - balance: every usage read subtracts the org's no-campaign spend from
 *     `PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO` on (lib/transfer-usage, the one
 *     choke point every balance path reads). FORWARD-ONLY: spend before the
 *     cutover was already billed and settled, so no past balance moves.
 *
 * Card-acquiring fees are cost rows with no campaign, so they are absorbed by
 * construction, whatever stripe-service does with them.
 */

/** From this instant on, spend with no campaign is the platform's (literal, never `now()`). */
export const PLATFORM_ABSORBS_NO_CAMPAIGN_SINCE_ISO = "2026-10-13T00:00:00.000Z";

/** A spend authorization that names no campaign is the platform's cost. */
export function isPlatformAbsorbedSpend(wf: { campaignId?: string }): boolean {
  return !wf.campaignId;
}
