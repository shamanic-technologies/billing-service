import { DrizzleQueryError } from "drizzle-orm";

/**
 * The Postgres driver error behind a failed query.
 *
 * Since drizzle-orm 0.44 every query failure is wrapped in a
 * `DrizzleQueryError` whose message is `Failed query: <sql>` and whose
 * `cause` is the driver's `PostgresError` (the one carrying `code`,
 * `constraint_name` and the "duplicate key ..." message). Any check on a
 * SQLSTATE or a constraint name must read this, never the wrapper.
 */
export function pgDriverError(err: unknown): unknown {
  return err instanceof DrizzleQueryError && err.cause !== undefined ? err.cause : err;
}

/** SQLSTATE of a failed query (`"23505"` = unique violation), if any. */
export function pgErrorCode(err: unknown): string | undefined {
  const code = (pgDriverError(err) as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The human-readable reason of a caught error, safe to return in a response
 * or store in a column. A failed drizzle query's own message is
 * `Failed query: <sql> params: <values>` (SQL text and bound values: never
 * leak those); its reason is the driver error under `.cause`.
 */
export function errorReason(err: unknown): string {
  if (err instanceof DrizzleQueryError) {
    return err.cause instanceof Error ? err.cause.message : "database query failed";
  }
  return err instanceof Error ? err.message : String(err);
}
