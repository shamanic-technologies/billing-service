import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { errorReason, pgDriverError, pgErrorCode } from "../../src/lib/pg-error.js";

describe("pg-error", () => {
  const driverError = Object.assign(
    new Error('duplicate key value violates unique constraint "idx_x"'),
    { code: "23505" }
  );

  it("reads the SQLSTATE under drizzle's DrizzleQueryError wrapper", () => {
    const wrapped = new DrizzleQueryError("insert into x values ($1)", [1], driverError);
    expect(wrapped.message).toMatch(/^Failed query:/);
    expect(pgErrorCode(wrapped)).toBe("23505");
    expect(pgDriverError(wrapped)).toBe(driverError);
  });

  it("reads the SQLSTATE of an unwrapped driver error", () => {
    expect(pgErrorCode(driverError)).toBe("23505");
    expect(pgDriverError(driverError)).toBe(driverError);
  });

  it("returns undefined for an error without a SQLSTATE", () => {
    expect(pgErrorCode(new Error("boom"))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode("x")).toBeUndefined();
  });
});

describe("errorReason", () => {
  it("returns the driver's reason, never the SQL text or params of a failed query", () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "idx_x"'), { code: "23505" });
    const wrapped = new DrizzleQueryError('insert into "t" values ($1)', ["secret@example.com"], cause);
    const reason = errorReason(wrapped);
    expect(reason).toBe('duplicate key value violates unique constraint "idx_x"');
    expect(reason).not.toContain("insert into");
    expect(reason).not.toContain("secret@example.com");
  });

  it("hides a failed query that carries no driver error", () => {
    const wrapped = new DrizzleQueryError("select 1", [], undefined as unknown as Error);
    expect(errorReason(wrapped)).toBe("database query failed");
  });

  it("keeps any other error's message as is", () => {
    expect(errorReason(new Error("upstream 502"))).toBe("upstream 502");
    expect(errorReason("plain")).toBe("plain");
  });
});
