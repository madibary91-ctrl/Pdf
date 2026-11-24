import { describe, expect, it } from "vitest";
import { createMeteredToolGateway } from "./index";
import { MODELS, baseOptions, fundedLedger, stepOk, stubGateway } from "./test-kit";

async function build(over: Record<string, unknown> = {}, gwOver: Parameters<typeof stubGateway>[1] = {}) {
  const { ledger } = await fundedLedger(1000);
  const { gateway } = stubGateway(stepOk(1), gwOver);
  return createMeteredToolGateway(baseOptions(ledger, gateway, over));
}
const issuesOf = (r: Awaited<ReturnType<typeof build>>): string[] => (r.ok ? [] : [...r.error.issues]);

describe("metered-tool-gateway · پیکربندی", () => {
  it("پیکربندیِ درست ساخته می‌شود و نتیجه شکلِ ToolGateway + receipts/summary دارد", async () => {
    const r = await build();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(["completeStep", "limits", "receipts", "summary", "toolFormat"]);
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(r.value.summary()).toMatchObject({ calls: 0, needsAttention: false });
  });

  it.each(["fallbacks", "maxProviderCalls", "timers", "whatever"])("کلیدِ %s پذیرفته نمی‌شود (دروازهٔ ابزار تلاشِ دوباره و جایگزین ندارد)", async (k) => {
    const r = await build({ [k]: k === "fallbacks" ? { legal: ["free"] } : 1 });
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join()).toContain("کلید ناشناخته");
  });

  it.each([undefined, null, 5, "x", []])("پیکربندیِ %j ⇒ INVALID_CONFIG", (raw) => {
    const r = createMeteredToolGateway(raw);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("INVALID_CONFIG");
  });

  it.each([
    ["scopeId", undefined],
    ["scopeId", "has space"],
    ["scopeId", "x".repeat(97)],
    ["reservationTtlMs", 0],
    ["reservationTtlMs", 1.5],
    ["perMessageOverheadTokens", undefined],
    ["perMessageOverheadTokens", -1],
    ["perMessageOverheadTokens", 1001],
    ["onUnknownCost", undefined],
    ["onUnknownCost", "ignore"],
    ["currency", "irr"],
    ["currency", undefined],
    ["models", {}],
    ["models", undefined],
    ["account", { tenantId: "", accountId: "a" }],
  ])("%s=%j ⇒ رد با نامِ کلید", async (k, v) => {
    const r = await build({ [k]: v });
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join()).toContain(k);
  });

  it("دفتر یا دروازهٔ بی‌تابع ⇒ رد؛ همهٔ مشکل‌ها یک‌جا گزارش می‌شود", async () => {
    const r1 = await build({ ledger: {} });
    expect(issuesOf(r1).join()).toContain("ledger");
    const r2 = await build({ gateway: { completeStep: () => null }, scopeId: "bad id" });
    expect(issuesOf(r2).join()).toContain("gateway");
    expect(issuesOf(r2).join()).toContain("scopeId");
  });

  it("دروازهٔ ساده (فقط complete) را نمی‌پذیرد: این ماژول ToolGateway می‌خواهد", async () => {
    const r = await build({ gateway: { complete: () => null, limits: () => null } });
    expect(issuesOf(r).join()).toContain("completeStep");
  });

  it("جدولِ مدل‌ها باید با دروازه یکی باشد: مدلِ ناموجود، وضعیتِ قیمت، سقفِ خروجی", async () => {
    expect(issuesOf(await build({ models: { ...MODELS, ghost: { price: MODELS.legal.price, maxOutputTokens: 10 } } })).join()).toContain("مدل در دروازه نیست");
    expect(issuesOf(await build({ models: { legal: { price: null, maxOutputTokens: 1000 } } })).join()).toContain("وضعیتِ قیمت");
    expect(issuesOf(await build({ models: { legal: { price: MODELS.legal.price, maxOutputTokens: 999 } } })).join()).toContain("maxOutputTokens با دروازه");
  });

  it("limits پرتاب‌کنندهٔ دروازه ⇒ رد، بی‌نشتِ پیام", async () => {
    const r = await build({}, { limits: () => { throw new Error("sk-SECRET-limits"); } });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("sk-SECRET");
  });

  it("خطا فقط نامِ کلید دارد: مقدارِ رشتهٔ سرّی و کلیدِ بلند در issues نمی‌آید", async () => {
    const r = await build({ ["k".repeat(100)]: "sk-SECRET-value", scopeId: "sk-SECRET bad" });
    expect(r.ok).toBe(false);
    const s = JSON.stringify(r);
    expect(s).not.toContain("sk-SECRET");
    expect(s).not.toContain("k".repeat(41));
    expect(!r.ok && Object.isFrozen(r.error)).toBe(true);
  });
});
