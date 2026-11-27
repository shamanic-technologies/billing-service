import { Router } from "express";
import {
  SpecialOfferApplyRequestSchema,
  SpecialOfferCreateRequestSchema,
} from "../schemas.js";
import {
  applySpecialOfferToPayment,
  createSpecialOffer,
  listSpecialOffers,
  listSpecialOffersForOrg,
  SpecialOfferConflictError,
  SpecialOfferNotFoundError,
  SpecialOfferPaymentNotFoundError,
  SpecialOfferPaymentsUnreadableError,
  SpecialOfferRefusedError,
  type SpecialOfferPaymentView,
} from "../lib/special-offers.js";
import { GrantPromoCodeMissingError } from "../lib/promos.js";
import { computeBalance } from "../lib/balance.js";
import { isRealOrgId } from "../lib/org-id.js";

// Special offers (SPECIAL-OFFER-BF-1127): a named, dated commercial offer ("Black
// Friday 2026") apart from the standing offers. Staff creates one and applies it to
// an org's payment on the /internal routes (x-api-key only, staff tooling on the box,
// never proxied to customers); the org reads what each offer brought it on
// GET /v1/special-offers. See lib/special-offers.
const router = Router();

function paymentWire(p: SpecialOfferPaymentView) {
  return {
    payment_id: p.paymentId,
    acquirer: p.acquirer,
    paid_cents: p.paidCents,
    paid_at: p.paidAt,
    free_credit_cents: p.freeCreditCents,
    grant_id: p.grantId,
    applied_at: p.appliedAt,
  };
}

// POST /internal/special-offers — create an offer. Idempotent on the slug; the same
// slug with different terms is a 409.
router.post("/internal/special-offers", async (req, res) => {
  const parsed = SpecialOfferCreateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { slug, name, startsAt, endsAt, bonusRatioBps, createdBy } = parsed.data;
  const starts = new Date(startsAt);
  const ends = new Date(endsAt);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) {
    res.status(400).json({ error: "startsAt and endsAt must be ISO date-times with endsAt after startsAt" });
    return;
  }
  try {
    const result = await createSpecialOffer({ slug, name, startsAt: starts, endsAt: ends, bonusRatioBps, createdBy });
    console.log(
      `[billing-service] special offer ${result.alreadyExisted ? "already exists" : "created"}: slug=${slug} name="${name}" ratio_bps=${bonusRatioBps} by=${createdBy}`
    );
    res.json({ ok: true as const, alreadyExisted: result.alreadyExisted, specialOffer: result.offer });
  } catch (err) {
    if (err instanceof SpecialOfferConflictError) {
      res.status(409).json({ error: err.message, code: "special_offer_exists_with_other_terms" });
      return;
    }
    throw err;
  }
});

// GET /internal/special-offers — every offer (staff).
router.get("/internal/special-offers", async (_req, res) => {
  res.json({ specialOffers: await listSpecialOffers() });
});

// POST /internal/special-offers/:slug/payments — count one of an org's payments under
// the offer and grant the free credit it earns. Idempotent per payment.
router.post("/internal/special-offers/:slug/payments", async (req, res) => {
  const parsed = SpecialOfferApplyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { orgId, paymentId, appliedBy, freeCreditCents, note } = parsed.data;
  if (!isRealOrgId(orgId)) {
    res.status(400).json({ error: "orgId must be a real organization UUID" });
    return;
  }

  let result;
  try {
    result = await applySpecialOfferToPayment({
      slug: req.params.slug,
      orgId,
      paymentId,
      appliedBy,
      freeCreditCents,
      note,
    });
  } catch (err) {
    if (err instanceof SpecialOfferNotFoundError) {
      res.status(404).json({ error: err.message, code: "special_offer_not_found" });
      return;
    }
    if (err instanceof SpecialOfferPaymentNotFoundError) {
      res.status(404).json({ error: err.message, code: "payment_not_found" });
      return;
    }
    if (err instanceof SpecialOfferRefusedError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof GrantPromoCodeMissingError) {
      console.error("[billing-service] special offer ledger key missing:", err);
      res.status(500).json({ error: err.message });
      return;
    }
    if (err instanceof SpecialOfferPaymentsUnreadableError) {
      console.error("[billing-service] special offer apply failed:", err);
      res.status(502).json({ error: err.message, code: "payments_unreadable" });
      return;
    }
    throw err;
  }

  let newBalanceCents: string;
  try {
    newBalanceCents = (await computeBalance(orgId)).balanceCents;
  } catch (err) {
    console.error("[billing-service] special offer compose balance failed:", err);
    res.status(502).json({ error: "Offer applied but failed to compose new balance" });
    return;
  }
  console.log(
    `[billing-service] special offer applied: offer=${result.offer.slug} org=${orgId} payment=${result.payment.acquirer}:${paymentId} paid=${result.payment.paidCents} free=${result.payment.freeCreditCents} by=${appliedBy} already=${result.alreadyApplied} balance=${newBalanceCents}`
  );
  res.json({
    ok: true as const,
    alreadyApplied: result.alreadyApplied,
    orgId,
    specialOffer: { slug: result.offer.slug, name: result.offer.name },
    payment: paymentWire(result.payment),
    newBalanceCents,
  });
});

// GET /v1/special-offers — what each special offer brought THIS org (x-org-id): the
// offer's name, the payments the org made under it and the free credit they earned,
// totals ready-made. Empty list when the org has none. Pure read.
router.get("/v1/special-offers", async (req, res) => {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!isRealOrgId(orgId)) {
    console.error(`[billing-400] ${req.method} ${req.path}: missing/invalid x-org-id="${orgId}"`);
    res.status(400).json({ error: "x-org-id header is required and must be a valid UUID" });
    return;
  }
  const offers = await listSpecialOffersForOrg(orgId);
  res.json({
    org_id: orgId,
    special_offers: offers.map((o) => ({
      slug: o.slug,
      name: o.name,
      starts_at: o.startsAt,
      ends_at: o.endsAt,
      paid_cents: o.paidCents,
      free_credit_cents: o.freeCreditCents,
      payments: o.payments.map(paymentWire),
    })),
  });
});

export default router;
