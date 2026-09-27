import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  billingAccounts,
  freeCreditPromises,
  PLATFORM_USER_ID,
  PROMISE_KIND_WELCOME,
  welcomeRecipients,
} from "../db/schema.js";

/**
 * The welcome gift is granted once per PERSON, not once per organisation.
 *
 * It used to be redeemed per org on the org's first billing touch, so one person
 * collected it once per organisation they created (prod 2026-09-27: 118 welcome rows
 * for 84 distinct user ids, one holding 10). `welcome_recipients` holds one row per
 * person — the org where that person's welcome lives — and its primary key on the
 * person is the whole guarantee: two orgs racing for the same person cannot both win.
 *
 * WHO is a person: the client-service internal user id carried as `x-user-id`, 1:1
 * with the identity-provider user. NOT the `user_id` on a promo row in general: the
 * trial seed writes the PLATFORM_USER_ID sentinel, and so did the anonymous-claim
 * settle until it learned the person. The sentinel is never a person.
 *
 * A second org the same person creates gets no welcome AND an account whose own
 * free-credit offer is zero (`withdrawFreeCreditOffer`), so no later path — the
 * welcome completion, the welcome promise, the checkout notice, the referral ladder —
 * can hand it the gift another way. Nothing already granted is ever clawed back.
 */

type Runner = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person behind a `x-user-id`, or null when it names nobody (absent, malformed, the platform sentinel). */
export function personIdOrNull(userId: string | null | undefined): string | null {
  if (!userId || !UUID_RE.test(userId)) return null;
  if (userId === PLATFORM_USER_ID) return null;
  return userId;
}

export type WelcomeClaim =
  /** This org holds the person's welcome (claimed now, or on an earlier call). */
  | { kind: "this_org" }
  /** The person's welcome already lives on another org — this one gets none. */
  | { kind: "other_org"; welcomeOrgId: string };

/**
 * Bind this person's welcome to this org, unless it already lives elsewhere.
 *
 * Idempotent: a replay for the org that already holds it answers `this_org`, so the
 * callers' own per-org idempotency (the `(org, welcome)` unique row) stays in charge
 * of "granted exactly once for this org".
 */
export async function claimWelcomeForPerson(
  runner: Runner,
  personId: string,
  orgId: string
): Promise<WelcomeClaim> {
  const inserted = await runner
    .insert(welcomeRecipients)
    .values({ userId: personId, orgId })
    .onConflictDoNothing({ target: welcomeRecipients.userId })
    .returning({ orgId: welcomeRecipients.orgId });
  if (inserted.length > 0) return { kind: "this_org" };

  const [existing] = await runner
    .select({ orgId: welcomeRecipients.orgId })
    .from(welcomeRecipients)
    .where(eq(welcomeRecipients.userId, personId))
    .limit(1);
  if (!existing) {
    throw new Error(
      `welcome_recipients conflict for ${personId} but no row readable — refusing to guess`
    );
  }
  return existing.orgId === orgId
    ? { kind: "this_org" }
    : { kind: "other_org", welcomeOrgId: existing.orgId };
}

/**
 * This org's own free-credit offer is ZERO: its person already received the welcome
 * on another org.
 *
 * The offer columns are otherwise frozen at creation; this runs at the moment the
 * org's person becomes known (its first billing touch, or signup for an org that
 * began anonymous), which is when its offer is decided. The welcome promise row is a
 * mirror of those columns, so an ungranted one is brought into line in the same act —
 * otherwise the dashboard would list $N "on its way" that can never land.
 */
export async function withdrawFreeCreditOffer(
  runner: Runner,
  orgId: string
): Promise<void> {
  await runner
    .update(billingAccounts)
    .set({
      freeCreditEntitlementCents: 0,
      freeCreditPaidTriggerCents: 0,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.orgId, orgId));
  await runner
    .update(freeCreditPromises)
    .set({ amountCents: 0, paidTriggerCents: 0 })
    .where(
      and(
        eq(freeCreditPromises.orgId, orgId),
        eq(freeCreditPromises.kind, PROMISE_KIND_WELCOME),
        isNull(freeCreditPromises.grantedAt)
      )
    );
}
