/**
 * A subscription PLAN belongs to one brand x offer (owner decision 2026-10-03;
 * migration 0058). This module holds the two brand-service reads that decision
 * needs, both org-keyed (`x-api-key` + `x-org-id`, no user identity invented):
 *
 *   - does this offer exist under this brand FOR THIS ORG (a plan is never bought
 *     for an offer the org does not sell);
 *   - which brand x offer is the org's FIRST one, to attribute a plan started
 *     before plans were per offer (the onboarding route still sends neither).
 *
 * FIRST = the org's oldest brand (brand-service `createdAt`), then that brand's
 * oldest ACTIVE offer (brand-service lists offers oldest first; an archived offer
 * is one the owner took off the switcher). The answer is STAMPED on the plan the
 * first time it resolves, so it never moves as the org adds brands later.
 *
 * Fail loud: brand-service unconfigured / unreachable / non-2xx THROWS. An org
 * with no brand or no offer is a definite answer (null), not an error.
 */

import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { subscriptions } from "../db/schema.js";
import { fetchWithRetry } from "./fetch-retry.js";

const READ_TIMEOUT_MS = 10_000;

function config(): { url: string; apiKey: string } {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[billing-service] BRAND_SERVICE_URL / BRAND_SERVICE_API_KEY not configured");
  }
  return { url, apiKey };
}

async function brandServiceGet<T>(orgId: string, path: string): Promise<T> {
  const { url, apiKey } = config();
  const res = await fetchWithRetry(`${url}${path}`, {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`[billing-service] brand-service GET ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface BrandOffer {
  offerId: string;
  status: string | null;
}

/** Every offer the org sells under this brand, oldest first (archived included). */
export async function fetchBrandOffers(orgId: string, brandId: string): Promise<BrandOffer[]> {
  const body = await brandServiceGet<{ offers?: Array<{ offerId?: string; status?: string }> }>(
    orgId,
    `/internal/brands/${encodeURIComponent(brandId)}/offers`
  );
  if (!Array.isArray(body.offers)) {
    throw new Error(`[billing-service] brand-service offers for brand ${brandId}: no offers array`);
  }
  return body.offers
    .filter((o) => typeof o.offerId === "string")
    .map((o) => ({ offerId: (o.offerId as string).toLowerCase(), status: o.status ?? null }));
}

/** The org's brands, oldest first. */
export async function fetchOrgBrandIdsOldestFirst(orgId: string): Promise<string[]> {
  const body = await brandServiceGet<{ brands?: Array<{ id?: string; createdAt?: string | null }> }>(
    orgId,
    "/orgs/brands"
  );
  if (!Array.isArray(body.brands)) {
    throw new Error(`[billing-service] brand-service brands for org ${orgId}: no brands array`);
  }
  return body.brands
    .filter((b): b is { id: string; createdAt?: string | null } => typeof b.id === "string")
    .sort((a, b) => {
      const at = a.createdAt ? Date.parse(a.createdAt) : Number.MAX_SAFE_INTEGER;
      const bt = b.createdAt ? Date.parse(b.createdAt) : Number.MAX_SAFE_INTEGER;
      return at !== bt ? at - bt : a.id.localeCompare(b.id);
    })
    .map((b) => b.id.toLowerCase());
}

/** Is this offer one the org sells under this brand (active)? */
export async function isOrgOfferOnBrand(
  orgId: string,
  brandId: string,
  offerId: string
): Promise<boolean> {
  const offers = await fetchBrandOffers(orgId, brandId);
  return offers.some((o) => o.offerId === offerId.toLowerCase() && o.status !== "archived");
}

/** The org's first brand x offer, or null when it has no brand carrying an active offer. */
export async function resolveFirstBrandOffer(
  orgId: string
): Promise<{ brandId: string; offerId: string } | null> {
  for (const brandId of await fetchOrgBrandIdsOldestFirst(orgId)) {
    const offer = (await fetchBrandOffers(orgId, brandId)).find((o) => o.status !== "archived");
    if (offer) return { brandId, offerId: offer.offerId };
  }
  return null;
}

/**
 * Stamp the org's live unattributed plan (at most one, by the 0058 index) with the
 * org's first brand x offer. No-op when there is none. When nothing resolves (no
 * brand / offer yet) the plan stays unattributed and is listed with null keys.
 * When that pair already carries another live plan, the stamp would break the
 * one-live-per-pair rule: it is left unattributed and logged.
 */
export async function attributeUnassignedPlan(orgId: string): Promise<void> {
  const [plan] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.orgId, orgId),
        ne(subscriptions.status, "canceled"),
        isNull(subscriptions.brandId),
        isNull(subscriptions.offerId)
      )
    )
    .limit(1);
  if (!plan) return;

  const first = await resolveFirstBrandOffer(orgId);
  if (!first) {
    console.warn(`[billing-service] plan ${plan.id} of org ${orgId}: no brand x offer to attribute it to yet`);
    return;
  }
  try {
    await db
      .update(subscriptions)
      .set({ brandId: first.brandId, offerId: first.offerId, updatedAt: new Date() })
      .where(and(eq(subscriptions.id, plan.id), isNull(subscriptions.brandId)));
    console.log(
      `[billing-service] plan ${plan.id} of org ${orgId} attributed to brand ${first.brandId} x offer ${first.offerId}`
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    console.error(
      `[billing-service] plan ${plan.id} of org ${orgId}: brand ${first.brandId} x offer ${first.offerId} already has a live plan; left unattributed`
    );
  }
}
