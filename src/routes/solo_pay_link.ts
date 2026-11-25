import express, { Router, type Response } from "express";
import { Decimal } from "decimal.js";
import { PLATFORM_USER_ID, type SoloPlan } from "../db/schema.js";
import { computeBalance } from "../lib/balance.js";
import { ensureOrgStripeCustomer } from "../lib/account.js";
import { createPlatformRun, completePlatformRun } from "../lib/runs-client.js";
import { getCardSetup } from "../lib/stripe-service-client.js";
import { nextPeriodEnd } from "../lib/subscription-schedule.js";
import {
  addSoloPlanLayer,
  getSoloPlan,
  SOLO_PLAN_BASE_MONTHLY_CENTS,
  SOLO_PLAN_LAYER_CENTS,
  SoloPlanRefused,
  startSoloPlan,
  startSoloPlanNow,
} from "../lib/solo-plan.js";
import { payLinkUrl, verifyPayToken } from "../lib/solo-pay-link.js";

/**
 * The PUBLIC pay page of the solo-founder plan (lib/solo-pay-link): no API key, no
 * login. Mounted BEFORE requireApiKey. The gateway proxies GET + POST
 * `/public/solo-plan/pay/:token` from the public host.
 *
 * GET only shows (link previews fetch it); the single POST button moves the money,
 * carrying the state the page showed (`expect`) so a stale page never charges twice.
 */
const router = Router();
router.use("/public/solo-plan/pay", express.urlencoded({ extended: false }));

function usd(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function day(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

function page(res: Response, status: number, body: { title: string; lines: string[]; button?: { label: string; expect: string }; note?: string }) {
  const lines = body.lines.map((l) => `<p>${esc(l)}</p>`).join("");
  const note = body.note ? `<p class="note">${esc(body.note)}</p>` : "";
  const form = body.button
    ? `<form method="post"><input type="hidden" name="expect" value="${esc(body.button.expect)}"><button type="submit">${esc(body.button.label)}</button></form>`
    : "";
  res
    .status(status)
    .set("Cache-Control", "no-store")
    .set("X-Robots-Tag", "noindex")
    .type("html")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(body.title)} | distribute.you</title>` +
        `<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f6f5f2;color:#1c1c1c;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}` +
        `main{background:#fff;border:1px solid #e4e2dc;border-radius:14px;padding:32px;max-width:420px;width:calc(100% - 48px)}h1{font-size:22px;margin:0 0 16px}p{line-height:1.5;margin:0 0 12px}` +
        `.note{background:#eef6ee;border-radius:8px;padding:10px 12px}button{margin-top:12px;width:100%;padding:14px;font-size:16px;border:0;border-radius:10px;background:#1c1c1c;color:#fff;cursor:pointer}` +
        `.brand{font-size:13px;color:#777;margin-top:20px}</style></head><body><main><h1>${esc(body.title)}</h1>${note}${lines}${form}<p class="brand">distribute.you · Revenue made easy.</p></main></body></html>`
    );
}

/** What the page shows for this plan, and the state its button commits to. */
function expectOf(plan: SoloPlan | null): string {
  if (!plan) return "none";
  return `${plan.status}:${plan.monthlyAmountCents}:${plan.currentPeriodStart?.toISOString() ?? ""}`;
}

const DONE_NOTES: Record<string, string> = {
  trial: "Your trial has started. Distry can launch your campaigns now.",
  paid: "Payment received. Your credit for this month is ready.",
  layer: "Payment received. Your new monthly budget is live.",
};

async function render(res: Response, orgId: string, done?: string) {
  const plan = await getSoloPlan(orgId);
  const note = done ? DONE_NOTES[done] : undefined;
  const expect = expectOf(plan);
  if (!plan || plan.status === "free") {
    page(res, 200, {
      title: "Start your 3-day trial",
      note,
      lines: [
        `Get ${usd(SOLO_PLAN_BASE_MONTHLY_CENTS)} of credit every month for distribute.you to bring you revenue.`,
        `Your card gets a ${usd(SOLO_PLAN_BASE_MONTHLY_CENTS)} hold today. The first payment comes on day 3.`,
      ],
      button: { label: "Start my trial", expect },
    });
    return;
  }
  if (plan.status === "trialing") {
    page(res, 200, {
      title: "Start your plan today",
      note,
      lines: [`Pay ${usd(plan.monthlyAmountCents)} now and get ${usd(plan.monthlyAmountCents)} of credit this month.`],
      button: { label: `Pay ${usd(plan.monthlyAmountCents)} now`, expect },
    });
    return;
  }
  if (plan.status === "active") {
    const snapshot = await computeBalance(orgId);
    const unspent = Decimal.max(0, new Decimal(snapshot.balanceCents));
    const next = plan.monthlyAmountCents + SOLO_PLAN_LAYER_CENTS;
    const charge = Decimal.max(0, new Decimal(next).minus(unspent).ceil()).toNumber();
    const unspentCents = Math.floor(unspent.toNumber());
    const now = new Date();
    page(res, 200, {
      title: `Grow to ${usd(next)} a month`,
      note,
      lines: [
        `Get ${usd(next)} of credit every month, starting today.`,
        unspentCents > 0
          ? `You pay ${usd(charge)} today. Your ${usd(unspentCents)} of unused credit comes off the price.`
          : `You pay ${usd(charge)} today.`,
        `Your new month runs until ${day(nextPeriodEnd(now, now))}.`,
      ],
      button: { label: `Pay ${usd(charge)} now`, expect },
    });
    return;
  }
  page(res, 200, {
    title: "Update your card",
    note,
    lines: ["Your last payment did not go through. Add a card to keep your campaigns running."],
    button: { label: "Update my card", expect },
  });
}

