/**
 * Minimal brand-service read: turn an org id into something a human recognises.
 *
 * This exists for ONE caller — the referral promises read. An inviter looking at a
 * pending $500 must see WHICH of their referrals earned it, and three converting
 * referrals otherwise render as three identical rows. billing-service is the only
 * service that knows the referral relationship exists, and that relationship is
 * exactly what makes it legitimate to reveal anything about the other org: the
 * inviter shared their link with that person. No other service can make that
 * authorization decision, so no other service can safely perform the lookup.
 *
 * Deliberately NOT a general "look up any org" capability:
 *   - it returns a display name + a domain and nothing else. Never spend, campaigns,
 *     credits, performance — the inviter is entitled to know who converted, not to
 *     see their business;
 *   - the only call site resolves the org named ON a promise row this org holds.
 *
 * `GET /orgs/brands` is api-key + `x-org-id` (brand-service `apiKeyAuth` +
 * `requireOrgId`), so this is a service-auth, org-keyed read of ONE org's brands —
 * no fake `x-user-id` sentinel is invented, and no fleet-wide list is pulled.
 */

import { fetchWithRetry } from "./fetch-retry.js";

/** What a person needs to recognise another org. Nothing more. */
export interface OrgDisplayIdentity {
  /** Brand display name, or null when brand-service has none stored. */
  name: string | null;
  /** Normalized domain — what the dashboard turns into a logo. Null when unknown. */
  domain: string | null;
}

interface BrandRow {
  id: string;
  name: string | null;
  domain: string | null;
  createdAt: string | null;
}

const LOOKUP_TIMEOUT_MS = 5_000;

function getBrandServiceConfig(): { url: string; apiKey: string } | null {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/**
 * The org's most recognisable brand.
 *
 * Prefers a brand that carries a domain (that is what renders a logo), and among
 * those takes the OLDEST — an org's founding brand, which stays put as they add
 * more, so the row does not rename itself between two dashboard loads. Falls back
 * to the oldest brand overall so a no-website org still gets its name.
 */
function pickDisplayBrand(brands: BrandRow[]): BrandRow | null {
  if (brands.length === 0) return null;
  const oldestFirst = [...brands].sort((a, b) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : Number.MAX_SAFE_INTEGER;
    const bt = b.createdAt ? Date.parse(b.createdAt) : Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });
  return oldestFirst.find((b) => !!b.domain) ?? oldestFirst[0];
}

/**
 * Resolve an org to a display identity, or null when there is nothing real to show.
 *
 * **Never throws, never fabricates.** A placeholder name is worse than no name, and
 * the promise itself is the money-bearing information: an identity lookup that fails
 * (brand-service down, unconfigured, slow, the org has no brand) must not take the
 * amounts down with it. That is the documented exception to this repo's fail-loud
 * rule, and it is why every failure path here returns null after logging loudly.
 */
export async function resolveOrgDisplayIdentity(
  orgId: string
): Promise<OrgDisplayIdentity | null> {
  const config = getBrandServiceConfig();
  if (!config) {
    console.warn(
      "[billing-service] BRAND_SERVICE not configured — referral promises will carry no display identity"
    );
    return null;
  }

  try {
    const res = await fetchWithRetry(`${config.url}/orgs/brands`, {
      method: "GET",
      headers: {
        "x-api-key": config.apiKey,
        "x-org-id": orgId,
      },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `[billing-service] brand-service /orgs/brands ${res.status} for org ${orgId}`
      );
      return null;
    }
    const body = (await res.json()) as { brands?: BrandRow[] };
    const picked = pickDisplayBrand(Array.isArray(body.brands) ? body.brands : []);
    if (!picked) return null;

    const name = picked.name && picked.name.trim() !== "" ? picked.name : null;
    const domain = picked.domain && picked.domain.trim() !== "" ? picked.domain : null;
    // Nothing identifying resolved — say nothing rather than emit two nulls.
    if (name === null && domain === null) return null;
    return { name, domain };
  } catch (err) {
    console.error(
      `[billing-service] Failed to resolve display identity for org ${orgId}:`,
      err
    );
    return null;
  }
}
