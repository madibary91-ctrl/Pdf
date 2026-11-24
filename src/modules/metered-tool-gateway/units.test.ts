import { describe, expect, it } from "vitest";
import { estimateStep } from "./estimate";
import { observeStep } from "./observe";

const models = new Map([
  ["m", { price: { currency: "IRR", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 3_000_000, version: "v" }, maxOutputTokens: 1000 }],
  ["free", { price: null, maxOutputTokens: 1000 }],
  ["usd", { price: { currency: "USD", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, version: "v" }, maxOutputTokens: 1000 }],
  ["big", { price: { currency: "IRR", inputMicrosPerMTok: Number.MAX_SAFE_INTEGER, outputMicrosPerMTok: Number.MAX_SAFE_INTEGER, version: "v" }, maxOutputTokens: Number.MAX_SAFE_INTEGER }],
]);
const est = (over: Record<string, unknown> = {}) => estimateStep({ model: "m", contents: ["abcd"], maxOutputTokens: 100, models, currency: "IRR", perMessageOverheadTokens: 10, ...over } as never);

describe("estimateStep", () => {
  it("بایت‌های UTF‑8 + سربار + خروجی×۳ (فارسی دوبایتی است)", () => {
    expect(est()).toEqual({ ok: true, amount: 4 + 10 + 300 });
    expect(est({ contents: ["سلام"] })).toEqual({ ok: true, amount: 8 + 10 + 300 });
  });
  it("هر بخش سربارِ خودش را دارد و بخش‌ها جمع می‌شوند، بدونِ سقفِ ۶۴ پیام", () => {
    const contents = Array.from({ length: 200 }, () => "a");
    expect(est({ contents })).toEqual({ ok: true, amount: 200 * 11 + 300 });
  });
  it("کفِ رزرو ۱ است (همه‌چیز رایگان)", () => {
    expect(est({ contents: [], perMessageOverheadTokens: 0, maxOutputTokens: 1, models: new Map([["m", { price: { currency: "IRR", inputMicrosPerMTok: 0, outputMicrosPerMTok: 0, version: "v" }, maxOutputTokens: 5 }]]) })).toEqual({ ok: true, amount: 1 });
  });
  it.each([
    [{ maxOutputTokens: 0 }, "INVALID_REQUEST"],
    [{ maxOutputTokens: 1.5 }, "INVALID_REQUEST"],
    [{ maxOutputTokens: "5" }, "INVALID_REQUEST"],
    [{ maxOutputTokens: 1001 }, "INVALID_REQUEST"],
    [{ model: "nope" }, "UNKNOWN_MODEL"],
    [{ model: "free" }, "UNPRICED_MODEL"],
    [{ model: "usd" }, "CURRENCY_MISMATCH"],
    [{ model: "big", maxOutputTokens: Number.MAX_SAFE_INTEGER }, "ESTIMATE_OVERFLOW"],
    [{ currency: "USD" }, "CURRENCY_MISMATCH"],
  ])("%j ⇒ %s", (over, code) => {
    expect(est(over)).toEqual({ ok: false, code });
  });
});

const okv = (cost: unknown) => ({ ok: true, value: { cost } });
const erv = (code: string, cost: unknown = null) => ({ ok: false, error: { code, cost } });
describe("observeStep", () => {
  it("موفق با هزینهٔ معتبر ⇒ known", () => {
    expect(observeStep(okv({ micros: 7, currency: "IRR", priceVersion: "v" }), "IRR")).toEqual({ kind: "known", micros: 7 });
    expect(observeStep(okv({ micros: 0, currency: "IRR", priceVersion: "v" }), "IRR")).toEqual({ kind: "known", micros: 0 });
  });
  it("شکست با هزینهٔ معتبر ⇒ known (گامِ خراب هزینه شده است)", () => {
    expect(observeStep(erv("PROVIDER_BAD_RESPONSE", { micros: 9, currency: "IRR", priceVersion: "v" }), "IRR")).toEqual({ kind: "known", micros: 9 });
  });
  it("موفق بی‌هزینه ⇒ unknown/no-cost با کفِ ۰", () => {
    expect(observeStep(okv(null), "IRR")).toEqual({ kind: "unknown", reason: "no-cost", lowerBound: 0 });
    expect(observeStep(okv(undefined), "IRR")).toEqual({ kind: "unknown", reason: "no-cost", lowerBound: 0 });
  });
  it.each(["INVALID_REQUEST", "UNKNOWN_MODEL", "INVALID_CONFIG"])("%s بی‌هزینه ⇒ none", (c) => {
    expect(observeStep(erv(c), "IRR")).toEqual({ kind: "none" });
  });
  it.each(["TIMEOUT", "ABORTED", "PROVIDER_AUTH", "PROVIDER_REJECTED", "INTERNAL_ERROR", "weird"])("%s بی‌هزینه ⇒ unknown/no-report", (c) => {
    expect(observeStep(erv(c), "IRR")).toEqual({ kind: "unknown", reason: "no-report", lowerBound: 0 });
  });
  it("هزینهٔ ناهنجار ⇒ unknown با دلیلِ درست، حتی روی خطاهای «بی‌تماس» (هزینه بر کد پیشی می‌گیرد)", () => {
    expect(observeStep(okv({ micros: 1, currency: "USD", priceVersion: "v" }), "IRR")).toMatchObject({ kind: "unknown", reason: "currency" });
    expect(observeStep(okv({ micros: -1, currency: "IRR" }), "IRR")).toMatchObject({ kind: "unknown", reason: "bad-amount" });
    expect(observeStep(okv({ micros: 1 }), "IRR")).toMatchObject({ kind: "unknown", reason: "no-cost" });
    expect(observeStep(okv("x"), "IRR")).toMatchObject({ kind: "unknown", reason: "no-cost" });
    expect(observeStep(erv("INVALID_REQUEST", { micros: 1.5, currency: "IRR" }), "IRR")).toMatchObject({ kind: "unknown", reason: "bad-amount" });
  });
  it.each([null, undefined, 5, "x", [], {}, { ok: "yes" }, { ok: true }, { ok: false }, { ok: true, value: [] }])("نتیجهٔ بی‌شکل %j ⇒ unknown/no-result", (r) => {
    expect(observeStep(r, "IRR")).toEqual({ kind: "unknown", reason: "no-result", lowerBound: 0 });
  });
});
