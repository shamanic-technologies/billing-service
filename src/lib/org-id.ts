/**
 * A REAL org id: an RFC 9562 UUID (version 1-8, variant 8-b), the only shape
 * client-service mints and runs-service / client-service accept. The nil UUID and
 * the sentinel family (`00000000-0000-0000-0000-000000000001`, …) are placeholders
 * a probe or a test once sent: billing must never open an account for one
 * (MON-FLEET-REVENUE-NIL-ORG-1111). Two such accounts, created by placeholder
 * probes in 2026-06/07, sat in every fleet sweep (fleet revenue, unpaid-debt scan)
 * and made each one ask runs-service for `org_id=00000000-…-0001` (400 Invalid UUID).
 */
export const REAL_ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRealOrgId(orgId: string | undefined | null): orgId is string {
  return typeof orgId === "string" && REAL_ORG_ID_RE.test(orgId);
}
