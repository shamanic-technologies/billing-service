/**
 * zod 3 -> 4 compatibility (DEPS-SEC-1025), so the upgrade changes no runtime
 * behaviour a caller can observe.
 *
 * 1. Patterns: zod 4's uuid check enforces RFC 9562 version/variant bits and
 *    its email regex differs from zod 3's. `ZOD3_UUID` / `ZOD3_EMAIL` are the
 *    zod 3 regexes, passed as `pattern` so ids such as
 *    `00000000-0000-0000-0000-000000000001` keep validating (and the served
 *    openapi keeps `format: uuid`).
 *
 * 2. Messages: zod 4 changed every DEFAULT validation message ("Required" became
 * "Invalid input: expected string, received undefined", ...). Routes here
 * return `issues[0].message` verbatim in their 400 body, so callers read
 * those strings. This global error map restores the zod 3 default wording,
 * keeping every 400 body byte-identical across the zod 3 -> 4 upgrade
 * (DEPS-SEC-1025). A message set on the schema itself still wins.
 *
 * Imported for its side effect by `src/schemas.ts`, which every route and
 * the openapi generator load before parsing anything.
 */
import { z } from "zod";

export const ZOD3_UUID = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
/** zod 3's `z.string().uuid()`: zod 4's own `format: "uuid"` (kept in openapi) over zod 3's regex. The param type omits `pattern`, the runtime honours it. */
export const zod3Uuid = () => z.string().uuid({ pattern: ZOD3_UUID } as Parameters<z.ZodString["uuid"]>[0]);
export const ZOD3_EMAIL = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;

function parsedType(data: unknown): string {
  switch (typeof data) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (Array.isArray(data)) return "array";
      if (data === null) return "null";
      if (data instanceof Date) return "date";
      if (data instanceof Map) return "map";
      if (data instanceof Set) return "set";
      if (typeof (data as { then?: unknown }).then === "function") return "promise";
      return "object";
    default:
      return "unknown";
  }
}

function joinValues(values: readonly unknown[]): string {
  return values.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(" | ");
}

// zod 3 named the uuid check "uuid"; report a bare `guid` under that name too.
const FORMAT_NAMES: Record<string, string> = { guid: "uuid" };

type RawIssue = {
  code: string;
  input?: unknown;
  expected?: string;
  values?: readonly unknown[];
  keys?: readonly string[];
  format?: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  exact?: boolean;
  divisor?: number;
};

export function zod3Message(issue: RawIssue): string | undefined {
  switch (issue.code) {
    case "invalid_type": {
      if (issue.expected === "int") return `Expected integer, received float`;
      const received = parsedType(issue.input);
      if (received === "undefined") return "Required";
      return `Expected ${issue.expected}, received ${received}`;
    }
    case "invalid_value": {
      const values = issue.values ?? [];
      if (values.length === 1) return `Invalid literal value, expected ${JSON.stringify(values[0])}`;
      return `Invalid enum value. Expected ${joinValues(values)}, received '${String(issue.input)}'`;
    }
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${(issue.keys ?? []).map((k) => `'${k}'`).join(", ")}`;
    case "invalid_union":
    case "custom":
      return "Invalid input";
    case "invalid_format": {
      if (issue.format === "regex") return "Invalid";
      const name = FORMAT_NAMES[issue.format ?? ""] ?? issue.format;
      return `Invalid ${name}`;
    }
    case "too_small": {
      const { origin, exact, inclusive, minimum } = issue;
      if (origin === "array" || origin === "set")
        return `Array must contain ${exact ? "exactly" : inclusive ? "at least" : "more than"} ${minimum} element(s)`;
      if (origin === "string")
        return `String must contain ${exact ? "exactly" : inclusive ? "at least" : "over"} ${minimum} character(s)`;
      if (origin === "number" || origin === "bigint")
        return `Number must be ${exact ? "exactly equal to " : inclusive ? "greater than or equal to " : "greater than "}${minimum}`;
      if (origin === "date")
        return `Date must be ${exact ? "exactly equal to " : inclusive ? "greater than or equal to " : "greater than "}${new Date(Number(minimum))}`;
      return "Invalid input";
    }
    case "too_big": {
      const { origin, exact, inclusive, maximum } = issue;
      if (origin === "array" || origin === "set")
        return `Array must contain ${exact ? "exactly" : inclusive ? "at most" : "less than"} ${maximum} element(s)`;
      if (origin === "string")
        return `String must contain ${exact ? "exactly" : inclusive ? "at most" : "under"} ${maximum} character(s)`;
      if (origin === "number" || origin === "bigint")
        return `Number must be ${exact ? "exactly" : inclusive ? "less than or equal to" : "less than"} ${maximum}`;
      if (origin === "date")
        return `Date must be ${exact ? "exactly" : inclusive ? "smaller than or equal to" : "smaller than"} ${new Date(Number(maximum))}`;
      return "Invalid input";
    }
    case "not_multiple_of":
      return `Number must be a multiple of ${issue.divisor}`;
    default:
      return undefined;
  }
}

z.config({ customError: (issue) => zod3Message(issue as RawIssue) });
