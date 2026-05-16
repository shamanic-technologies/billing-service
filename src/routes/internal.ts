import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { TransferBrandRequestSchema } from "../schemas.js";
import {
  listCustomersByMetadata,
  updateCustomer,
  type StripeCustomer,
} from "../lib/stripe-service-client.js";

const router = Router();

const SS_LIST_PAGE_LIMIT = 100;
const INTERNAL_IDENTITY: Record<string, string> = {
  "x-user-id": "00000000-0000-0000-0000-000000000000",
};

/**
 * Parse a Stripe customer's `metadata.brand_id` value. We store it as a
 * comma-separated string (Stripe metadata values are strings, max 500 chars).
 * Empty/missing → []. Trims whitespace.
 */
function parseBrandIds(metadata: Record<string, string>): string[] {
  const raw = metadata.brand_id;
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Decide whether a Stripe customer is safe to repoint to the target org.
 *
 * Mirrors the local_promos solo-brand semantics: a customer is in scope only
 * if its `brand_id` metadata holds exactly one brand AND that brand is the
 * source brand. Multi-brand customers are skipped — moving them would orphan
 * the other brands. Customers with no `brand_id` are skipped (org-wide
 * artifact, not brand-scoped).
 */
function isSoloBrandMatch(customer: StripeCustomer, sourceBrandId: string): boolean {
  const brandIds = parseBrandIds(customer.metadata ?? {});
  return brandIds.length === 1 && brandIds[0] === sourceBrandId;
}

async function listAllOrgCustomers(sourceOrgId: string): Promise<StripeCustomer[]> {
  const out: StripeCustomer[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await listCustomersByMetadata(INTERNAL_IDENTITY, {
      metadata: { org_id: sourceOrgId },
      limit: SS_LIST_PAGE_LIMIT,
      starting_after: startingAfter,
    });
    out.push(...page.data);
    if (!page.has_more) break;
    const last = page.data[page.data.length - 1];
    if (!last) break;
    startingAfter = last.id;
  }
  return out;
}

// POST /internal/transfer-brand — re-assigns solo-brand rows between orgs.
//
// Two-sided:
//   - billing-local `local_promos` (per-org promo credits) — UPDATE here
//   - stripe-service customers — list by metadata.org_id=source, patch
//     metadata for the subset whose metadata.brand_id is the source brand
//     (solo-brand only — multi-brand customers stay put).
router.post("/internal/transfer-brand", async (req, res) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

  const localStep1 = await db.execute(sql`
    UPDATE local_promos
    SET org_id = ${targetOrgId}
    WHERE org_id = ${sourceOrgId}
      AND array_length(brand_ids, 1) = 1
      AND brand_ids[1] = ${sourceBrandId}
  `);
  let localCount = Number(localStep1.count ?? 0);

  if (targetBrandId) {
    const localStep2 = await db.execute(sql`
      UPDATE local_promos
      SET brand_ids = ARRAY[${targetBrandId}]
      WHERE array_length(brand_ids, 1) = 1
        AND brand_ids[1] = ${sourceBrandId}
    `);
    localCount = Math.max(localCount, Number(localStep2.count ?? 0));
  }

  let candidates: StripeCustomer[];
  try {
    candidates = await listAllOrgCustomers(sourceOrgId);
  } catch (err) {
    console.error("[billing-service] stripe-service customer list failed:", err);
    res.status(502).json({ error: "Failed to list customers from stripe-service" });
    return;
  }

  const targets = candidates.filter((c) => isSoloBrandMatch(c, sourceBrandId));
  const skippedMultiBrand = candidates.filter((c) => {
    const ids = parseBrandIds(c.metadata ?? {});
    return ids.length > 1 && ids.includes(sourceBrandId);
  });

  if (skippedMultiBrand.length > 0) {
    console.warn(
      `[billing-service] transfer-brand: skipping ${skippedMultiBrand.length} multi-brand customer(s) tagged with sourceBrandId=${sourceBrandId} ` +
      `(would orphan co-brands). Customer ids: ${skippedMultiBrand.map((c) => c.id).join(",")}`
    );
  }

  let ssCount = 0;
  for (const customer of targets) {
    const newMetadata: Record<string, string> = {
      ...(customer.metadata ?? {}),
      org_id: targetOrgId,
    };
    if (targetBrandId) {
      newMetadata.brand_id = targetBrandId;
    }
    try {
      await updateCustomer(customer.id, INTERNAL_IDENTITY, { metadata: newMetadata });
      ssCount += 1;
    } catch (err) {
      console.error(`[billing-service] stripe-service updateCustomer ${customer.id} failed:`, err);
      res.status(502).json({
        error: "Failed to update customer metadata in stripe-service",
        partial: { stripe_service_customers_patched: ssCount, total_targets: targets.length },
      });
      return;
    }
  }

  console.log(
    `[billing-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} from=${sourceOrgId} to=${targetOrgId} ` +
    `local_promos=${localCount} stripe_customers_patched=${ssCount} stripe_candidates_scanned=${candidates.length} stripe_skipped_multibrand=${skippedMultiBrand.length}`
  );

  res.json({
    updatedTables: [
      { tableName: "local_promos", count: localCount },
      { tableName: "stripe_service_customers", count: ssCount },
    ],
  });
});

export default router;
