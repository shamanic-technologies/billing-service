import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { pgDriverError, pgErrorCode } from "../../src/lib/pg-error.js";

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
