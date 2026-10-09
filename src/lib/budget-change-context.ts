/**
 * The words a staff budget-change email needs, read from the services that own
 * them: channel names and leg shapes (features-service), brand and offer names
 * (brand-service), the org's name (client-service, else Clerk through
 * key-service).
 *
 * WHY THESE READS LIVE HERE. A staff member reading "Running: $13/day → $10/day,
 * Brand: 933d4abb-…" cannot tell which mission moved or whether the figure is
 * daily money at all (2026-09-29, brand NOVEMIQ: Herald $10 → $7/day was
 * reported as the $13 → $10 SUM of Herald and Pilot, Pilot being a reactive cap
 * that only spends when a positive reply triggers it). The names and the
 * daily-vs-reactive fact are published by the services above; billing copies
 * none of them into a table.
 *
 * NEVER PARSE A legKey. Whether a leg spends daily or only when triggered is the
 * catalogue's `from` (null = an entry leg that starts from nothing = daily).
 *
 * FAIL-SOFT, every reader: the notification is fire-and-forget off a customer
 * write, so each read logs loudly and returns null. The email then says in words
 * which part could not be read; it never guesses a name or merges a figure.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { canonicalLegKey } from "./leg-identity.js";

const READ_TIMEOUT_MS = 5_000;

// --- channels (features-service GET /public/channels) ------------------------
// A mission is named by its CHANNEL and leg outcome. Crew names (Herald, Pilot,
// ...) were retired on 2026-10-04: they now name sales path combinations, not a
// (channel, leg). `stepTransitions[].crewName` is ignored whether present, null
// or absent, so the deploy order with features-service does not matter.

export interface CatalogueLeg {
  /** The step the leg starts from; null for a leg starting from nothing. */
  fromLabel: string | null;
  /**
   * features-service's per-leg flag: true = fires when a lead reaches its start
   * step (a cap), false = funded and paced daily. null when not published, and
   * only then is the kind read off `fromLabel`. An outbound leg starts at
   * lead_found (owner 2026-10-09) and still spends daily, so a start step alone
   * no longer means reactive.
   */
  reactive: boolean | null;
  /**
   * The start step's plain trigger phrase (`Replies they're interested`), read
   * by the email's reactive line ("only when someone replies they're
   * interested"); null when the catalogue publishes none.
   */
  fromShortDescription: string | null;
  toLabel: string | null;
}

export interface CatalogueChannel {
  name: string | null;
  legs: Map<string, CatalogueLeg>;
}

/** featureSlug → channel. */
export type ChannelCatalogue = Map<string, CatalogueChannel>;

interface PublishedStep {
  label?: string | null;
  shortDescription?: string | null;
}
interface PublishedLeg {
  legKey?: string | null;
  reactive?: boolean | null;
  from?: PublishedStep | null;
  to?: PublishedStep | null;
}
interface PublishedChannel {
  slug?: string | null;
  name?: string | null;
  stepTransitions?: PublishedLeg[] | null;
}

/** Pure: shape the published catalogue into what the email reads. */
export function channelCatalogueFrom(channels: PublishedChannel[]): ChannelCatalogue {
  const catalogue: ChannelCatalogue = new Map();
  for (const channel of channels) {
    const slug = typeof channel?.slug === "string" ? channel.slug : "";
    if (!slug) continue;
    const legs = new Map<string, CatalogueLeg>();
    for (const leg of channel.stepTransitions ?? []) {
      if (typeof leg?.legKey !== "string" || !leg.legKey) continue;
      // Keyed by leg IDENTITY: either spelling of an outbound leg finds it.
      legs.set(canonicalLegKey(slug, leg.legKey), {
        fromLabel: leg.from ? (leg.from.label ?? null) : null,
        reactive: typeof leg.reactive === "boolean" ? leg.reactive : null,
        fromShortDescription:
          typeof leg.from?.shortDescription === "string" && leg.from.shortDescription.trim()
            ? leg.from.shortDescription.trim()
            : null,
        toLabel: leg.to?.label ?? null,
      });
    }
    catalogue.set(slug, {
      name: typeof channel.name === "string" ? channel.name : null,
      legs,
    });
  }
  return catalogue;
}

export async function fetchChannelCatalogue(): Promise<ChannelCatalogue | null> {
  const url = process.env.FEATURES_SERVICE_URL;
  if (!url) {
    console.warn(
      "[billing-service] FEATURES_SERVICE_URL unset — the budget-change email cannot name channels"
    );
    return null;
  }
  try {
    const res = await fetchWithRetry(`${url}/public/channels`, {
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `[billing-service] features-service /public/channels answered ${res.status} for the budget-change email`
      );
      return null;
    }
    const body = (await res.json()) as { channels?: PublishedChannel[] };
    if (!Array.isArray(body?.channels)) {
      console.error(
        "[billing-service] features-service /public/channels carried no channels array"
      );
      return null;
    }
    return channelCatalogueFrom(body.channels);
  } catch (err) {
    console.error(
      "[billing-service] features-service /public/channels unreachable for the budget-change email:",
      err
    );
    return null;
  }
}

