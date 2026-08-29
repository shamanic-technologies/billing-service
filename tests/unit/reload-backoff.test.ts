import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  coalesceReload,
  reloadBlockedForMs,
  consecutiveReloadFailures,
  _resetCoalescer,
  type ReloadOutcome,
} from "../../src/lib/reload-coalescer.js";

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";

const succeeded: ReloadOutcome = { status: "succeeded", payment_intent_id: "pi_ok" };

/** A declined off_session charge reaches billing as a THROW (stripe-service 4xx). */
function declined(): Promise<ReloadOutcome> {
  return Promise.reject(new Error("card_declined: insufficient_funds"));
}

describe("reload backoff", () => {
  beforeEach(() => {
    _resetCoalescer();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetCoalescer();
  });

  it("refuses a second charge right after a declined one, without calling stripe", async () => {
    const charge = vi.fn(declined);

    await expect(coalesceReload(ORG, charge)).rejects.toThrow("card_declined");
    expect(charge).toHaveBeenCalledTimes(1);

    // This is the prod bug: before the backoff, the next authorize charged again.
    const second = await coalesceReload(ORG, charge);
    expect(second.status).toBe("failed");
    expect(second.backoffSkipped).toBe(true);
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("re-throws the original error on the attempt that actually failed", async () => {
    // Callers' existing try/catch must behave exactly as before on a real attempt.
    await expect(coalesceReload(ORG, declined)).rejects.toThrow(
      "card_declined: insufficient_funds"
    );
  });

  it("charges again once the cooldown elapses", async () => {
    const charge = vi.fn(declined);
    await expect(coalesceReload(ORG, charge)).rejects.toThrow();

    vi.advanceTimersByTime(5 * 60_000 - 1_000);
    expect((await coalesceReload(ORG, charge)).backoffSkipped).toBe(true);
    expect(charge).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await expect(coalesceReload(ORG, charge)).rejects.toThrow();
    expect(charge).toHaveBeenCalledTimes(2);
  });

  it("escalates the cooldown on consecutive failures and caps it at an hour", async () => {
    const charge = vi.fn(declined);
    const steps = [5, 15, 30, 60, 60];

    for (const minutes of steps) {
      await expect(coalesceReload(ORG, charge)).rejects.toThrow();
      const blockedMs = reloadBlockedForMs(ORG);
      expect(Math.round(blockedMs / 60_000)).toBe(minutes);
      vi.advanceTimersByTime(minutes * 60_000 + 1_000);
    }
  });

  it("clears the backoff entirely once a charge succeeds", async () => {
    await expect(coalesceReload(ORG, declined)).rejects.toThrow();
    expect(reloadBlockedForMs(ORG)).toBeGreaterThan(0);

    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    await coalesceReload(ORG, async () => succeeded);
    expect(reloadBlockedForMs(ORG)).toBe(0);

    // ...and the NEXT failure starts again at the first step, not the escalated one.
    await expect(coalesceReload(ORG, declined)).rejects.toThrow();
    expect(Math.round(reloadBlockedForMs(ORG) / 60_000)).toBe(5);
  });

  it("arms on a settled failed outcome too, not only on a throw", async () => {
    const charge = vi.fn(
      async (): Promise<ReloadOutcome> => ({ status: "failed", failure_reason: "invoice.status=open" })
    );
    expect((await coalesceReload(ORG, charge)).status).toBe("failed");
    expect((await coalesceReload(ORG, charge)).backoffSkipped).toBe(true);
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("keys the cooldown on the org, so a different org is unaffected", async () => {
    await expect(coalesceReload(ORG, declined)).rejects.toThrow();

    const otherCharge = vi.fn(async (): Promise<ReloadOutcome> => succeeded);
    expect((await coalesceReload(OTHER_ORG, otherCharge)).status).toBe("succeeded");
    expect(otherCharge).toHaveBeenCalledTimes(1);
  });

  it("keys the cooldown on the org alone, so a different amount cannot walk past it", async () => {
    // A declining card declines any amount; the sweep charges a different figure
    // than the tier reload, and must not get a free attempt because of it.
    await expect(coalesceReload(ORG, declined)).rejects.toThrow();
    const sweepCharge = vi.fn(declined);
    expect((await coalesceReload(ORG, sweepCharge)).backoffSkipped).toBe(true);
    expect(sweepCharge).not.toHaveBeenCalled();
  });

  it("still coalesces concurrent calls into one charge", async () => {
    let resolveCharge: (o: ReloadOutcome) => void = () => {};
    const charge = vi.fn(
      () => new Promise<ReloadOutcome>((resolve) => { resolveCharge = resolve; })
    );

    const a = coalesceReload(ORG, charge);
    const b = coalesceReload(ORG, charge);
    resolveCharge(succeeded);

    expect((await a).status).toBe("succeeded");
    expect((await b).status).toBe("succeeded");
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("marks a real outcome without the backoff flag, so callers still notify", async () => {
    const outcome = await coalesceReload(ORG, async () => succeeded);
    expect(outcome.backoffSkipped).toBeUndefined();
  });
});

/**
 * The failure-notification loop (prod 2026-08-29). Sending "your reload failed"
 * authorizes credit on the very org it is about, so an unguarded send re-enters
 * authorize, fails again, and sends again — 2,939 authorizations in 71 minutes,
 * 2,938 of them attributed to that email. Billing cannot fix the org-billing of
 * a platform notification (that belongs to the email path), but it can refuse to
 * be the thing that drives the loop.
 */
describe("reload failure streak", () => {
  beforeEach(() => {
    _resetCoalescer();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetCoalescer();
  });

  it("counts 0 for an org that has never failed", () => {
    expect(consecutiveReloadFailures(ORG)).toBe(0);
  });

  it("reaches 1 on the first failure, so that one notifies", async () => {
    await expect(coalesceReload(ORG, declined)).rejects.toThrow();
    expect(consecutiveReloadFailures(ORG)).toBe(1);
  });

  it("goes above 1 on the next real failure, so that one stays silent", async () => {
    await expect(coalesceReload(ORG, declined)).rejects.toThrow();
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    await expect(coalesceReload(ORG, declined)).rejects.toThrow();
    expect(consecutiveReloadFailures(ORG)).toBe(2);
  });

  it("resets to 0 on success, so a later failure notifies again", async () => {
    await expect(coalesceReload(ORG, declined)).rejects.toThrow();
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    await coalesceReload(ORG, async () => succeeded);
    expect(consecutiveReloadFailures(ORG)).toBe(0);

    await expect(coalesceReload(ORG, declined)).rejects.toThrow();
    expect(consecutiveReloadFailures(ORG)).toBe(1);
  });
});
