import { describe, expect, it } from "vitest";
import { computeCost } from "@/modules/ai-gateway";
import { estimateReservation, inputTokenBound, unitForCurrency } from "./index";
import type { EstimateInput } from "./index";
import { MODELS, PRICE } from "./test-kit";

const base = (over: Partial<EstimateInput> = {}): EstimateInput => ({
  model: "main",
  contents: ["abcd"],
  maxOutputTokens: 100,
  models: new Map(Object.entries(MODELS)),
  fallbacks: new Map(),
  currency: "IRR",
  maxProviderCalls: 1,
  perMessageOverheadTokens: 10,
  ...over,
});
const amount = (over: Partial<EstimateInput> = {}) => {
  const r = estimateReservation(base(over));
  if (!r.ok) throw new Error(r.code);
  return r.value;
};
const code = (over: Partial<EstimateInput> = {}) => {
  const r = estimateReservation(base(over));
  return r.ok ? "ok" : r.code;
};

describe("metering/estimate · واحد و کران توکن", () => {
  it("unitForCurrency: <ارز>_MICROS (تصمیم معماری ADR-0020 ۲)", () => {
    expect(unitForCurrency("IRR")).toBe("IRR_MICROS");
    expect(unitForCurrency("USD")).toBe("USD_MICROS");
  });
  it("کران = بایت‌های UTF‑8 + سربار هر پیام", () => {
    expect(inputTokenBound(["abcd"], 10)).toBe(14);
    expect(inputTokenBound([], 10)).toBe(0);
    expect(inputTokenBound(["", ""], 3)).toBe(6);
    expect(inputTokenBound(["abcd", "ef"], 0)).toBe(6);
    expect(inputTokenBound(["abcd", "ef"], 5)).toBe(16);
  });
  it("فارسی ۲ بایت، ایموجی ۴ بایت، جانشینِ تنها ۳ بایت (هرگز کمتر از واقع)", () => {
    expect(inputTokenBound(["سلام"], 0)).toBe(8);
    expect(inputTokenBound(["😀"], 0)).toBe(4);
    expect(inputTokenBound(["\ud800"], 0)).toBe(3);
    expect(inputTokenBound(["سلام"], 0)).toBeGreaterThan("سلام".length);
  });
});

