import { Router, type Response } from "express";
import { requireOrgHeaders, getWorkflowHeaders, forwardWorkflowHeaders } from "../middleware/auth.js";
import { computeBalance } from "../lib/balance.js";
import { isRealOrgId } from "../lib/org-id.js";
import {
  addSoloPlanLayer,
  enrolSoloPlan,
  readSoloAiGate,
  readSoloPlanState,
  settleSoloPlan,
  soloPlanStateOf,
  SoloPlanRefused,
  startSoloPlan,
  startSoloPlanNow,
} from "../lib/solo-plan.js";
import { SoloPlanStartRequestSchema } from "../schemas.js";

/**
 * The SOLO-FOUNDER plan (lib/solo-plan). Customer routes carry the org headers (via
 * the api-service gateway, called by the MCP tools); the internal routes take the org
 * in the path (x-api-key only) for services that read the plan state.
 */
const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(res: Response, err: SoloPlanRefused): void {
  res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
}

async function stateResponse(orgId: string) {
  const state = await readSoloPlanState(orgId);
  if (!state) throw new Error(`solo plan of org ${orgId} vanished`);
  return state;
}

router.post("/v1/accounts/solo_plan/enroll", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    await enrolSoloPlan(orgId, req.headers["x-user-id"] as string);
    res.json(await stateResponse(orgId));
  } catch (err) {
    if (err instanceof SoloPlanRefused) return refuse(res, err);
    console.error(`[billing-service] solo plan enrol failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to enrol the account on the solo-founder plan" });
  }
});

router.get("/v1/accounts/solo_plan", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    // The customer read settles first: a plan whose card just landed starts, a trial
    // that ended converts, a cycle that ended renews.
    const plan = await settleSoloPlan(orgId);
    if (!plan) {
      res.status(404).json({ error: "This account is not on the solo-founder plan", code: "not_enrolled" });
      return;
    }
    const snapshot = await computeBalance(orgId);
    res.json(soloPlanStateOf(orgId, plan, snapshot.balanceCents));
  } catch (err) {
    console.error(`[billing-service] solo plan read failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to read the solo-founder plan" });
  }
});

router.post("/v1/accounts/solo_plan/start", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const parsed = SoloPlanStartRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const uiMode = parsed.data.ui_mode ?? "hosted";
  if (uiMode === "hosted" && !parsed.data.return_url) {
    res.status(400).json({ error: "return_url is required for a hosted card page" });
    return;
  }
  try {
    const result = await startSoloPlan({
      orgId,
      userId,
      identity: {
        "x-org-id": orgId,
        "x-user-id": userId,
        "x-run-id": req.headers["x-run-id"] as string,
        ...forwardWorkflowHeaders(getWorkflowHeaders(req)),
      },
      returnUrl: parsed.data.return_url,
      uiMode,
    });
    const state = await stateResponse(orgId);
    if (result.state === "card_required") {
      res.json({
        ...state,
        card_required: true,
        checkout_url: result.checkoutUrl,
        card_setup: result.cardSetup,
        card_refused_reason: result.cardRefusedReason,
      });
      return;
    }
    res.json({ ...state, card_required: false, checkout_url: null, card_setup: null, card_refused_reason: null });
  } catch (err) {
    if (err instanceof SoloPlanRefused) return refuse(res, err);
    console.error(`[billing-service] solo plan start failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to start the solo-founder plan" });
  }
});

router.post("/v1/accounts/solo_plan/start_now", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    await startSoloPlanNow(orgId);
    res.json(await stateResponse(orgId));
  } catch (err) {
    if (err instanceof SoloPlanRefused) return refuse(res, err);
    console.error(`[billing-service] solo plan start-now failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to start the paid plan now" });
  }
});

router.post("/v1/accounts/solo_plan/layers", requireOrgHeaders, async (req, res) => {
  const orgId = req.headers["x-org-id"] as string;
  try {
    const layer = await addSoloPlanLayer(orgId);
    res.json({
      ...(await stateResponse(orgId)),
      charged_cents: layer.chargedCents,
      unspent_credit_deducted_cents: layer.unspentDiscountCents,
    });
  } catch (err) {
    if (err instanceof SoloPlanRefused) return refuse(res, err);
    console.error(`[billing-service] solo plan layer failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to add budget to the plan" });
  }
});

router.get("/internal/accounts/by-org/:orgId/solo-plan", async (req, res) => {
  const { orgId } = req.params;
  if (!isRealOrgId(orgId)) {
    res.status(400).json({ error: "orgId must be a UUID" });
    return;
  }
  try {
    const state = await readSoloPlanState(orgId);
    if (!state) {
      res.status(404).json({ error: "This account is not on the solo-founder plan", code: "not_enrolled" });
      return;
    }
    res.json(state);
  } catch (err) {
    console.error(`[billing-service] solo plan internal read failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to read the solo-founder plan" });
  }
});

router.get("/internal/accounts/by-org/:orgId/solo-plan/ai-gate", async (req, res) => {
  const { orgId } = req.params;
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "orgId must be a UUID" });
    return;
  }
  try {
    res.json(await readSoloAiGate(orgId));
  } catch (err) {
    console.error(`[billing-service] solo plan AI gate read failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to read the solo-founder plan" });
  }
});

router.post("/internal/accounts/by-org/:orgId/solo-plan/enroll", async (req, res) => {
  const { orgId } = req.params;
  if (!isRealOrgId(orgId)) {
    res.status(400).json({ error: "orgId must be a UUID" });
    return;
  }
  const userId = req.headers["x-user-id"];
  try {
    await enrolSoloPlan(orgId, typeof userId === "string" && UUID_RE.test(userId) ? userId : null);
    res.json(await stateResponse(orgId));
  } catch (err) {
    if (err instanceof SoloPlanRefused) return refuse(res, err);
    console.error(`[billing-service] solo plan internal enrol failed for org ${orgId}:`, err);
    res.status(502).json({ error: "Failed to enrol the account on the solo-founder plan" });
  }
});

export default router;
