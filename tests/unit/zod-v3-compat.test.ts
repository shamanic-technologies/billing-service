import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ZOD3_EMAIL, zod3Uuid } from "../../src/lib/zod-v3-compat.js";

// Routes return `issues[0].message` in their 400 body: these are the zod 3
// strings callers read before the zod 4 upgrade (DEPS-SEC-1025).
function firstMessage(schema: z.ZodTypeAny, input: unknown): string {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("expected a failure");
  return parsed.error.issues[0].message;
}

describe("zod 3 default messages under zod 4", () => {
  it("keeps the zod 3 wording for every common issue", () => {
    expect(firstMessage(z.object({ a: z.string() }), {})).toBe("Required");
    expect(firstMessage(z.string(), null)).toBe("Expected string, received null");
    expect(firstMessage(z.number(), "1")).toBe("Expected number, received string");
    expect(firstMessage(z.number().int(), 1.5)).toBe("Expected integer, received float");
    expect(firstMessage(z.enum(["a", "b"]), "c")).toBe("Invalid enum value. Expected 'a' | 'b', received 'c'");
    expect(firstMessage(z.literal(true), false)).toBe("Invalid literal value, expected true");
    expect(firstMessage(z.object({}).strict(), { x: 1 })).toBe("Unrecognized key(s) in object: 'x'");
    expect(firstMessage(z.number().min(1), 0)).toBe("Number must be greater than or equal to 1");
    expect(firstMessage(z.number().positive(), 0)).toBe("Number must be greater than 0");
    expect(firstMessage(z.number().max(10), 11)).toBe("Number must be less than or equal to 10");
    expect(firstMessage(z.string().min(1), "")).toBe("String must contain at least 1 character(s)");
    expect(firstMessage(z.array(z.string()).max(1), ["a", "b"])).toBe("Array must contain at most 1 element(s)");
    expect(firstMessage(z.string().url(), "nope")).toBe("Invalid url");
    expect(firstMessage(z.string().datetime({ offset: true }), "nope")).toBe("Invalid datetime");
    expect(firstMessage(zod3Uuid(), "nope")).toBe("Invalid uuid");
    expect(firstMessage(z.string().email({ pattern: ZOD3_EMAIL }), "nope")).toBe("Invalid email");
    expect(firstMessage(z.union([z.string(), z.number()]), true)).toBe("Invalid input");
    expect(firstMessage(z.string().refine(() => false), "x")).toBe("Invalid input");
  });

  it("lets a message set on the schema win", () => {
    expect(firstMessage(z.string().min(1, "name is required"), "")).toBe("name is required");
  });
});

describe("zod 3 patterns under zod 4", () => {
  it("accepts the non-RFC ids zod 3 accepted", () => {
    expect(zod3Uuid().safeParse("00000000-0000-0000-0000-000000000001").success).toBe(true);
    expect(zod3Uuid().safeParse("6F9619FF-8B86-D011-B42D-00CF4FC964FF").success).toBe(true);
    expect(zod3Uuid().safeParse("6f9619ff-8b86-d011-b42d-00cf4fc964f").success).toBe(false);
  });

  it("validates emails with the zod 3 regex", () => {
    const email = z.string().email({ pattern: ZOD3_EMAIL });
    expect(email.safeParse("k.lourd+tag@distribute.you").success).toBe(true);
    expect(email.safeParse("a..b@x.io").success).toBe(false);
  });
});
