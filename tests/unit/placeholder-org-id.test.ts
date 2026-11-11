import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { isRealOrgId } from "../../src/lib/org-id.js";
import { requireOrgHeaders } from "../../src/middleware/auth.js";

// MON-FLEET-REVENUE-NIL-ORG-1111: a placeholder org id must never open a billing
// account (two did, and every fleet sweep then asked runs-service about them).

const REAL = "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const USER = "3c0b7d2e-1f4a-4b6c-9d8e-2a1b3c4d5e6f";
const RUN = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";

function call(orgId: string) {
  const req = { method: "GET", path: "/v1/accounts", headers: { "x-org-id": orgId, "x-user-id": USER, "x-run-id": RUN } } as unknown as Request;
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })) } as unknown as Response;
  const next = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  requireOrgHeaders(req, res, next);
  return { next, status: (res.status as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] };
}

describe("placeholder org ids", () => {
  it("isRealOrgId: an RFC 9562 id is real, the nil UUID and the sentinel family are not", () => {
    expect(isRealOrgId(REAL)).toBe(true);
    expect(isRealOrgId(REAL.toUpperCase())).toBe(true);
    expect(isRealOrgId("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(isRealOrgId("00000000-0000-0000-0000-000000000001")).toBe(false);
    expect(isRealOrgId("11111111-1111-1111-1111-111111111111")).toBe(false);
    expect(isRealOrgId(undefined)).toBe(false);
    expect(isRealOrgId("")).toBe(false);
  });

  it("requireOrgHeaders refuses a placeholder x-org-id with 400 and never reaches the route", () => {
    for (const orgId of ["00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000001"]) {
      const r = call(orgId);
      expect(r.next).not.toHaveBeenCalled();
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "x-org-id must be a real org id, never a placeholder" });
    }
  });

  it("requireOrgHeaders lets a real org through", () => {
    const r = call(REAL);
    expect(r.next).toHaveBeenCalledOnce();
    expect(r.status).toBeUndefined();
  });
});
