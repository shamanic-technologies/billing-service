import { Router } from "express";
import { UpdatePromoCodeRequestSchema } from "../schemas.js";
import {
  getPromoCode,
  setPromoCodeAmount,
  PromoNotFoundError,
} from "../lib/promos.js";

const router = Router();

// GET /internal/promo-codes/:code — read a promo code's current grant amount.
//
// Auth: x-api-key (service-to-service). The live value read at redeem time.
// Resp: { code, amount_cents } | 404 if unknown.
router.get("/internal/promo-codes/:code", async (req, res) => {
  try {
    const promo = await getPromoCode(req.params.code);
    res.json({ code: promo.code, amount_cents: promo.amountCents });
  } catch (err) {
    if (err instanceof PromoNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// PATCH /internal/promo-codes/:code — re-price an admin-managed promo code
// (e.g. the welcome gift) WITHOUT a migration or deploy.
//
// Auth: x-api-key (service-to-service). The gateway must gate this to staff.
// Body: { amountCents } (non-negative integer)
// Resp: { code, amount_cents } | 400 invalid body | 404 unknown code.
//
// Applies to NEW redemptions only — orgs that already redeemed keep their grant.
router.patch("/internal/promo-codes/:code", async (req, res) => {
  const parsed = UpdatePromoCodeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  try {
    const promo = await setPromoCodeAmount(
      req.params.code,
      parsed.data.amountCents
    );
    console.log(
      `[billing-service] promo-code amount set: code=${promo.code} amount=${promo.amountCents}`
    );
    res.json({ code: promo.code, amount_cents: promo.amountCents });
  } catch (err) {
    if (err instanceof PromoNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
