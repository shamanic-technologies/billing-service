import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  ADMIN_GRANT_CODE,
  AGENT_API_FREE_CREDIT_OFFER,
  billingAccounts,
  type BillingAccount,
} from "../db/schema.js";
import { withdrawFreeCreditOffer } from "./welcome-recipient.js";
import { getOrgFreeCreditOffer, isNoFreeCreditOffer } from "./free-credit-offer.js";

/**
 * Orgs opened by an AI agent through the API (owner 2026-10-12, verbatim):
 *
 *   « no free credits nor free trial with them to avoid free riders. Everything
 *     needs to be paid upfront. Autotopup is mandatory for prepaid because
 *     otherwise their service would stop. »
 *   « for the API, lets rather only allow prepaid with mandatory auto topup, no
 *     subscription »
 *
 * Worked example: the agent pays $10 -> balance $10, auto top-up ON ($15 below $5).
 * The balance falls under $5 -> the card is charged $15 -> balance about $20. No
 * free credit row, ever.
 *
 * The mark is the account's free-credit OFFER (`agent_api`), frozen like every other
 * offer: entitlement 0, trigger 0, welcome-completion ineligible. Every free-credit
 * writer asks `assertFreeCreditAllowed` first (welcome redeem, any promo redeem,
 * the $30 org-creation advance, the trial seed, the signup welcome, invite and
 * product-task grants, the subscription trial). Staff grants (`admin_grant`) stay
 * possible: that is a person deciding, not an automatic gift.
 *
 * WHEN the mark lands matters: billing cannot tell an agent org from any other on
 * its first touch, and an unmarked org's first touch creates a match_100 account
 * with its $30 advance. So client-service marks the org at provisioning, before
 * anything else can touch billing; the one-step prepaid checkout also creates the
 * account as agent_api when none exists yet.
 */

export class FreeCreditNotOfferedError extends Error {
  readonly code = "free_credit_not_offered";
  constructor(orgId: string, what: string) {
    super(`org ${orgId} is on an offer with no free credit (${what})`);
    this.name = "FreeCreditNotOfferedError";
  }
}

export async function isAgentApiOrg(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ offer: billingAccounts.freeCreditOffer })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId))
    .limit(1);
  return row?.offer === AGENT_API_FREE_CREDIT_OFFER;
}

/**
 * Throws FreeCreditNotOfferedError for an org whose offer gives no free money: an
 * agent/API org, and every account created since the at-cost offer (owner 2026-10-29,
 * an org with no account yet is one). A no-op for every older org.
 */
export async function assertFreeCreditAllowed(orgId: string, what: string): Promise<void> {
  const offer = await getOrgFreeCreditOffer(orgId);
  if (isNoFreeCreditOffer(offer)) {
    console.warn(`[billing-service] refused free credit (${what}) to ${offer} org ${orgId}`);
    throw new FreeCreditNotOfferedError(orgId, what);
  }
}

/** Throws FreeCreditNotOfferedError for an agent/API org only (the at-cost onboarding advance path). */
export async function assertNotAgentApiOrg(orgId: string, what: string): Promise<void> {
  if (await isAgentApiOrg(orgId)) {
    console.warn(`[billing-service] refused ${what} to agent/API org ${orgId}`);
    throw new FreeCreditNotOfferedError(orgId, what);
  }
}

/** An org on an offer with no free money (see assertFreeCreditAllowed). */
export async function isNoFreeCreditOrg(orgId: string): Promise<boolean> {
  return isNoFreeCreditOffer(await getOrgFreeCreditOffer(orgId));
}

/** The values an agent/API account is written with: no offer, prepaid. */
const AGENT_ACCOUNT_VALUES = {
  freeCreditOffer: AGENT_API_FREE_CREDIT_OFFER,
  freeCreditEntitlementCents: 0,
  freeCreditPaidTriggerCents: 0,
  welcomeCompletionEligible: false,
} as const;

export interface AgentApiMarkResult {
  orgId: string;
  /** True when this call created the billing account. */
  created: boolean;
  /** True when the org was already marked before this call. */
  alreadyMarked: boolean;
  /**
   * Free credit the org ALREADY held when it was marked (an account touched before
   * the mark). Never clawed back; non-zero is logged loudly. "0" on the normal path.
   */
  freeCreditHeldCents: string;
  account: BillingAccount;
}

/**
 * Mark an org as opened through the API. Idempotent.
 *
 * No account yet (the normal path, called at provisioning): creates it as agent_api,
 * prepaid, with nothing granted. An existing account: switches its offer to
 * agent_api and withdraws whatever free credit was still to come (the welcome
 * promise mirror goes to 0); its payment mode is left alone (the prepaid checkout
 * sets it). Credit already granted stays (nothing granted is ever clawed back) and
 * is reported.
 */
export async function markAgentApiOrg(orgId: string): Promise<AgentApiMarkResult> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(billingAccounts)
      .values({ orgId, ...AGENT_ACCOUNT_VALUES, paymentMode: "prepaid" })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      console.log(`[billing-service] agent/API org ${orgId}: billing account created, no free credit`);
      return { orgId, created: true, alreadyMarked: false, freeCreditHeldCents: "0", account: inserted };
    }

    const [existing] = await tx
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .for("update")
      .limit(1);
    const alreadyMarked = existing.freeCreditOffer === AGENT_API_FREE_CREDIT_OFFER;
    if (!alreadyMarked) {
      await withdrawFreeCreditOffer(tx, orgId);
      await tx
        .update(billingAccounts)
        .set({ ...AGENT_ACCOUNT_VALUES, updatedAt: new Date() })
        .where(eq(billingAccounts.orgId, orgId));
    }
    // Staff grants are a person's decision, not a free-rider gift: not counted.
    const rows = (await tx.execute(sql`
      SELECT COALESCE(SUM(p.amount_cents), 0)::text AS total
        FROM local_promos p
        JOIN local_promo_codes c ON c.id = p.promo_code_id
       WHERE p.org_id = ${orgId} AND c.code <> ${ADMIN_GRANT_CODE}
    `)) as unknown as Array<{ total: string }>;
    const held = rows[0]?.total ?? "0";
    if (!alreadyMarked && Number(held) !== 0) {
      console.error(
        `[billing-service] agent/API org ${orgId} was marked AFTER it received ${held} cents of free credit (kept, never clawed back); it must be marked at provisioning`
      );
    }
    const [account] = await tx
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId))
      .limit(1);
    return { orgId, created: false, alreadyMarked, freeCreditHeldCents: held, account };
  });
}