function badLink(res: Response) {
  page(res, 404, { title: "This link has expired", lines: ["Ask Distry for a new link."] });
}

router.get("/public/solo-plan/pay/:token", async (req, res) => {
  const orgId = verifyPayToken(req.params.token);
  if (!orgId) return badLink(res);
  try {
    const done = typeof req.query.done === "string" ? req.query.done : undefined;
    await render(res, orgId, done);
  } catch (err) {
    console.error(`[billing-service] solo pay page failed for org ${orgId}:`, err);
    page(res, 502, { title: "Something went wrong", lines: ["Please try again in a minute."] });
  }
});

router.post("/public/solo-plan/pay/:token", async (req, res) => {
  const token = req.params.token;
  const orgId = verifyPayToken(token);
  if (!orgId) return badLink(res);
  // RELATIVE to the page (its last segment): the gateway serves this page under its own
  // prefix, so an absolute `/public/...` Location would leave it.
  const self = token;
  const plan = await getSoloPlan(orgId).catch(() => undefined);
  if (plan === undefined) {
    page(res, 502, { title: "Something went wrong", lines: ["Please try again in a minute."] });
    return;
  }
  // A stale page (back button, second click) never charges: show the current state.
  if ((req.body?.expect ?? "") !== expectOf(plan)) {
    res.redirect(303, self);
    return;
  }

  const runId = await createPlatformRun("solo-pay-link");
  try {
    if (!plan || plan.status === "free" || plan.status === "past_due") {
      const returnUrl = payLinkUrl(orgId);
      if (!returnUrl) {
        console.error("[billing-service] solo pay page: SOLO_PLAN_PUBLIC_BASE_URL is not set, cannot hand out a card page");
        page(res, 503, { title: "Something went wrong", lines: ["Please try again later."] });
        return;
      }
      const userId = plan?.startedByUserId ?? PLATFORM_USER_ID;
      const identity: Record<string, string> = { "x-org-id": orgId, "x-user-id": userId };
      if (runId) identity["x-run-id"] = runId;
      if (plan?.status === "past_due") {
        await ensureOrgStripeCustomer(identity);
        const setup = await getCardSetup(orgId, returnUrl, undefined, "usd", "hosted", plan.startedByUserId ?? undefined);
        if (typeof setup.url !== "string") throw new Error(`card setup for org ${orgId} returned no hosted url`);
        res.redirect(303, setup.url);
        return;
      }
      const result = await startSoloPlan({ orgId, identity, userId: plan?.startedByUserId ?? null, returnUrl, uiMode: "hosted" });
      if (result.state === "card_required") {
        if (!result.checkoutUrl) throw new Error(`card setup for org ${orgId} returned no hosted url`);
        res.redirect(303, result.checkoutUrl);
        return;
      }
      res.redirect(303, `${self}?done=trial`);
      return;
    }
    if (plan.status === "trialing") {
      await startSoloPlanNow(orgId);
      res.redirect(303, `${self}?done=paid`);
      return;
    }
    await addSoloPlanLayer(orgId);
    res.redirect(303, `${self}?done=layer`);
  } catch (err) {
    if (err instanceof SoloPlanRefused) {
      const lines =
        err.code === "card_hold_requires_action"
          ? ["Your bank asks to confirm this card. Try another card, or try again from your bank app."]
          : [err.message];
      page(res, err.status === 502 ? 502 : 409, { title: "Not done yet", lines });
      return;
    }
    console.error(`[billing-service] solo pay action failed for org ${orgId}:`, err);
    page(res, 502, { title: "Something went wrong", lines: ["Please try again in a minute."] });
  } finally {
    if (runId) void completePlatformRun(runId).catch((e) => console.error("[billing-service] solo pay run close failed:", e));
  }
});

export default router;
