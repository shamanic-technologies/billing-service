import { describe, it, expect } from "vitest";
import { dunningEventType } from "../../src/lib/dunning.js";

// POSTPAID-DUNNING-1030: each stage routes by how the org pays.
describe("dunningEventType routing per payment mode", () => {
  const stages = [
    "credit-depleted",
    "credit-depleted-followup-3d",
    "credit-depleted-followup-10d",
  ] as const;

  for (const base of stages) {
    it(`${base}: prepaid → base`, () => {
      expect(dunningEventType(base, true, "prepaid")).toBe(base);
    });
    it(`${base}: no account → base`, () => {
      expect(dunningEventType(base, true, null)).toBe(base);
    });
    it(`${base}: postpaid → -postpaid`, () => {
      expect(dunningEventType(base, true, "postpaid")).toBe(`${base}-postpaid`);
    });
    it(`${base}: prepaid, card not chargeable off session → -blocked`, () => {
      expect(dunningEventType(base, false, "prepaid")).toBe(`${base}-blocked`);
    });
    it(`${base}: postpaid, card not chargeable off session → -blocked`, () => {
      expect(dunningEventType(base, false, "postpaid")).toBe(`${base}-blocked`);
    });
  }
});
