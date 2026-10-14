/**
 * Should an owner Telegram alert stay silent because WE are behind it?
 * (fleet rule: staff alerts never report the owner's own actions, and a TEST
 * never reaches the owner as if it were a client).
 *
 * Decided on WHO acted and WHOSE org it is, never on which route was called:
 *  - `staff_actor`: the acting person is staff, by `x-email`, or (when the caller
 *    sent no email) by `x-user-id` resolved to that user's email in client-service.
 *  - `staff_test_org`: every person whose org it is (client-service users, at least
 *    one) is staff, e.g. "STAFF TEST - Email Sending E2E" owned by
 *    kevin.lourd+e2eclient1014@gmail.com. An org with no user (an anonymous
 *    visitor's onboarding) is NOT ours: it alerts.
 *
 * Prod 2026-10-14: a staff E2E switched a staff test org to prepaid through the
 * CUSTOMER route with no `x-email`; the old route-only silence alerted the owner.
 *
 * client-service unreadable = alert anyway (logged loudly): a spurious alert costs
 * a glance, a missed one hides a real client.
 */
import { PLATFORM_USER_ID } from "../db/schema.js";
import { fetchOrgUsers, RFC_UUID } from "./client-service-client.js";
import { isStaffEmail } from "./payment-alerts.js";

export type StaffSkipReason = "staff_actor" | "staff_test_org";

export async function staffAlertSkipReason(input: {
  orgId: string;
  actorEmail?: string | null;
  actorUserId?: string | null;
}): Promise<StaffSkipReason | null> {
  if (isStaffEmail(input.actorEmail)) return "staff_actor";
  if (!RFC_UUID.test(input.orgId)) return null;
  let users: Array<{ id: string; email: string | null }>;
  try {
    users = await fetchOrgUsers(input.orgId);
  } catch (err) {
    console.error(`[billing-service] owner alert: org ${input.orgId} users unreadable, alerting anyway:`, err);
    return null;
  }
  const actorId = input.actorUserId && input.actorUserId !== PLATFORM_USER_ID ? input.actorUserId : null;
  if (actorId && users.some((u) => u.id === actorId && isStaffEmail(u.email))) return "staff_actor";
  if (users.length > 0 && users.every((u) => isStaffEmail(u.email))) return "staff_test_org";
  return null;
}
