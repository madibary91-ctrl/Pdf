/** `mergeAccounting` و `spendGate` (ADR-0017 §۲ و §۶): خالص؛ نامعلوم سرایت می‌کند و هرگز صفر نمی‌شود. */
import { describe, expect, it } from "vitest";
import { mergeAccounting, spendGate } from "./accounting";
import type { Accounting, RepairPolicy } from "./types";

const acc = (over: Partial<Accounting> = {}): Accounting => ({ source: "report", providerCalls: 1, spend: [{ currency: "IRR", micros: 100 }], costUnknownCalls: 0, retried: false, fellBack: false, ...over });
const POLICY: RepairPolicy = { maxFirstAttemptSpendMicros: 500, currency: "IRR" };

describe("ai-orchestrator · mergeAccounting", () => {
  it("شمارنده‌ها و هزینهٔ هم‌ارز جمع می‌شوند", () => {
    const m = mergeAccounting(acc({ providerCalls: 2, costUnknownCalls: 1 }), acc({ providerCalls: 3, spend: [{ currency: "IRR", micros: 50 }], costUnknownCalls: 2 }));
    expect(m).toEqual({ source: "report", providerCalls: 5, spend: [{ currency: "IRR", micros: 150 }], costUnknownCalls: 3, retried: false, fellBack: false });
  });

  it("ارزهای مختلف جدا می‌مانند و ترتیبِ نخستین دیدن حفظ می‌شود", () => {
    const m = mergeAccounting(acc({ spend: [{ currency: "USD", micros: 7 }, { currency: "IRR", micros: 1 }] }), acc({ spend: [{ currency: "IRR", micros: 2 }, { currency: "EUR", micros: 9 }] }));
    expect(m.spend).toEqual([{ currency: "USD", micros: 7 }, { currency: "IRR", micros: 3 }, { currency: "EUR", micros: 9 }]);
  });

  it("micros: null سرایت می‌کند (نه صفر، نه فقط عددِ طرف دیگر) — در هر دو جهت", () => {
    expect(mergeAccounting(acc({ spend: [{ currency: "IRR", micros: null }] }), acc()).spend).toEqual([{ currency: "IRR", micros: null }]);
    expect(mergeAccounting(acc(), acc({ spend: [{ currency: "IRR", micros: null }] })).spend).toEqual([{ currency: "IRR", micros: null }]);
  });

  it("سرریز 2^53−1 ⇒ micros: null؛ دقیقاً روی مرز هنوز عدد است", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(mergeAccounting(acc({ spend: [{ currency: "IRR", micros: max - 1 }] }), acc({ spend: [{ currency: "IRR", micros: 1 }] })).spend).toEqual([{ currency: "IRR", micros: max }]);
    expect(mergeAccounting(acc({ spend: [{ currency: "IRR", micros: max }] }), acc({ spend: [{ currency: "IRR", micros: 1 }] })).spend).toEqual([{ currency: "IRR", micros: null }]);
  });

  it("providerCalls و costUnknownCalls: هرکدام null ⇒ null (در هر دو جهت)", () => {
    expect(mergeAccounting(acc({ providerCalls: null }), acc()).providerCalls).toBeNull();
    expect(mergeAccounting(acc(), acc({ providerCalls: null })).providerCalls).toBeNull();
    expect(mergeAccounting(acc({ costUnknownCalls: null }), acc()).costUnknownCalls).toBeNull();
    expect(mergeAccounting(acc(), acc({ costUnknownCalls: null })).costUnknownCalls).toBeNull();
  });

  it("source بدترین است: unknown > completion > report (جابه‌جایی‌پذیر)", () => {
    const s = (a: Accounting["source"], b: Accounting["source"]) => mergeAccounting(acc({ source: a }), acc({ source: b })).source;
    expect(s("report", "report")).toBe("report");
    expect(s("report", "completion")).toBe("completion");
    expect(s("completion", "report")).toBe("completion");
    expect(s("completion", "unknown")).toBe("unknown");
    expect(s("unknown", "report")).toBe("unknown");
    expect(s("report", "unknown")).toBe("unknown");
    expect(s("completion", "completion")).toBe("completion");
  });

  it("retried و fellBack با «یا» ترکیب می‌شوند", () => {
    expect(mergeAccounting(acc({ retried: true }), acc())).toMatchObject({ retried: true, fellBack: false });
    expect(mergeAccounting(acc(), acc({ fellBack: true }))).toMatchObject({ retried: false, fellBack: true });
    expect(mergeAccounting(acc(), acc())).toMatchObject({ retried: false, fellBack: false });
  });

  it("ورودی‌ها را تغییر نمی‌دهد", () => {
    const a = acc();
    const b = acc({ spend: [{ currency: "IRR", micros: 5 }] });
    const before = JSON.stringify([a, b]);
    mergeAccounting(a, b);
    expect(JSON.stringify([a, b])).toBe(before);
  });
});

describe("ai-orchestrator · spendGate", () => {
  it("برابر سقف مجاز، یک واحد بیشتر ردّ (مرز)", () => {
    expect(spendGate(acc({ spend: [{ currency: "IRR", micros: 500 }] }), POLICY)).toBe("ok");
    expect(spendGate(acc({ spend: [{ currency: "IRR", micros: 501 }] }), POLICY)).toBe("cost-cap");
    expect(spendGate(acc({ spend: [{ currency: "IRR", micros: 0 }] }), { ...POLICY, maxFirstAttemptSpendMicros: 0 })).toBe("ok");
    expect(spendGate(acc({ spend: [{ currency: "IRR", micros: 1 }] }), { ...POLICY, maxFirstAttemptSpendMicros: 0 })).toBe("cost-cap");
  });

  it("هر نامعلومی ⇒ cost-unknown (هرگز «مجاز»)", () => {
    expect(spendGate(acc({ source: "unknown" }), POLICY)).toBe("cost-unknown");
    expect(spendGate(acc({ providerCalls: null }), POLICY)).toBe("cost-unknown");
    expect(spendGate(acc({ costUnknownCalls: 1 }), POLICY)).toBe("cost-unknown");
    expect(spendGate(acc({ costUnknownCalls: null }), POLICY)).toBe("cost-unknown");
    expect(spendGate(acc({ spend: [] }), POLICY)).toBe("cost-unknown");
    expect(spendGate(acc({ spend: [{ currency: "IRR", micros: null }] }), POLICY)).toBe("cost-unknown");
  });

  it("ارز دیگر ⇒ cost-unknown (حتی اگر عدد کوچک باشد یا ارز درست هم کنارش باشد)", () => {
    expect(spendGate(acc({ spend: [{ currency: "USD", micros: 1 }] }), POLICY)).toBe("cost-unknown");
    expect(spendGate(acc({ spend: [{ currency: "IRR", micros: 1 }, { currency: "USD", micros: 0 }] }), POLICY)).toBe("cost-unknown");
  });

  it("چند ردیفِ هم‌ارز جمع می‌شوند و جمعِ نامطمئن/سرریز ردّ می‌شود", () => {
    expect(spendGate(acc({ spend: [{ currency: "IRR", micros: 300 }, { currency: "IRR", micros: 200 }] }), POLICY)).toBe("ok");
    expect(spendGate(acc({ spend: [{ currency: "IRR", micros: 300 }, { currency: "IRR", micros: 201 }] }), POLICY)).toBe("cost-cap");
    expect(spendGate(acc({ spend: [{ currency: "IRR", micros: Number.MAX_SAFE_INTEGER }, { currency: "IRR", micros: Number.MAX_SAFE_INTEGER }] }), POLICY)).toBe("cost-cap");
  });
});
