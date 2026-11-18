/**
 * ANSWERING A PERSON WHO WROTE TO US IS NEVER BLOCKED BY AN EMPTY BALANCE (REPLY-NO-BALANCE-1118).
 *
 * Owner 2026-11-18: « C'EST NON PROFESSIONNEL. ÇA COÛTE 3 CENTS DE RÉPONDRE ». Doc Dinners' prepaid balance hit $0
 * on 2026-11-10 (auto top-up off, no card); for 8 days the doctors who asked for prices and cities got no answer,
 * because every spend of the answering run was refused by its balance.
 *
 * New outreach to new people stays blocked by an empty prepaid balance (the customer funds it). A reply is not new
 * outreach: campaign-service admits a run that carries ONE person waiting on our answer whatever the balance, and
 * records that admission here (`grantAnswerPass`). While a pass of the campaign is live, authorize grants the
 * campaign's spends that ONLY the balance would refuse (no reload possible): the spend lands on the balance like any
 * other spend (repaid by the next top-up). Every other refusal is unchanged and comes first: the customer's sales
 * funnel max budget, the monthly limit, a paused/cancelled plan, a refused card.
 *
 * Keyed on the CAMPAIGN, not the run: the run's children (the LLM call, the send) authorize under their own run ids
 * with the campaign's `x-campaign-id`. While the balance cannot afford a run, campaign-service refuses every run of
 * the campaign that answers nobody, so a live pass only covers answering runs. TTL = twice the run liveness window
 * (15 min): an answering run is done well before; a run that dies keeps nothing open past it.
 */
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { answerPasses } from "../db/schema.js";

export const ANSWER_PASS_TTL_MS = 30 * 60_000;

export interface AnswerPassInput {
  orgId: string;
  campaignId: string;
  runId: string;
  brandId?: string | null;
  leadId?: string | null;
}

export async function grantAnswerPass(input: AnswerPassInput, now: Date = new Date()): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + ANSWER_PASS_TTL_MS);
  const [row] = await db
    .insert(answerPasses)
    .values({
      orgId: input.orgId,
      campaignId: input.campaignId,
      runId: input.runId,
      brandId: input.brandId ?? null,
      leadId: input.leadId ?? null,
      grantedAt: now,
      expiresAt,
    })
    .returning({ id: answerPasses.id, expiresAt: answerPasses.expiresAt });
  return row;
}

/** The live pass of this campaign at this org, or null. No campaign = no pass. */
export async function liveAnswerPass(
  orgId: string,
  campaignId: string | undefined,
  now: Date = new Date(),
): Promise<{ id: string; runId: string; leadId: string | null } | null> {
  if (!campaignId) return null;
  const [row] = await db
    .select({ id: answerPasses.id, runId: answerPasses.runId, leadId: answerPasses.leadId })
    .from(answerPasses)
    .where(and(eq(answerPasses.orgId, orgId), eq(answerPasses.campaignId, campaignId), gt(answerPasses.expiresAt, now)))
    .limit(1);
  return row ?? null;
}
