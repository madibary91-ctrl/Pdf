import { describe, expect, it } from "vitest";
import { NEVER_REACHED_CODES, observeCost } from "./index";
import { errResult, okResult, report } from "./test-kit";

const obs = (r: unknown) => observeCost(r, "IRR");
const unk = (reason: string, lowerBound = 0) => ({ kind: "unknown", reason, lowerBound });

describe("metering/cost · بدون گزارش (دروازهٔ ساده)", () => {
  it("موفق با cost هم‌ارز ⇒ معلوم (حتی ۰)", () => {
    expect(obs(okResult(120))).toEqual({ kind: "known", micros: 120 });
    expect(obs(okResult(0))).toEqual({ kind: "known", micros: 0 });
  });
  it("موفق با cost=null یا ناقص ⇒ نامعلوم", () => {
    expect(obs(okResult(null))).toEqual(unk("no-cost"));
    expect(obs({ ok: true, value: { cost: 5 } })).toEqual(unk("no-cost"));
    expect(obs({ ok: true, value: { cost: { micros: 5 } } })).toEqual(unk("no-cost"));
  });
  it("مبلغ نامعتبر (منفی، اعشاری، NaN، رشته، ناایمن) ⇒ نامعلوم، نه معلوم", () => {
    for (const micros of [-1, 1.5, Number.NaN, Infinity, "5", Number.MAX_SAFE_INTEGER + 1, null]) {
      const r = obs({ ok: true, value: { cost: { micros, currency: "IRR" } } });
      expect(r.kind, String(micros)).toBe("unknown");
    }
  });
  it("ارز دیگر ⇒ نامعلوم (تبدیل نیست)", () => {
    expect(obs({ ok: true, value: { cost: { micros: 5, currency: "USD" } } })).toEqual(unk("currency"));
  });
  it("خطای پیش از رسیدن به ارائه‌دهنده ⇒ هیچ", () => {
    for (const c of NEVER_REACHED_CODES) expect(obs(errResult(c))).toEqual({ kind: "none" });
    expect([...NEVER_REACHED_CODES].sort()).toEqual(["INVALID_CONFIG", "INVALID_REQUEST", "UNKNOWN_MODEL"]);
  });
  it("هر خطای دیگر بی‌گزارش ⇒ نامعلوم (ندانستن ≠ صفر)", () => {
    for (const c of ["TIMEOUT", "ABORTED", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE", "PROVIDER_AUTH", "PROVIDER_REJECTED", "PROVIDER_ERROR", "PROVIDER_BAD_RESPONSE", "INTERNAL_ERROR", "ANYTHING"]) {
      expect(obs(errResult(c)), c).toEqual(unk("no-report"));
    }
    expect(obs({ ok: false, error: {} })).toEqual(unk("no-report"));
  });
  it("نتیجهٔ بی‌شکل ⇒ نامعلوم", () => {
    for (const r of [null, undefined, 5, "x", [], {}, { ok: "yes" }, { ok: true }, { ok: true, value: null }, { ok: false, error: 5 }]) expect(obs(r).kind).toBe("unknown");
  });
});

describe("metering/cost · با گزارش تاب‌آور (منبع حقیقت)", () => {
  it("مجموع ردیف‌های هزینه (نه cost تلاشِ آخر)", () => {
    expect(obs(okResult(1, { report: report({ spend: [{ currency: "IRR", micros: 500 }] }) }))).toEqual({ kind: "known", micros: 500 });
    expect(obs(okResult(1, { report: report({ spend: [{ currency: "IRR", micros: 300 }, { currency: "IRR", micros: 200 }] }) }))).toEqual({ kind: "known", micros: 500 });
  });
  it("هزینهٔ صفرِ تماسِ رسیده با ردیف صفر ⇒ معلومِ ۰", () => {
    expect(obs(okResult(0, { report: report({ spend: [{ currency: "IRR", micros: 0 }] }) }))).toEqual({ kind: "known", micros: 0 });
  });
  it("هر تلاشِ نامعلوم ⇒ نامعلوم با کفِ معلوم", () => {
    expect(obs(okResult(1, { report: report({ costUnknownAttempts: 1 }) }))).toEqual(unk("report-unknown", 100));
    expect(obs(errResult("TIMEOUT", { report: report({ costUnknownAttempts: 2, spend: [] }) }))).toEqual(unk("report-unknown", 0));
  });
  it("micros:null (سرریز در گزارش) ⇒ نامعلوم؛ کف فقط از ردیف‌های معلوم", () => {
    const rep = report({ spend: [{ currency: "IRR", micros: 40 }, { currency: "IRR", micros: null }] });
    expect(obs(okResult(1, { report: rep }))).toEqual(unk("report-unknown", 40));
  });
  it("ارز ناهمخوان ⇒ نامعلوم؛ کف فقط از ردیف‌های هم‌ارز", () => {
    const rep = report({ spend: [{ currency: "IRR", micros: 40 }, { currency: "USD", micros: 9 }] });
    expect(obs(okResult(1, { report: rep }))).toEqual(unk("currency", 40));
  });
  it("مبلغ نامعتبر در گزارش ⇒ نامعلوم", () => {
    expect(obs(okResult(1, { report: report({ spend: [{ currency: "IRR", micros: -5 }] }) })).kind).toBe("unknown");
    expect(obs(okResult(1, { report: report({ spend: [{ currency: "IRR", micros: 1.5 }] }) })).kind).toBe("unknown");
    expect(obs(okResult(1, { report: report({ spend: [5] }) })).kind).toBe("unknown");
  });
  it("جمع از ۲⁵۳ می‌گذرد ⇒ نامعلوم با کف ۰ (کفِ ناایمن هرگز داده نمی‌شود)", () => {
    const rep = report({ spend: [{ currency: "IRR", micros: Number.MAX_SAFE_INTEGER }, { currency: "IRR", micros: 2 }] });
    expect(obs(okResult(1, { report: rep }))).toEqual(unk("bad-amount", 0));
  });
  it("هیچ تلاشِ رسیده و هیچ هزینه ⇒ هیچ", () => {
    const rep = report({ attempts: [{ reachedProvider: false }], spend: [], costUnknownAttempts: 0 });
    expect(obs(errResult("INVALID_REQUEST", { report: rep }))).toEqual({ kind: "none" });
    expect(obs(errResult("ABORTED", { report: report({ attempts: [], spend: [], costUnknownAttempts: 0 }) }))).toEqual({ kind: "none" });
  });
  it("تلاشِ رسیده بدون ردیف هزینه و بدون نامعلوم = ناسازگار ⇒ نامعلوم، نه صفر", () => {
    expect(obs(errResult("TIMEOUT", { report: report({ spend: [], costUnknownAttempts: 0 }) }))).toEqual(unk("report-inconsistent", 0));
  });
  it("گزارشِ بدشکل نادیده گرفته می‌شود و به مسیر بی‌گزارش می‌رود (حدس نمی‌زنیم)", () => {
    expect(obs(okResult(120, { report: { attempts: 1 } }))).toEqual({ kind: "known", micros: 120 });
    expect(obs(errResult("TIMEOUT", { report: { spend: [], attempts: [], costUnknownAttempts: -1 } }))).toEqual(unk("no-report"));
    expect(obs(errResult("TIMEOUT", { report: null }))).toEqual(unk("no-report"));
  });
});
