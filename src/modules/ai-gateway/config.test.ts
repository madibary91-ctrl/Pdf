import { describe, expect, it } from "vitest";
import { createGateway } from "./gateway";
import { CONFIG_LIMITS, resolveConfig } from "./index";
import { PRICE, manualClock, scriptedProvider } from "./test-kit";

const model = { provider: "p1", providerModel: "pm", maxInputChars: 100, maxOutputTokens: 50, price: PRICE };
const good = () => ({ providers: { p1: scriptedProvider([]) }, models: { m1: { ...model } }, clock: manualClock() });
const issues = (c: unknown): string => {
  const r = resolveConfig(c);
  if (r.ok) throw new Error("پذیرفته شد");
  return r.issues.join("\n");
};

describe("ai-gateway · پیکربندی", () => {
  it("پیکربندی کمینه معتبر؛ پیش‌فرض‌ها: مهلت ۶۰٬۰۰۰ مدل و ۵۰۰۰ ثبت مصرف؛ بدون sink", () => {
    const r = resolveConfig(good());
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.value.models.get("m1")?.timeoutMs).toBe(CONFIG_LIMITS.defaultTimeoutMs);
    expect(r.value.sinkTimeoutMs).toBe(5000);
    expect(r.value.usageSink).toBeNull();
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.models.get("m1"))).toBe(true);
  });

  it("createGateway پیکربندی نامعتبر را INVALID_CONFIG با issues برمی‌گرداند (نه پرتاب)", () => {
    for (const bad of [null, undefined, "x", 5, [], {}]) {
      const g = createGateway(bad);
      expect(g.ok).toBe(false);
      if (!g.ok) expect(g.error).toMatchObject({ code: "INVALID_CONFIG", retryable: false });
    }
  });

  it("ساعت الزامی است (ساعت سیستم پیش‌فرض ندارد)", () => {
    const { clock: _c, ...rest } = good();
    void _c;
    expect(issues(rest)).toContain("clock");
    expect(issues({ ...good(), clock: {} })).toContain("clock");
    expect(issues({ ...good(), clock: { nowMs: 5 } })).toContain("clock");
  });

  it("کلید ناشناخته در بالاترین سطح رد می‌شود (usageSInk نباید ثبت مصرف را بی‌صدا خاموش کند)", () => {
    expect(issues({ ...good(), usageSInk: { record: () => undefined } })).toContain("usageSInk");
  });

  it("providers: تهی، بدون complete، نام نامعتبر ⇒ رد", () => {
    expect(issues({ ...good(), providers: {} })).toContain("providers");
    expect(issues({ ...good(), providers: [] })).toContain("providers");
    expect(issues({ ...good(), providers: { p1: {} } })).toContain("complete");
    expect(issues({ ...good(), providers: { p1: { complete: 5 } } })).toContain("complete");
    expect(issues({ ...good(), providers: { "bad name": scriptedProvider([]) } })).toContain("نامعتبر");
  });

  it("models: تهی؛ ارائه‌دهندهٔ ناموجود؛ نام نامعتبر؛ مدل غیرشیء ⇒ رد", () => {
    expect(issues({ ...good(), models: {} })).toContain("models");
    expect(issues({ ...good(), models: { m1: { ...model, provider: "ghost" } } })).toContain("provider");
    expect(issues({ ...good(), models: { m1: { ...model, provider: "constructor" } } })).toContain("provider");
    expect(issues({ ...good(), models: { "bad name!": model } })).toContain("نام مدل");
    expect(issues({ ...good(), models: { m1: 5 } })).toContain("باید شیء");
  });

  it("مرز فیلدهای مدل", () => {
    const ok = (over: object) => resolveConfig({ ...good(), models: { m1: { ...model, ...over } } }).ok;
    expect(ok({ maxInputChars: 1 })).toBe(true);
    expect(ok({ maxInputChars: 10_000_000 })).toBe(true);
    expect(ok({ maxInputChars: 10_000_001 })).toBe(false);
    expect(ok({ maxInputChars: 0 })).toBe(false);
    expect(ok({ maxOutputTokens: 1_000_000 })).toBe(true);
    expect(ok({ maxOutputTokens: 1_000_001 })).toBe(false);
    expect(ok({ maxOutputTokens: 1.5 })).toBe(false);
    expect(ok({ timeoutMs: 600_000 })).toBe(true);
    expect(ok({ timeoutMs: 0 })).toBe(false);
    expect(ok({ timeoutMs: 600_001 })).toBe(false);
    expect(ok({ providerModel: "" })).toBe(false);
    expect(ok({ providerModel: "   " })).toBe(false);
    expect(ok({ providerModel: "a".repeat(200) })).toBe(true);
    expect(ok({ providerModel: "a".repeat(201) })).toBe(false);
    expect(ok({ extra: 1 })).toBe(false);
  });

  it("price باید صریح باشد: نبودن کلید خطاست؛ null مجاز (بدون قیمت)", () => {
    const { price: _p, ...noPrice } = model;
    void _p;
    expect(issues({ ...good(), models: { m1: noPrice } })).toContain("price");
    expect(issues({ ...good(), models: { m1: { ...model, price: undefined } } })).toContain("price");
    expect(resolveConfig({ ...good(), models: { m1: { ...model, price: null } } }).ok).toBe(true);
  });

  it("قیمت: ارز، نسخه، سقف‌ها و کلید ناشناخته", () => {
    const ok = (over: object) => resolveConfig({ ...good(), models: { m1: { ...model, price: { ...PRICE, ...over } } } }).ok;
    expect(ok({})).toBe(true);
    expect(ok({ currency: "irr" })).toBe(false);
    expect(ok({ currency: "IRRR" })).toBe(false);
    expect(ok({ version: "" })).toBe(false);
    expect(ok({ version: "a b" })).toBe(false);
    expect(ok({ version: "v".repeat(64) })).toBe(true);
    expect(ok({ version: "v".repeat(65) })).toBe(false);
    expect(ok({ inputMicrosPerMTok: -1 })).toBe(false);
    expect(ok({ inputMicrosPerMTok: 0 })).toBe(true);
    expect(ok({ inputMicrosPerMTok: 1_000_000_000_000 })).toBe(true);
    expect(ok({ inputMicrosPerMTok: 1_000_000_000_001 })).toBe(false);
    expect(ok({ outputMicrosPerMTok: 0.5 })).toBe(false);
    expect(ok({ outputMicrosPerMTok: "5" })).toBe(false);
    expect(ok({ tax: 1 })).toBe(false);
    expect(resolveConfig({ ...good(), models: { m1: { ...model, price: "free" } } }).ok).toBe(false);
  });

  it("timers/usageSink/مهلت‌ها: نوع و بازه", () => {
    expect(issues({ ...good(), timers: {} })).toContain("timers");
    expect(issues({ ...good(), usageSink: {} })).toContain("usageSink");
    expect(issues({ ...good(), usageSink: { record: 1 } })).toContain("usageSink");
    expect(issues({ ...good(), defaultTimeoutMs: 0 })).toContain("defaultTimeoutMs");
    expect(issues({ ...good(), sinkTimeoutMs: 600_001 })).toContain("sinkTimeoutMs");
    expect(resolveConfig({ ...good(), defaultTimeoutMs: 123, sinkTimeoutMs: 9 }).ok).toBe(true);
    const r = resolveConfig({ ...good(), defaultTimeoutMs: 123, sinkTimeoutMs: 9 });
    if (r.ok) {
      expect(r.value.models.get("m1")?.timeoutMs).toBe(123);
      expect(r.value.sinkTimeoutMs).toBe(9);
    }
  });

  it("همهٔ مشکل‌ها یک‌جا؛ و issues هیچ مقدار حساسی را بازتاب نمی‌دهد", () => {
    const text = issues({ providers: { p1: { complete: "sk-SECRET" } }, models: { m1: { provider: "p1", providerModel: "sk-SECRET".repeat(30), maxInputChars: "sk-SECRET", maxOutputTokens: 0, price: { currency: "sk-SECRET" } } }, clock: "sk-SECRET", bogus: 1 });
    expect(text.split("\n").length).toBeGreaterThanOrEqual(6);
    expect(text).not.toContain("SECRET");
  });

  it("پیکربندی خصمانه (getter پرتاب‌کننده) ⇒ رد، نه پرتاب", () => {
    const hostile = { get providers(): unknown { throw new Error("boom"); } };
    expect(resolveConfig(hostile).ok).toBe(false);
    expect(createGateway(hostile).ok).toBe(false);
  });
});
