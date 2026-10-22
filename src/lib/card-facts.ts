import {
  getOrgCardCountryByOrg,
  getSavedPaymentMethod,
  isAutoReloadBlockedCountry,
  type SavedPaymentMethodAnswer,
} from "./stripe-service-client.js";

/**
 * What the dashboard needs at card entry, for both acquirers: is the saved card
 * PREPAID, which COUNTRY issued it, and may this org therefore be POSTPAID?
 *
 * Owner 2026-10-13: a postpaid org whose card is prepaid or Indian must be moved to
 * prepaid (the dashboard asks: switch to prepaid, or change card; no "continue
 * anyway"). India is the case that matters: RBI e-mandate rules break off-session
 * charges, and a postpaid org is charged off-session by construction. A prepaid
 * card cannot carry a credit line either: it holds only what was loaded on it.
 *
 * Facts come from stripe-service (it owns the acquirers): `method.prepaid` on the
 * saved-method read, the country from `method.country` when stripe-service states
 * it, else the issuing country of the org's card on whichever acquirer holds it.
 * `null` = the acquirer did not say; unknown is NEVER "not prepaid" / "fine", it is
 * served as unknown and does not, on its own, refuse postpaid (a wrong refusal loses
 * a signup; the off-session charge itself still fails loud if it cannot go through).
 */

export type PostpaidCardRefusal = "prepaid_card" | "card_issuing_country_unsupported" | "card_hold_refused";

export interface CardFacts {
  /** A chargeable card is saved (stripe-service's verdict). */
  saved: boolean;
  acquirer: string | null;
  /** true / false as the acquirer states it; null = not stated (or no card). */
  prepaid: boolean | null;
  /** ISO-3166-1 alpha-2 issuing country; null = not stated (or no card). */
  country: string | null;
  /** May this org be postpaid with this card? true when no card is saved yet. */
  postpaidAllowed: boolean;
  postpaidRefusedReason: PostpaidCardRefusal | null;
}

/** Decide from a saved-method answer already read (no second stripe-service call for it). */
export async function cardFactsFrom(
  orgId: string,
  answer: SavedPaymentMethodAnswer
): Promise<CardFacts> {
  if (!answer.saved || !answer.method) {
    return {
      saved: false,
      acquirer: answer.acquirer ?? null,
      prepaid: null,
      country: null,
      postpaidAllowed: true,
      postpaidRefusedReason: null,
    };
  }
  const method = answer.method as SavedPaymentMethodAnswer["method"] & { country?: string | null };
  const prepaid = method?.prepaid ?? null;
  const stated = typeof method?.country === "string" && method.country !== "" ? method.country.toUpperCase() : null;
  const country = stated ?? (await getOrgCardCountryByOrg(orgId))?.toUpperCase() ?? null;
  const postpaidRefusedReason: PostpaidCardRefusal | null =
    prepaid === true
      ? "prepaid_card"
      : isAutoReloadBlockedCountry(country)
        ? "card_issuing_country_unsupported"
        : null;
  return {
    saved: true,
    acquirer: answer.acquirer ?? null,
    prepaid,
    country,
    postpaidAllowed: postpaidRefusedReason === null,
    postpaidRefusedReason,
  };
}

export async function getCardFacts(orgId: string): Promise<CardFacts> {
  return cardFactsFrom(orgId, await getSavedPaymentMethod(orgId));
}

/** The wire fields, snake_case, beside the saved-method answer. */
export function cardFactsWire(f: CardFacts) {
  return {
    card_prepaid: f.prepaid,
    card_country: f.country,
    postpaid_allowed: f.postpaidAllowed,
    postpaid_refused_reason: f.postpaidRefusedReason,
  };
}