// --- brand + offers (brand-service) ------------------------------------------

function brandServiceConfig(): { url: string; apiKey: string } | null {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  return url && apiKey ? { url, apiKey } : null;
}

export async function fetchBrandName(
  orgId: string,
  brandId: string
): Promise<string | null> {
  const config = brandServiceConfig();
  if (!config) return null;
  try {
    const res = await fetchWithRetry(
      `${config.url}/internal/brands/${brandId}?orgId=${encodeURIComponent(orgId)}`,
      {
        headers: { "x-api-key": config.apiKey, "x-org-id": orgId },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      console.error(
        `[billing-service] brand-service brand read ${res.status} for brand=${brandId}`
      );
      return null;
    }
    const body = (await res.json()) as { brand?: { name?: string | null } };
    const name = body?.brand?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch (err) {
    console.error(
      `[billing-service] brand-service brand read failed for brand=${brandId}:`,
      err
    );
    return null;
  }
}

/** offerId (lower-case) → offer name. */
export async function fetchOfferNames(
  orgId: string,
  brandId: string
): Promise<Map<string, string> | null> {
  const config = brandServiceConfig();
  if (!config) return null;
  try {
    const res = await fetchWithRetry(
      `${config.url}/internal/brands/${brandId}/offers`,
      {
        headers: { "x-api-key": config.apiKey, "x-org-id": orgId },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      console.error(
        `[billing-service] brand-service offers read ${res.status} for brand=${brandId}`
      );
      return null;
    }
    const body = (await res.json()) as {
      offers?: Array<{ offerId?: string; name?: string }>;
    };
    if (!Array.isArray(body?.offers)) return null;
    const names = new Map<string, string>();
    for (const offer of body.offers) {
      if (typeof offer?.offerId === "string" && typeof offer.name === "string") {
        names.set(offer.offerId.toLowerCase(), offer.name);
      }
    }
    return names;
  } catch (err) {
    console.error(
      `[billing-service] brand-service offers read failed for brand=${brandId}:`,
      err
    );
    return null;
  }
}

// --- org (client-service, else Clerk) ----------------------------------------

export interface OrgIdentity {
  /** The org's display name; null when neither source states one. */
  name: string | null;
  /** The Clerk org id, which is what the admin console's URLs carry. */
  externalId: string | null;
}

async function clerkOrgName(externalId: string): Promise<string | null> {
  const url = process.env.KEY_SERVICE_URL;
  const apiKey = process.env.KEY_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  const keyRes = await fetchWithRetry(`${url}/keys/platform/clerk/decrypt`, {
    headers: {
      "x-api-key": apiKey,
      "X-Caller-Service": "billing-service",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/internal/budget-change-notification",
    },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!keyRes.ok) {
    console.error(
      `[billing-service] key-service clerk platform key answered ${keyRes.status}`
    );
    return null;
  }
  const { key } = (await keyRes.json()) as { key?: string };
  if (!key) return null;
  const orgRes = await fetchWithRetry(
    `https://api.clerk.com/v1/organizations/${encodeURIComponent(externalId)}`,
    {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }
  );
  if (!orgRes.ok) {
    console.error(
      `[billing-service] Clerk organization read ${orgRes.status} for ${externalId}`
    );
    return null;
  }
  const org = (await orgRes.json()) as { name?: string | null };
  return typeof org?.name === "string" && org.name.trim() ? org.name.trim() : null;
}

export async function fetchOrgIdentity(orgId: string): Promise<OrgIdentity | null> {
  const url = process.env.CLIENT_SERVICE_URL;
  const apiKey = process.env.CLIENT_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.warn(
      "[billing-service] CLIENT_SERVICE not configured — the budget-change email cannot name the org"
    );
    return null;
  }
  try {
    const res = await fetchWithRetry(`${url}/internal/orgs/${orgId}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `[billing-service] client-service org read ${res.status} for org=${orgId}`
      );
      return null;
    }
    const body = (await res.json()) as {
      name?: string | null;
      externalId?: string | null;
    };
    const externalId =
      typeof body?.externalId === "string" && body.externalId ? body.externalId : null;
    let name =
      typeof body?.name === "string" && body.name.trim() ? body.name.trim() : null;
    // client-service stores no name for most orgs; Clerk is where it lives.
    if (!name && externalId) {
      try {
        name = await clerkOrgName(externalId);
      } catch (err) {
        console.error(
          `[billing-service] Clerk org name read failed for ${externalId}:`,
          err
        );
      }
    }
    return { name, externalId };
  } catch (err) {
    console.error(
      `[billing-service] client-service org read failed for org=${orgId}:`,
      err
    );
    return null;
  }
}
