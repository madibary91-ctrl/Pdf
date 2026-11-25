import { describe, expect, it } from "vitest";
import { checkTimingRelations } from "./index";
import { prng } from "./test-kit";

const GRACE = 10_000;
const ok = (maxCallMs: unknown, graceMs: unknown, reservationTtlMs: unknown) => checkTimingRelations({ maxCallMs, graceMs, reservationTtlMs });

describe("tool-call-deadline · رابطه‌های ساختاریِ زمان", () => {
  it("مجموعهٔ سازگار ⇒ بی‌مشکل", () => {
    expect(ok(GRACE - 1, GRACE, 2 * GRACE)).toEqual([]);
    expect(ok(1, 2, 4)).toEqual([]);
  });

  it("maxCallMs ≥ graceMs رد می‌شود؛ یکی کمتر مجاز است (مرزِ دقیق)", () => {
    expect(ok(GRACE, GRACE, 2 * GRACE)).toEqual(["maxCallMs باید کمتر از graceMs باشد."]);
    expect(ok(GRACE + 1, GRACE, 2 * GRACE)).toEqual(["maxCallMs باید کمتر از graceMs باشد."]);
    expect(ok(GRACE - 1, GRACE, 2 * GRACE)).toEqual([]);
  });

  it("ttl < ۲×graceMs رد می‌شود؛ برابرِ ۲×graceMs مجاز است (مرزِ دقیق)", () => {
    expect(ok(1000, GRACE, 2 * GRACE - 1)).toEqual(["reservationTtlMs باید دست‌کم دو برابر graceMs باشد."]);
    expect(ok(1000, GRACE, 2 * GRACE)).toEqual([]);
  });

  it("هر دو رابطه با هم نقض شوند ⇒ هر دو گزارش، بی‌تکرار و به ترتیبِ ثابت", () => {
    expect(ok(GRACE, GRACE, 1)).toEqual(["maxCallMs باید کمتر از graceMs باشد.", "reservationTtlMs باید دست‌کم دو برابر graceMs باشد."]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "5", null, undefined, {}, [], true])("مقدارِ نامعتبر %s برای هر سه فیلد ⇒ پیامِ «عدد صحیحِ مثبت»", (bad) => {
    expect(ok(bad, GRACE, 2 * GRACE)).toEqual(["maxCallMs باید عدد صحیحِ مثبت باشد."]);
    expect(ok(1000, bad, 2 * GRACE)).toEqual(["graceMs باید عدد صحیحِ مثبت باشد."]);
    expect(ok(1000, GRACE, bad)).toEqual(["reservationTtlMs باید عدد صحیحِ مثبت باشد."]);
  });

  it("با graceMs نامعتبر، رابطه‌های وابسته به آن گزارش نمی‌شوند (پیامِ گمراه‌کننده نیست)", () => {
    expect(ok(1000, "x", 5)).toEqual(["graceMs باید عدد صحیحِ مثبت باشد."]);
  });

  it("getterِ پرتاب‌کننده/Proxy ⇒ یک پیامِ ثابت و بی‌نشتِ متنِ استثنا؛ نمی‌پرتابد", () => {
    const trap = {};
    Object.defineProperty(trap, "maxCallMs", { get: () => { throw new Error("SECRET-KEY-123"); } });
    const r = checkTimingRelations(trap as never);
    expect(r).toEqual(["خواندن آستانه‌های زمانی ناموفق بود."]);
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("خروجی یخ‌زده است و هرگز مقدارِ ورودی را بازتاب نمی‌دهد", () => {
    const r = ok("sk-LIVE-SECRET-999", "sk-LIVE-SECRET-999", "sk-LIVE-SECRET-999");
    expect(Object.isFrozen(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("sk-LIVE");
  });

  it("ویژگی (۲۰۰۰ بذر): سازگار ⇔ (maxCallMs < graceMs ∧ ttl ≥ ۲×graceMs)، و سازگار ⇒ ttl > maxCallMs", () => {
    const rnd = prng(7);
    let compatible = 0;
    for (let i = 0; i < 2000; i++) {
      const g = 1 + Math.floor(rnd() * 50);
      const c = 1 + Math.floor(rnd() * 60);
      const t = 1 + Math.floor(rnd() * 120);
      const issues = ok(c, g, t);
      const expected = c < g && t >= 2 * g;
      expect(issues.length === 0, `c=${c} g=${g} t=${t}`).toBe(expected);
      if (expected) {
        compatible += 1;
        expect(t).toBeGreaterThan(c);
      }
    }
    expect(compatible).toBeGreaterThan(50); // ادعای پوشش: هر دو شاخه دیده شده‌اند
    expect(compatible).toBeLessThan(2000);
  });
});
