import { describe, expect, it } from "vitest";
import { createSystemClock } from "./clock";

describe("settlement-runtime · createSystemClock", () => {
  it("nowMs از تابعِ تزریقی می‌خواند و هر بار تازه است", () => {
    let t = 1_700_000_000_000;
    const c = createSystemClock(() => t);
    expect(c.nowMs()).toBe(1_700_000_000_000);
    t += 5;
    expect(c.nowMs()).toBe(1_700_000_000_005);
  });
  it("پیش‌فرض: ساعتِ سیستم (صحیحِ امن و نزدیک به Date.now)", () => {
    const before = Date.now();
    const n = createSystemClock().nowMs();
    const after = Date.now();
    expect(Number.isSafeInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThanOrEqual(after);
  });
  it("خطای ساعتِ تزریقی را نمی‌بلعد (مصرف‌کننده تصمیم می‌گیرد) و شیء منجمد است", () => {
    const c = createSystemClock(() => {
      throw new Error("x");
    });
    expect(() => c.nowMs()).toThrow("x");
    expect(Object.isFrozen(c)).toBe(true);
  });
});