describe("metering/estimate · بدترین‌هزینه", () => {
  it("حساب دستی: ۱۴ ورودی × ۱ + ۱۰۰ خروجی × ۳ = ۳۱۴", () => {
    expect(amount()).toEqual({ amount: 314, perCall: 314, inputBound: 14 });
  });
  it("برابر computeCost دروازه (گرد به بالا): قیمت کسری", () => {
    const price = { currency: "IRR", inputMicrosPerMTok: 333_333, outputMicrosPerMTok: 777_777, version: "frac" };
    const models = new Map([["main", { price, maxOutputTokens: 1000 }]]);
    const a = amount({ models });
    expect(a.amount).toBe(computeCost({ inputTokens: 14, outputTokens: 100, totalTokens: 114 }, price).micros);
    expect(a.amount).toBe(Math.ceil((14 * 333_333 + 100 * 777_777) / 1_000_000));
  });
  it("× maxProviderCalls", () => {
    expect(amount({ maxProviderCalls: 3 }).amount).toBe(942);
    expect(amount({ maxProviderCalls: 20 }).amount).toBe(314 * 20);
  });
  it("بیشینه روی زنجیرهٔ جایگزین‌ها (alt گران‌تر: ۱۴×۲ + ۱۰۰×۵ = ۵۲۸)", () => {
    const a = amount({ fallbacks: new Map([["main", ["alt"]]]) });
    expect(a.perCall).toBe(528);
    expect(a.amount).toBe(528);
  });
  it("اگر جایگزین ارزان‌تر باشد، مدل اصلی تعیین‌کننده است", () => {
    const cheap = { price: { ...PRICE, inputMicrosPerMTok: 0, outputMicrosPerMTok: 0, version: "c" }, maxOutputTokens: 1000 };
    const models = new Map([...Object.entries(MODELS), ["cheap", cheap]]);
    expect(amount({ models, fallbacks: new Map([["main", ["cheap"]]]) }).perCall).toBe(314);
  });
  it("قیمت صفر: حداقل رزرو ۱ (دفتر مبلغ ≥ ۱ می‌خواهد) و perCall ۰", () => {
    const zero = { price: { ...PRICE, inputMicrosPerMTok: 0, outputMicrosPerMTok: 0, version: "z" }, maxOutputTokens: 1000 };
    expect(amount({ models: new Map([["main", zero]]) })).toMatchObject({ amount: 1, perCall: 0 });
  });
  it("چند پیام: همهٔ بایت‌ها و سربار هر پیام", () => {
    expect(amount({ contents: ["abcd", "سلام"], maxOutputTokens: 1 }).inputBound).toBe(4 + 8 + 20);
  });
  it("خاصیتی: رزرو هرگز از هزینهٔ هر مصرفِ ≤ کران کمتر نیست", () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 300; i++) {
      const contents = Array.from({ length: 1 + rnd(5) }, () => "اabc😀".repeat(rnd(40)));
      const out = 1 + rnd(1000);
      const calls = 1 + rnd(5);
      const a = amount({ contents, maxOutputTokens: out, maxProviderCalls: calls, fallbacks: new Map([["main", ["alt"]]]) });
      const worst = computeCost({ inputTokens: a.inputBound, outputTokens: out, totalTokens: a.inputBound + out }, MODELS["alt"]!.price!).micros;
      expect(a.amount).toBeGreaterThanOrEqual(worst * calls);
      expect(a.amount).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("metering/estimate · ردها", () => {
  it("مدل: ناشناخته، بی‌قیمت، ارز دیگر", () => {
    expect(code({ model: "nope" })).toBe("UNKNOWN_MODEL");
    expect(code({ model: "free" })).toBe("UNPRICED_MODEL");
    expect(code({ model: "usd" })).toBe("CURRENCY_MISMATCH");
  });
  it("زنجیره: جایگزینِ ناشناخته/بی‌قیمت/ارز دیگر رد می‌شود", () => {
    expect(code({ fallbacks: new Map([["main", ["ghost"]]]) })).toBe("UNKNOWN_MODEL");
    expect(code({ fallbacks: new Map([["main", ["free"]]]) })).toBe("UNPRICED_MODEL");
    expect(code({ fallbacks: new Map([["main", ["usd"]]]) })).toBe("CURRENCY_MISMATCH");
  });
  it("maxOutputTokens: غیرصحیح، صفر، منفی، NaN، رشته، بیش از سقف مدل", () => {
    for (const v of [0, -1, 1.5, Number.NaN, Infinity, "5", null, undefined, 1001, Number.MAX_SAFE_INTEGER + 1]) expect(code({ maxOutputTokens: v as number })).toBe("INVALID_REQUEST");
    expect(code({ maxOutputTokens: 1000 })).toBe("ok");
  });
  it("پیام‌ها: ۰، بیش از ۶۴، غیررشته، بیش از ۱٬۰۰۰٬۰۰۰ نویسه", () => {
    expect(code({ contents: [] })).toBe("INVALID_REQUEST");
    expect(code({ contents: Array.from({ length: 65 }, () => "a") })).toBe("INVALID_REQUEST");
    expect(code({ contents: Array.from({ length: 64 }, () => "a") })).toBe("ok");
    expect(code({ contents: [5 as unknown as string] })).toBe("INVALID_REQUEST");
    expect(code({ contents: ["a".repeat(1_000_001)] })).toBe("INVALID_REQUEST");
    expect(code({ contents: ["a".repeat(1_000_000)], maxOutputTokens: 1 })).toBe("ok");
  });
  it("سرریز: هزینهٔ یک تماس از ۲⁵۳ یا ضرب در تماس‌ها از ۲⁵۳", () => {
    const big = { price: { currency: "IRR", inputMicrosPerMTok: 1_000_000_000_000, outputMicrosPerMTok: 1_000_000_000_000, version: "b" }, maxOutputTokens: 1_000_000_000 };
    expect(code({ models: new Map([["main", big]]), maxOutputTokens: 1_000_000_000, maxProviderCalls: 20 })).toBe("ESTIMATE_OVERFLOW");
    const near = { price: { currency: "IRR", inputMicrosPerMTok: 0, outputMicrosPerMTok: 1_000_000_000_000, version: "n" }, maxOutputTokens: 1_000_000_000 };
    // 10^9 × 10^12 / 10^6 = 10^15 < 2^53 ⇒ تنها ضرب در ۲۰ سرریز می‌کند (2×10^16 > 9×10^15)
    expect(code({ models: new Map([["main", near]]), maxOutputTokens: 1_000_000_000, maxProviderCalls: 1 })).toBe("ok");
    expect(code({ models: new Map([["main", near]]), maxOutputTokens: 1_000_000_000, maxProviderCalls: 20 })).toBe("ESTIMATE_OVERFLOW");
  });
});
