/**
 * ONE leg identity, two spellings, during the fleet-wide outbound leg-key rename.
 *
 * Owner rule 2026-10-09: "lead found" is a normal funnel step. Sourcing campaigns
 * run start -> lead found, and OUTBOUND campaigns (cold email, cold call, cold
 * LinkedIn, ...) start at lead found. So, for the outbound channels below and
 * ONLY those, two leg keys are renamed (LOCKED, shared by six codebases):
 *
 *     start_to_conversation   ->  lead_found_to_conversation
 *     start_to_website_visit  ->  lead_found_to_website_visit
 *
 * The same two legacy keys on any NON-outbound channel (ads, SEO, organic,
 * PR...) are NOT renamed and stay distinct identities. Sourcing keeps
 * start_to_lead_found. Every other leg key is unchanged.
 *
 * WAVE 1: the two spellings of an outbound leg are the SAME identity wherever
 * billing receives, matches, dedups or enforces uniqueness on a leg key.
 * WAVE 2 (migration 0077): every stored row carries the new spelling and every
 * write stores it (`canonicalLegKey`), so reads serve it; the legacy spelling
 * is still accepted on input.
 *
 * Every comparison of two leg keys goes through `sameLeg` / `legIdentityKey`:
 * a bare `a.legKey === b.legKey` is the bug this module exists to remove. The
 * identity is the leg READ IN ITS CHANNEL, so a comparison always carries the
 * channel (feature slug) the leg belongs to.
 *
 * The outbound list is the LOCKED table of the rename brief. features-service
 * is shipping a `channelType` on its channel catalogue in parallel; once it is
 * served, this list can be read from it instead.
 */

/** Feature slugs whose channelType is OUTBOUND (LOCKED, 2026-10-09). */
export const OUTBOUND_FEATURE_SLUGS: ReadonlySet<string> = new Set([
  "sales-cold-email-outreach",
  "feedback-request-cold-email-outreach",
  "sales-crm-email-outreach",
  "cold-call-outreach",
  "cold-instagram-outreach",
  "cold-linkedin-outreach",
  "cold-reddit-outreach",
  "cold-sms-outreach",
  "cold-whatsapp-outreach",
  "cold-x-outreach",
]);

/** Legacy outbound leg key -> its new spelling (LOCKED, 2026-10-09). */
const OUTBOUND_LEG_RENAMES: Readonly<Record<string, string>> = {
  start_to_conversation: "lead_found_to_conversation",
  start_to_website_visit: "lead_found_to_website_visit",
};

const NEW_TO_LEGACY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(OUTBOUND_LEG_RENAMES).map(([legacy, renamed]) => [renamed, legacy])
);

export function isOutboundChannel(featureSlug: string | null | undefined): boolean {
  return typeof featureSlug === "string" && OUTBOUND_FEATURE_SLUGS.has(featureSlug);
}

/**
 * The leg's identity in its channel: the NEW spelling for a legacy outbound
 * key, the key itself otherwise. Used for comparison AND, since wave 2, as the
 * spelling every write stores.
 */
export function canonicalLegKey(featureSlug: string | null | undefined, legKey: string): string;
export function canonicalLegKey(featureSlug: string | null | undefined, legKey: string | null): string | null;
export function canonicalLegKey(
  featureSlug: string | null | undefined,
  legKey: string | null
): string | null {
  if (legKey === null) return null;
  if (!isOutboundChannel(featureSlug)) return legKey;
  return OUTBOUND_LEG_RENAMES[legKey] ?? legKey;
}

/** Both spellings of one leg on one channel (one entry when it was never renamed). */
export function legKeySpellings(featureSlug: string | null | undefined, legKey: string): string[] {
  if (!isOutboundChannel(featureSlug)) return [legKey];
  const renamed = OUTBOUND_LEG_RENAMES[legKey];
  if (renamed) return [legKey, renamed];
  const legacy = NEW_TO_LEGACY[legKey];
  if (legacy) return [legacy, legKey];
  return [legKey];
}

/** Are these the same leg of the same channel? Nulls are values (a leg-less row). */
export function sameLeg(
  featureSlug: string | null | undefined,
  a: string | null,
  b: string | null
): boolean {
  if (a === null || b === null) return a === b;
  return canonicalLegKey(featureSlug, a) === canonicalLegKey(featureSlug, b);
}

/** A (channel, leg) identity key for maps and sets. Case is the caller's concern. */
export function legIdentityKey(featureSlug: string, legKey: string): string {
  return `${featureSlug}\u0000${canonicalLegKey(featureSlug, legKey)}`;
}
