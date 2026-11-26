import { describe, expect, it } from "vitest";
import { createMonotonicClock } from "./clock";

describe("tool-policy-runtime · ساعتِ یکنوا", () => {
  it("عددِ صحیحِ کفِ ms می‌دهد (قراردادِ منبع: عددِ صحیحِ ناپایین‌تر از صفر)", () => {
    const c = createMonotonicClock(() => 1234.999);
    expect(c.nowMs()).toBe(1234);
    expect(Number.isSafeInteger(createMonotonicClock(() => 0.4).nowMs())).toBe(true);
    expect(createMonotonicClock(() => 0.4).nowMs()).toBe(0);
  });

  it("هر بار منبعِ زمان را می‌خواند و ساعت یخ‌زده است", () => {
    let t = 10;
    const c = createMonotonicClock(() => t);
    expect(c.nowMs()).toBe(10);
    t = 55.5;
    expect(c.nowMs()).toBe(55);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("مقدارِ نامتناهی/NaN را بی‌صدا اصلاح نمی‌کند (منبع آن را CLOCK_INVALID می‌کند)", () => {
    expect(Number.isSafeInteger(createMonotonicClock(() => Number.NaN).nowMs())).toBe(false);
    expect(Number.isSafeInteger(createMonotonicClock(() => Number.POSITIVE_INFINITY).nowMs())).toBe(false);
  });

  it("پیش‌فرض (performance.now) یکنواست و عددِ صحیحِ ناپایین‌تر از صفر می‌دهد", () => {
    const c = createMonotonicClock();
    const a = c.nowMs();
    const b = c.nowMs();
    expect(Number.isSafeInteger(a) && a >= 0).toBe(true);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
