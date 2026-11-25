import { describe, expect, it } from "vitest";
import { createDurableLedger, createMemoryOutbox } from "@/modules/settlement";
import { createDurableToolGateway } from "./index";
import { GRACE, TTL, configFor, fundedLedger, stubGateway, stepOk } from "./test-kit";

async function good(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const f = await fundedLedger(1000);
  return configFor(f.ledger, stubGateway(stepOk(1)).gateway, createMemoryOutbox(), f.clock, over);
}
const issuesOf = (r: ReturnType<typeof createDurableToolGateway>): readonly string[] => (r.ok ? [] : r.error.issues);

describe("durable-tool-gateway · پیکربندی", () => {
  it("پیکربندیِ درست ⇒ ToolGateway با receipts/summary", async () => {
    const r = createDurableToolGateway(await good());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const k of ["completeStep", "toolFormat", "limits", "receipts", "summary"] as const) expect(typeof r.value[k]).toBe("function");
    expect(r.value.toolFormat("legal")).toBe("openai-chat");
    expect(r.value.receipts()).toEqual([]);
  });

  it.each([null, undefined, 1, "x", [], [1], () => 1, true])("ورودیِ غیرشیء (%s) ⇒ INVALID_CONFIG بی‌پرتاب", (v: unknown) => {
    const r = createDurableToolGateway(v);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_CONFIG" } });
    expect(issuesOf(r).length).toBeGreaterThan(0);
  });

  it.each([
    ["outbox", undefined],
    ["outbox", {}],
    ["clock", undefined],
    ["clock", { nowMs: 1 }],
    ["graceMs", undefined],
    ["graceMs", 0],
    ["graceMs", -1],
    ["graceMs", 1.5],
    ["graceMs", "10"],
    ["graceMs", Number.NaN],
  ])("%s نامعتبر (%s) ⇒ رد و بی‌ساخت", async (key, value) => {
    const r = createDurableToolGateway({ ...(await good()), [key]: value });
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join(" ")).toContain(key);
  });

  it("کلیدِ ناشناخته و کلیدهای دروازهٔ ساده (fallbacks/maxProviderCalls) رد می‌شوند", async () => {
    for (const extra of [{ fallbacks: {} }, { maxProviderCalls: 1 }, { bogus: 1 }]) {
      expect(createDurableToolGateway({ ...(await good()), ...extra }).ok).toBe(false);
    }
  });

  it("onUnknownCost الزامی و بی‌پیش‌فرض است (هم برای دروازه هم برای رزروِ یتیمِ outbox)", async () => {
    const c = await good();
    delete c["onUnknownCost"];
    const r = createDurableToolGateway(c);
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join(" ")).toContain("onUnknownCost");
    expect(issuesOf(r).filter((i) => i.includes("onUnknownCost"))).toHaveLength(1); // خطای مشترک تکرار نمی‌شود
  });

  it("ttl کمتر از ۲×graceMs رد می‌شود؛ ttl = ۲×graceMs مجاز است", async () => {
    const bad = createDurableToolGateway(await good({ reservationTtlMs: 2 * GRACE - 1 }));
    expect(bad.ok).toBe(false);
    expect(issuesOf(bad)).toContain("reservationTtlMs باید دست‌کم دو برابر graceMs باشد.");
    expect(createDurableToolGateway(await good({ reservationTtlMs: 2 * GRACE })).ok).toBe(true);
    expect(TTL).toBeGreaterThanOrEqual(2 * GRACE);
  });

  it("خطاهای دو سمت یک‌جا و بی‌تکرار گزارش می‌شوند", async () => {
    const r = createDurableToolGateway({ ...(await good()), outbox: undefined, scopeId: "", reservationTtlMs: 1 });
    expect(r.ok).toBe(false);
    const issues = issuesOf(r);
    expect(issues.some((i) => i.includes("outbox"))).toBe(true);
    expect(issues.some((i) => i.includes("scopeId"))).toBe(true);
    expect(new Set(issues).size).toBe(issues.length);
  });

  it("دفترِ خودش دکوراته (ماندگار) رد می‌شود؛ دکوراتورِ دوباره نمی‌پوشد", async () => {
    const f = await fundedLedger(1000);
    const outbox = createMemoryOutbox();
    const d = createDurableLedger({ ledger: f.ledger, outbox, clock: f.clock, graceMs: GRACE, onUnknownCost: "forfeit" });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const r = createDurableToolGateway(configFor(d.value, stubGateway(stepOk(1)).gateway, outbox, f.clock));
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join(" ")).toContain("دکوراتور");
  });

  it("جدولِ مدل‌ها با دروازه ناهمخوان ⇒ رد (قاعدهٔ metered-tool-gateway حفظ می‌شود)", async () => {
    const r = createDurableToolGateway(await good({ models: { legal: { price: null, maxOutputTokens: 1000 } } }));
    expect(r.ok).toBe(false);
  });

  it("getterِ پرتاب‌کننده/Proxy ⇒ INVALID_CONFIG؛ متنِ استثنا نشت نمی‌کند", async () => {
    const trap = { ...(await good()) };
    Object.defineProperty(trap, "graceMs", { enumerable: true, get: () => { throw new Error("SECRET-KEY-123"); } });
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("SECRET-KEY-123"); } });
    for (const v of [trap, proxy]) {
      const r = createDurableToolGateway(v);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("SECRET-KEY-123");
    }
  });

  it("خطا یخ‌زده است و مقدارِ پیکربندی (کلید/رمز) در issues نمی‌آید", async () => {
    const r = createDurableToolGateway({ ...(await good()), scopeId: "sk-LIVE-SECRET-999", graceMs: "sk-LIVE-SECRET-999" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.isFrozen(r.error)).toBe(true);
    expect(Object.isFrozen(r.error.issues)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("sk-LIVE-SECRET-999");
  });

  it("خواندنِ یک‌بارهٔ هر کلید: getterِ دوپهلو نمی‌تواند بین سنجش و ساخت مقدار را عوض کند", async () => {
    const base = await good();
    let reads = 0;
    const cfg = { ...base };
    Object.defineProperty(cfg, "graceMs", { enumerable: true, get: () => (++reads === 1 ? GRACE : 99_999_999) });
    expect(createDurableToolGateway(cfg).ok).toBe(true);
    expect(reads).toBe(1);
  });
});
