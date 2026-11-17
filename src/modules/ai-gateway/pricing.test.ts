import { describe, expect, it } from "vitest";
import { PRICE_LIMITS, computeCost, parsePrice, parseUsage } from "./index";

const price = (i: number, o: number) => ({ currency: "IRR", inputMicrosPerMTok: i, outputMicrosPerMTok: o, version: "t1" });
const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });

describe("ai-gateway · computeCost (عدد صحیح، گرد به بالا)", () => {
  it("مقدارهای دستی", () => {
    expect(computeCost(usage(1000, 500), price(3_000_000, 15_000_000)).micros).toBe(10_500);
    expect(computeCost(usage(1_000_000, 0), price(2_500_000, 0)).micros).toBe(2_500_000);
    expect(computeCost(usage(0, 1_000_000), price(0, 7)).micros).toBe(7);
    expect(computeCost(usage(0, 0), price(5, 5)).micros).toBe(0);
    expect(computeCost(usage(100, 100), price(0, 0)).micros).toBe(0);
  });

  it("گرد به بالا: حتی یک توکن و قیمت ۱ ⇒ ۱ (هرگز ۰ برای مصرف واقعی)", () => {
    expect(computeCost(usage(1, 0), price(1, 0)).micros).toBe(1);
    expect(computeCost(usage(1, 0), price(999_999, 0)).micros).toBe(1);
    expect(computeCost(usage(1, 0), price(1_000_000, 0)).micros).toBe(1);
    expect(computeCost(usage(1, 0), price(1_000_001, 0)).micros).toBe(2);
    expect(computeCost(usage(2, 0), price(500_000, 0)).micros).toBe(1);
    expect(computeCost(usage(2, 0), price(500_001, 0)).micros).toBe(2);
  });

  it("گردکردن روی جمع ورودی و خروجی است نه جداجدا (دو نیم‌واحد = یک واحد، نه دو)", () => {
    expect(computeCost(usage(1, 1), price(500_000, 500_000)).micros).toBe(1);
    expect(computeCost(usage(1, 1), price(500_000, 500_001)).micros).toBe(2);
  });

  it("سرریز ناممکن است: سقف ورودی‌ها ⇒ ۲×۱۰¹⁵ دقیق (کمتر از ۲⁵³)", () => {
    const max = PRICE_LIMITS.maxTokens;
    const p = PRICE_LIMITS.maxMicrosPerMTok;
    const c = computeCost(usage(max, max), price(p, p));
    expect(c.micros).toBe(2_000_000_000_000_000);
    expect(Number.isSafeInteger(c.micros)).toBe(true);
  });

  it("ارز و نسخهٔ قیمت در هزینه ثبت می‌شود", () => {
    expect(computeCost(usage(1, 1), { currency: "USD", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, version: "v9" })).toMatchObject({ currency: "USD", priceVersion: "v9" });
  });

  it("ویژگی: ⌈N/10⁶⌉ دقیق (کوچک‌ترین عدد صحیحِ ≥) روی ۳۰۰۰ ورودی تصادفی + مرزها، با BigInt مستقل", () => {
    let seed = 12345;
    const rnd = (hi: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 4294967296) * (hi + 1));
    };
    const pick = (hi: number) => [0, 1, hi, hi - 1, rnd(hi), rnd(hi), rnd(1000)][rnd(6)] as number;
    for (let n = 0; n < 3000; n++) {
      const i = pick(PRICE_LIMITS.maxTokens), o = pick(PRICE_LIMITS.maxTokens), pi = pick(PRICE_LIMITS.maxMicrosPerMTok), po = pick(PRICE_LIMITS.maxMicrosPerMTok);
      const m = BigInt(computeCost(usage(i, o), price(pi, po)).micros);
      const N = BigInt(i) * BigInt(pi) + BigInt(o) * BigInt(po);
      const M = BigInt("1000000");
      expect(m * M >= N, `کم‌برآورد ${i},${o},${pi},${po}`).toBe(true);
      expect(m === BigInt(0) || (m - BigInt(1)) * M < N, `بیش‌برآورد ${i},${o},${pi},${po}`).toBe(true);
    }
  });

  it("یکنوایی: افزودن توکن هرگز هزینه را کم نمی‌کند", () => {
    let prev = 0;
    for (let i = 0; i <= 3000; i += 7) {
      const c = computeCost(usage(i, Math.floor(i / 11)), price(1234, 5678)).micros;
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
});

describe("ai-gateway · parseUsage / parsePrice", () => {
  it("parseUsage: مجموع محاسبه می‌شود؛ مقدار خراب ⇒ null (نه ۰)", () => {
    expect(parseUsage({ inputTokens: 3, outputTokens: 4 })).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(parseUsage({ inputTokens: 3, outputTokens: 4, totalTokens: 999 })?.totalTokens).toBe(7);
    for (const v of [null, undefined, 5, "x", [], {}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1.2, outputTokens: 0 }, { inputTokens: "1", outputTokens: 0 }, { inputTokens: Number.NaN, outputTokens: 0 }, { inputTokens: 1_000_000_001, outputTokens: 0 }]) {
      expect(parseUsage(v), JSON.stringify(v)).toBeNull();
    }
  });

  it("parsePrice: نتیجهٔ معتبر منجمد؛ مشکل‌ها فقط نام فیلد", () => {
    const r = parsePrice(price(1, 2));
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
    const bad = parsePrice({ currency: "x", inputMicrosPerMTok: -1, outputMicrosPerMTok: 1.5, version: "", extra: "SECRET" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.length).toBe(5);
      expect(bad.issues.join()).not.toContain("SECRET");
    }
    expect(parsePrice(null).ok).toBe(false);
    expect(parsePrice([]).ok).toBe(false);
  });
});
