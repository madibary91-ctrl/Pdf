import { describe, expect, it } from "vitest";
import { createMeteredGateway, resolveMeteringConfig } from "./index";
import { MODELS, config, fakeGateway, fundedLedger } from "./test-kit";

async function good(over: Record<string, unknown> = {}) {
  const { ledger } = await fundedLedger(1);
  return config(ledger, fakeGateway([]), over);
}
async function issues(over: Record<string, unknown>): Promise<string> {
  const r = resolveMeteringConfig(await good(over));
  return r.ok ? "OK" : r.error.issues.join("|");
}

describe("metering/config · اعتبارسنجی روی مرز", () => {
  it("پیکربندی سالم؛ واحد از ارز می‌آید؛ مدل‌های شکل ModelSpec (میدان اضافه) پذیرفته می‌شوند", async () => {
    const extended = Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, { ...v, provider: "p1", providerModel: "x", maxInputChars: 5 }]));
    const r = resolveMeteringConfig(await good({ models: extended, fallbacks: { main: ["alt"] } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.value.unit, r.value.models.size, r.value.fallbacks.get("main")]).toEqual(["IRR_MICROS", 4, ["alt"]]);
  });
  it("ورودی نامعتبر: null، رشته، آرایه ⇒ INVALID_CONFIG بی‌پرتاب", () => {
    for (const v of [null, undefined, "x", 5, []]) {
      const r = createMeteredGateway(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_CONFIG");
    }
  });
  it("کلید ناشناخته رد می‌شود (غلط املایی مثل onUnknownCosts بی‌صدا پیش‌فرض نمی‌گذارد)", async () => {
    expect(await issues({ onUnknownCosts: "release" })).toContain("کلید ناشناخته");
  });
  it("میدان‌های بی‌پیش‌فرض الزامی‌اند", async () => {
    for (const k of ["onUnknownCost", "perMessageOverheadTokens", "maxProviderCalls", "reservationTtlMs", "scopeId", "currency", "models", "account", "gateway", "ledger"]) {
      expect(await issues({ [k]: undefined }), k).toContain(k);
    }
  });
  it("onUnknownCost فقط forfeit|release", async () => {
    for (const v of ["", "FORFEIT", "ignore", true, 0]) expect(await issues({ onUnknownCost: v })).toContain("onUnknownCost");
    expect(await issues({ onUnknownCost: "release" })).toBe("OK");
  });
  it("currency: سه حرف بزرگ", async () => {
    for (const v of ["irr", "IR", "IRRR", "I1R", "", 5]) expect(await issues({ currency: v })).toContain("currency");
  });
  it("ttl: مرزهای ۱ثانیه و ۲۴ساعت", async () => {
    for (const v of [999, 86_400_001, 1.5, "60000", Number.NaN]) expect(await issues({ reservationTtlMs: v })).toContain("reservationTtlMs");
    expect(await issues({ reservationTtlMs: 1000 })).toBe("OK");
    expect(await issues({ reservationTtlMs: 86_400_000 })).toBe("OK");
  });
  it("maxProviderCalls ۱…۲۰؛ perMessageOverheadTokens ۰…۱۰۰۰", async () => {
    for (const v of [0, 21, 1.5, -1]) expect(await issues({ maxProviderCalls: v })).toContain("maxProviderCalls");
    for (const v of [-1, 1001, 0.5]) expect(await issues({ perMessageOverheadTokens: v })).toContain("perMessageOverheadTokens");
    expect(await issues({ maxProviderCalls: 20, perMessageOverheadTokens: 0 })).toBe("OK");
    expect(await issues({ maxProviderCalls: 1, perMessageOverheadTokens: 1000 })).toBe("OK");
  });
  it("scopeId: شناسهٔ معتبر و حداکثر ۹۶ نویسه (جا برای .r<n> زیر ۱۲۸)", async () => {
    for (const v of ["", " a", "a b", "-a", "a".repeat(97), "سلام"]) expect(await issues({ scopeId: v })).toContain("scopeId");
    expect(await issues({ scopeId: "a".repeat(96) })).toBe("OK");
    expect(`${"a".repeat(96)}.r${Number.MAX_SAFE_INTEGER}`.length).toBeLessThanOrEqual(128);
  });
  it("account: کلید ناقص یا کلید اضافه رد می‌شود", async () => {
    for (const v of [{ tenantId: "t" }, { tenantId: "t", accountId: "a", x: 1 }, "t", null]) expect(await issues({ account: v })).toContain("account");
  });
  it("gateway و ledger باید توابع لازم را داشته باشند", async () => {
    expect(await issues({ gateway: { complete: () => 1 } })).toContain("gateway");
    expect(await issues({ ledger: { reserve: () => 1, charge: () => 1 } })).toContain("ledger");
  });
  it("models: تهی، بدشکل، سقف خروجی نامعتبر، قیمت نامعتبر", async () => {
    expect(await issues({ models: {} })).toContain("models");
    expect(await issues({ models: [] })).toContain("models");
    expect(await issues({ models: { m: 5 } })).toContain("models");
    expect(await issues({ models: { m: { price: null, maxOutputTokens: 0 } } })).toContain("maxOutputTokens");
    expect(await issues({ models: { m: { price: { currency: "irr" }, maxOutputTokens: 5 } } })).toContain("price");
    expect(await issues({ models: { m: { price: undefined, maxOutputTokens: 5 } } })).toContain("price");
  });
  it("fallbacks: مبدأ ناشناخته، خودش، تکراری، ناشناخته، بیش از ۵، تهی", async () => {
    expect(await issues({ fallbacks: { ghost: ["main"] } })).toContain("مبدأ");
    for (const list of [["main"], ["alt", "alt"], ["ghost"], [], "alt", Array.from({ length: 6 }, () => "alt")]) expect(await issues({ fallbacks: { main: list } })).toContain("fallbacks");
    expect(await issues({ fallbacks: [] })).toContain("fallbacks");
    expect(await issues({ fallbacks: { main: ["alt", "free", "usd"] } })).toBe("OK");
  });
  it("مقدارهای نامعتبر هرگز در پیام نمی‌آیند (فقط نام فیلد/کلید پیکربندی)", async () => {
    const CANARY = "CANARY-سری-۱۲۳";
    const text = await issues({
      scopeId: CANARY,
      currency: CANARY,
      onUnknownCost: CANARY,
      reservationTtlMs: CANARY,
      account: { tenantId: CANARY },
      models: { m1: { price: { currency: CANARY }, maxOutputTokens: CANARY }, m2: CANARY },
      fallbacks: { m1: [CANARY] },
    });
    expect(text).not.toBe("OK");
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("سری-۱۲۳");
  });
  it("getter پرتاب‌کننده ⇒ INVALID_CONFIG، بی‌پرتاب و بی‌پژواک", () => {
    const CANARY = "CANARY-نشت";
    const hostile = { get gateway(): never { throw new Error(CANARY); } };
    const r = createMeteredGateway(hostile);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
  it("پیکربندی «گرفته» می‌شود: ویرایش بعدیِ ورودی رفتار را عوض نمی‌کند", async () => {
    const c = (await good({ fallbacks: { main: ["alt"] } })) as unknown as { fallbacks: Record<string, string[]>; currency: string };
    const r = resolveMeteringConfig(c);
    c.fallbacks["main"]!.push("free");
    c.currency = "USD";
    expect(r.ok && r.value.fallbacks.get("main")).toEqual(["alt"]);
    expect(r.ok && r.value.currency).toBe("IRR");
  });
});
