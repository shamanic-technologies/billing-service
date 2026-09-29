import { describe, it, expect } from "vitest";
import { statusMoveOf } from "../../src/lib/brand-budget-notification.js";

describe("statusMoveOf — only a real running <-> paused move sends", () => {
  it("names the two moves", () => {
    expect(statusMoveOf("ongoing", "stopped")).toBe("paused");
    expect(statusMoveOf("stopped", "ongoing")).toBe("restarted");
  });
  it("a no-op or an unknown status sends nothing", () => {
    expect(statusMoveOf("ongoing", "ongoing")).toBeNull();
    expect(statusMoveOf("stopped", "stopped")).toBeNull();
    expect(statusMoveOf("ongoing", "completed")).toBeNull();
  });
});
