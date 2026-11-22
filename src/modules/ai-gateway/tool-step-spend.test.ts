import { describe, expect, it } from "vitest";
import { sumStepSpend } from "./index";

const U = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });
const C = (micros: number, currency = "IRR", priceVersion = "v1") => ({ micros, currency, priceVersion });

describe("sumStepSpend", () => {
  it("تهی: صفر و کامل", () => {
    const s = sumStepSpend([]);
    expect(s).toEqual({ steps: 0, usage: U(0, 0), unknownUsageSteps: 0, cost: [], unknownCostSteps: 0, complete: true });
  });
  it("جمعِ مصرف و هزینه (یک ارز، یک نسخه)", () => {
    const s = sumStepSpend([
      { usage: U(1000, 500), cost: C(10_500) },
      { usage: U(2000, 100), cost: C(7_500) },
    ]);
    expect(s.steps).toBe(2);
    expect(s.usage).toEqual(U(3000, 600));
    expect(s.cost).toEqual([C(18_000)]);
    expect(s.complete).toBe(true);
  });
  it("مصرفِ نامعلوم صفر حساب نمی‌شود و complete=false", () => {
    const s = sumStepSpend([{ usage: U(10, 5), cost: C(1) }, { usage: null, cost: null }]);
    expect(s.usage).toEqual(U(10, 5));
    expect(s.unknownUsageSteps).toBe(1);
    expect(s.unknownCostSteps).toBe(1);
    expect(s.complete).toBe(false);
  });
  it("مصرفِ معلوم ولی هزینهٔ نامعلوم (مدلِ بی‌قیمت) جدا شمرده می‌شود", () => {
    const s = sumStepSpend([{ usage: U(10, 5), cost: null }]);
    expect(s.unknownUsageSteps).toBe(0);
    expect(s.unknownCostSteps).toBe(1);
    expect(s.complete).toBe(false);
  });
  it("ارزها و نسخه‌های قیمتِ متفاوت هرگز ادغام نمی‌شوند؛ ترتیبِ خروجی قطعی", () => {
    const entries = [
      { usage: U(1, 1), cost: C(5, "USD", "v2") },
      { usage: U(1, 1), cost: C(3, "IRR", "v2") },
      { usage: U(1, 1), cost: C(4, "IRR", "v1") },
      { usage: U(1, 1), cost: C(6, "IRR", "v2") },
    ];
    const a = sumStepSpend(entries);
    expect(a.cost).toEqual([C(4, "IRR", "v1"), C(9, "IRR", "v2"), C(5, "USD", "v2")]);
    expect(sumStepSpend([...entries].reverse()).cost).toEqual(a.cost);
  });
  it("سرریزِ micros ⇒ null (نه گرد‌شده) و complete=false؛ سایرِ سطل‌ها سالم", () => {
    const s = sumStepSpend([{ usage: U(1, 1), cost: C(Number.MAX_SAFE_INTEGER) }, { usage: U(1, 1), cost: C(1) }, { usage: U(1, 1), cost: C(2, "USD") }]);
    expect(s.cost).toEqual([C(2, "USD") , { currency: "IRR", priceVersion: "v1", micros: null }].sort((a, b) => (a.currency < b.currency ? -1 : 1)));
    expect(s.complete).toBe(false);
  });
  it("سرریزِ نامعلوم‌نشدنی: null ماندگار است (بعد از null دوباره عدد نمی‌شود)", () => {
    const s = sumStepSpend([{ usage: null, cost: C(Number.MAX_SAFE_INTEGER) }, { usage: null, cost: C(1) }, { usage: null, cost: C(0) }]);
    expect(s.cost[0]?.micros).toBeNull();
  });
  it("مدخل‌های خراب نامعلوم‌اند: null، عدد، اعشار، منفی، رشته، ارز نامعتبر", () => {
    const bad: unknown[] = [null, 5, "x", [], { usage: { inputTokens: 1.5, outputTokens: 1 }, cost: C(1.5) }, { usage: U(-1, 0), cost: C(-1) }, { usage: { inputTokens: "1", outputTokens: 1 }, cost: { micros: 1, currency: 5, priceVersion: "v" } }, { usage: U(2_000_000_000, 0), cost: { micros: 1, currency: "IRR" } }];
    const s = sumStepSpend(bad);
    expect(s.steps).toBe(bad.length);
    expect(s.unknownUsageSteps).toBe(bad.length);
    expect(s.unknownCostSteps).toBe(bad.length);
    expect(s.usage).toEqual(U(0, 0));
    expect(s.cost).toEqual([]);
    expect(s.complete).toBe(false);
  });
  it("ورودیِ غیرآرایه ⇒ صفر گام (بی‌پرتاب)", () => {
    for (const v of [undefined, null, 5, "x", {}]) expect(sumStepSpend(v).steps).toBe(0);
  });
  it("getterِ پرتابگر روی مدخل ⇒ نامعلوم، نه پرتاب", () => {
    const evil = { get usage(): never { throw new Error("boom"); }, cost: null };
    const s = sumStepSpend([evil, { usage: U(1, 1), cost: C(1) }]);
    expect(s.unknownUsageSteps).toBe(1);
    expect(s.usage).toEqual(U(1, 1));
  });
  it("خروجی یخ‌زده و مستقل از ورودی است", () => {
    const entries = [{ usage: U(1, 1), cost: C(1) }];
    const s = sumStepSpend(entries);
    expect(Object.isFrozen(s) && Object.isFrozen(s.usage) && Object.isFrozen(s.cost) && Object.isFrozen(s.cost[0])).toBe(true);
    entries[0]!.cost.micros = 999;
    expect(s.cost[0]?.micros).toBe(1);
  });
  it("جمعِ مصرفِ دارای کلیدِ اضافه فقط دو فیلدِ معتبر را می‌شمارد", () => {
    const s = sumStepSpend([{ usage: { inputTokens: 4, outputTokens: 6, totalTokens: 999 }, cost: C(1) }]);
    expect(s.usage).toEqual(U(4, 6));
  });
  it("ویژگیِ تصادفیِ قطعی: برابرِ جمعِ مرجع، مستقل از ترتیب", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const entries = Array.from({ length: rnd(12) }, () => ({
        usage: rnd(4) === 0 ? null : U(rnd(5000), rnd(5000)),
        cost: rnd(4) === 0 ? null : C(rnd(1_000_000), rnd(2) === 0 ? "IRR" : "USD", rnd(2) === 0 ? "v1" : "v2"),
      }));
      const s = sumStepSpend(entries);
      const known = entries.filter((e) => e.usage !== null);
      expect(s.usage.inputTokens).toBe(known.reduce((a, e) => a + e.usage!.inputTokens, 0));
      expect(s.usage.outputTokens).toBe(known.reduce((a, e) => a + e.usage!.outputTokens, 0));
      expect(s.unknownUsageSteps).toBe(entries.length - known.length);
      expect(s.unknownCostSteps).toBe(entries.filter((e) => e.cost === null).length);
      expect(s.cost.reduce((a, c) => a + (c.micros ?? 0), 0)).toBe(entries.reduce((a, e) => a + (e.cost?.micros ?? 0), 0));
      const shuffled = [...entries].sort(() => rnd(3) - 1);
      expect(sumStepSpend(shuffled)).toEqual(s);
    }
  });
});
