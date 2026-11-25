import { describe, expect, it } from "vitest";
import { checkPolicyRelations, POLICY_LIMITS } from "./index";

const G = 90_000;
const base = { maxCallMs: 36_000, graceMs: G, reservationTtlMs: 4 * G, modelTimeoutMs: 30_000, totalTimeoutMs: 180_000 };
const check = (over: Record<string, unknown>) => checkPolicyRelations({ ...base, ...over });

describe("tool-policy · رابطه‌های ساختاری", () => {
  it("مجموعهٔ سازگار ⇒ بی‌مشکل", () => {
    expect(check({})).toEqual([]);
  });

  it("سه رابطهٔ زمانیِ پول از checkTimingRelations می‌آید (کپیِ دوم نیست)", () => {
    expect(check({ maxCallMs: G })).toContain("maxCallMs باید کمتر از graceMs باشد.");
    expect(check({ reservationTtlMs: 2 * G - 1 })).toContain("reservationTtlMs باید دست‌کم دو برابر graceMs باشد.");
    expect(check({ reservationTtlMs: 2 * G })).toEqual([]);
    expect(check({ graceMs: "x" })).toContain("graceMs باید عدد صحیحِ مثبت باشد.");
  });

  it("کفِ graceMs: ۳۰٬۰۰۰ مجاز، ۲۹٬۹۹۹ رد (مرزِ دقیق)", () => {
    const at = (g: number) => check({ graceMs: g, maxCallMs: 1_000, reservationTtlMs: 4 * g, modelTimeoutMs: 500 });
    expect(at(POLICY_LIMITS.minGraceMs)).toEqual([]);
    expect(at(POLICY_LIMITS.minGraceMs - 1)).toEqual([`graceMs باید دست‌کم ${POLICY_LIMITS.minGraceMs} میلی‌ثانیه باشد.`]);
  });

  it("حاشیهٔ تسویه: maxCallMs ≤ graceMs/۲ مجاز؛ یک بیشتر رد؛ فقط وقتی maxCallMs < graceMs (بی‌تکرار با رابطهٔ پایه)", () => {
    const at = (m: number) => check({ maxCallMs: m, modelTimeoutMs: 1_000 });
    expect(at(G / 2)).toEqual([]);
    expect(at(G / 2 + 1)).toEqual(["graceMs باید دست‌کم دو برابر maxCallMs باشد (حاشیهٔ تسویه)."]);
    expect(at(G - 1)).toEqual(["graceMs باید دست‌کم دو برابر maxCallMs باشد (حاشیهٔ تسویه)."]);
    expect(at(G)).toEqual(["maxCallMs باید کمتر از graceMs باشد."]);
    expect(at(G + 5)).toEqual(["maxCallMs باید کمتر از graceMs باشد."]);
  });

  it("مهلتِ مدل: یکی کمتر از maxCallMs مجاز؛ برابر یا بیشتر رد (مرزِ دقیق)", () => {
    expect(check({ modelTimeoutMs: 35_999 })).toEqual([]);
    expect(check({ modelTimeoutMs: 36_000 })).toEqual(["model.timeoutMs باید کمتر از maxCallMs باشد."]);
    expect(check({ modelTimeoutMs: 99_999 })).toEqual(["model.timeoutMs باید کمتر از maxCallMs باشد."]);
  });

  it("مهلتِ کلِ اجرا: برابرِ maxCallMs مجاز؛ یکی کمتر رد (مرزِ دقیق)", () => {
    expect(check({ totalTimeoutMs: 36_000 })).toEqual([]);
    expect(check({ totalTimeoutMs: 35_999 })).toEqual(["totalTimeoutMs باید دست‌کم برابرِ maxCallMs باشد."]);
  });

  it("رابطه‌ای که ورودیِ نامعتبر دارد گزارش نمی‌شود (فیلد جدا گزارش می‌شود)؛ هرگز نمی‌پرتابد", () => {
    for (const bad of [undefined, null, "9", 1.5, -1, 0, Number.NaN, Infinity, BigInt(10), {}, []]) {
      expect(() => check({ modelTimeoutMs: bad, totalTimeoutMs: bad })).not.toThrow();
      const issues = check({ modelTimeoutMs: bad, totalTimeoutMs: bad });
      expect(issues.some((i) => i.startsWith("model.timeoutMs") || i.startsWith("totalTimeoutMs"))).toBe(false);
    }
  });

  it("ورودیِ خراب (getter/Proxy پرتاب‌کننده یا غیرشیء) ⇒ یک پیامِ ثابت، نه استثنا", () => {
    const evil = new Proxy({}, { get: () => { throw new Error("SECRET-CANARY"); } });
    const r = checkPolicyRelations(evil as never);
    expect(r).toEqual(["خواندن آستانه‌های سیاست ناموفق بود."]);
    expect(JSON.stringify(r)).not.toContain("SECRET-CANARY");
    expect(checkPolicyRelations(undefined as never)).toEqual(["خواندن آستانه‌های سیاست ناموفق بود."]);
  });

  it("چند نقض ⇒ همه گزارش، بی‌تکرار، به ترتیبِ ثابت؛ خروجی یخ‌زده", () => {
    const issues = check({ graceMs: 10, maxCallMs: 40, reservationTtlMs: 5, modelTimeoutMs: 50, totalTimeoutMs: 30 });
    expect(new Set(issues).size).toBe(issues.length);
    expect(issues).toEqual([
      "maxCallMs باید کمتر از graceMs باشد.",
      "reservationTtlMs باید دست‌کم دو برابر graceMs باشد.",
      `graceMs باید دست‌کم ${POLICY_LIMITS.minGraceMs} میلی‌ثانیه باشد.`,
      "model.timeoutMs باید کمتر از maxCallMs باشد.",
      "totalTimeoutMs باید دست‌کم برابرِ maxCallMs باشد.",
    ]);
    expect(Object.isFrozen(issues)).toBe(true);
    expect(check({})).toEqual(check({}));
  });

  it("عددهای نزدیکِ سقفِ ایمن: حاشیهٔ تسویه بی‌سرریزِ دقت سنجیده می‌شود", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const half = (big - 1) / 2; // صحیح و دقیق
    const r = checkPolicyRelations({ maxCallMs: half + 1, graceMs: big - 1, reservationTtlMs: 1, modelTimeoutMs: 1, totalTimeoutMs: big });
    expect(r).toContain("graceMs باید دست‌کم دو برابر maxCallMs باشد (حاشیهٔ تسویه).");
  });
});
