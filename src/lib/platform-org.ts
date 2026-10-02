/**
 * Platform orgs — our OWN internal organizations (table `platform_orgs`,
 * migration 0057), which spend on the platform's behalf and must never be
 * refused by their balance or a declined card.
 *
 * WHY. distribute.you (f0420eb5-…) sends our own newsletter; apollo-service
 * authorizes each email verification against its balance. On 2026-10-01 at
 * 13:45 UTC that org's postpaid balance crossed its -$500 credit-line floor
 * (a $384.16 month-end settle had already declined at 23:53 the night before,
 * then ~$111 of verification + sending spend), the $500 reload declined
 * (`generic_decline`), and every authorize after that was refused: 3,279
 * refused verifications in 72h and the newsletter release stalled with 20,364
 * recipients waiting. Charging our own card to pay ourselves is circular; the
 * gate protects customer money and has nothing to protect here.
 *
 * WHAT A ROW CHANGES — every site below checks `isPlatformOrg` and nothing else:
 *   - authorize: sufficient, no reload, no depletion episode;
 *   - usage_apply: no reload;
 *   - affordability pre-flight: affordable;
 *   - resolveSpendBlock: never blocked (dunning tick, outlook, sweeps read it);
 *   - campaign reload sweep + month-end sweep: never charged, never flagged;
 *   - flagUncollectableDebt: `platform_org`, never flagged, nobody mailed;
 *   - payment outlook: `no_autopay` (no automatic charge, ever);
 *   - revenue: `none` / `platform_org` (internal spend is not revenue).
 *
 * WHAT IT DOES NOT CHANGE: usage is still recorded at full price in
 * runs-service, and every balance figure stays TRUE — it may go deeply
 * negative, and that negative figure is what running the org cost us. A
 * customer org (no row) is byte-for-byte unaffected.
 *
 * A row is added by a migration only (a decision about money, reviewed in a PR).
 * No route writes this table.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformOrgs } from "../db/schema.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function isPlatformOrg(orgId: string): Promise<boolean> {
  // Not a uuid → cannot be a row (and must not reach a uuid-typed comparison).
  if (!UUID_RE.test(orgId)) return false;
  const rows = await db
    .select({ orgId: platformOrgs.orgId })
    .from(platformOrgs)
    .where(eq(platformOrgs.orgId, orgId))
    .limit(1);
  return rows.length > 0;
}
