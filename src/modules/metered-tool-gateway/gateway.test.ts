import { describe, expect, it } from "vitest";
import { createMeteredToolGateway, MAX_RECEIPTS } from "./index";
import { STEP, TOOL, TOOLS_BYTES, WORST, balance, baseOptions, fundedLedger, make, stepErr, stepOk, stubGateway } from "./test-kit";

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe("metered-tool-gateway · مسیرِ شاد و رزرو", () => {
  it("بدترین‌هزینه (۴۹۳) رزرو می‌شود، دروازهٔ درونی صدا می‌خورد، هزینهٔ واقعی مصرف و باقیمانده آزاد می‌شود", async () => {
    const { ledger } = await fundedLedger(10_000);
    let seen: number | null = null;
    const { gateway, inputs } = stubGateway(async () => {
      seen = (await balance(ledger)).held;
      return stepOk(120);
    });
    const g = make(ledger, gateway);
    const r = await g.completeStep(STEP);
    expect(r.ok).toBe(true);
    expect(seen).toBe(WORST);
    expect(inputs).toHaveLength(1);
    if (!r.ok) return;
    expect(r.value.metering).toMatchObject({ outcome: "billed", reserved: WORST, charged: 120, shortfall: 0, alarms: [], reservationId: "scope-1.r1", unit: "IRR_MICROS" });
    const b = await balance(ledger);
    expect(b.available).toBe(10_000 - 120);
    expect(b.held).toBe(0);
    expect(b.totals.charged).toBe(120);
  });

  it("رزرو شاملِ بدنهٔ ابزار و هر پیامِ continuation است (نه فقط پیام‌ها)", async () => {
    const { ledger } = await fundedLedger(100_000);
    const cont = [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "نتیجه" },
    ];
    let held = 0;
    const { gateway } = stubGateway(async () => {
      held = (await balance(ledger)).held;
      return stepOk(5);
    });
    await make(ledger, gateway).completeStep({ ...STEP, continuation: cont });
    const parts = [bytes("abcd"), TOOLS_BYTES, ...cont.map((c) => bytes(JSON.stringify(c)))];
    expect(held).toBe(parts.reduce((a, b) => a + b, 0) + 10 * parts.length + 300);
  });

  it("درخواست عیناً به دروازهٔ درونی می‌رسد و options عبور می‌کند", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway, inputs, options } = stubGateway(stepOk(1));
    const ac = new AbortController();
    await make(ledger, gateway).completeStep({ ...STEP, requestId: "rq-1" }, { signal: ac.signal });
    expect(inputs[0]).toEqual({ ...STEP, requestId: "rq-1" });
    expect((options[0] as { signal: AbortSignal }).signal).toBe(ac.signal);
  });

  it("گام‌های پیاپی رزروِ جدا می‌گیرند (r1، r2) و جمع‌ها درست است", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepOk(10));
    const g = make(ledger, gateway);
    await g.completeStep(STEP);
    await g.completeStep(STEP);
    expect(g.receipts().map((r) => r.reservationId)).toEqual(["scope-1.r1", "scope-1.r2"]);
    expect(g.summary()).toMatchObject({ calls: 2, reserved: 2 * WORST, charged: 20, shortfall: 0, needsAttention: false, receiptsTruncated: false, alarms: [] });
    expect(g.summary().outcomes).toMatchObject({ billed: 2, refused: 0 });
  });

  it("گام‌های هم‌زمان شناسهٔ جدا می‌گیرند و هر دو تسویه می‌شوند", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return stepOk(7);
    });
    const g = make(ledger, gateway);
    const rs = await Promise.all([g.completeStep(STEP), g.completeStep(STEP), g.completeStep(STEP)]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(g.receipts().map((r) => r.reservationId)).size).toBe(3);
    expect((await balance(ledger)).totals.charged).toBe(21);
  });

  it("toolFormat و limits از دروازهٔ درونی عبور می‌کنند و پرتاب را به null تبدیل می‌کنند", async () => {
    const { ledger } = await fundedLedger(10);
    const { gateway } = stubGateway(stepOk(1));
    const g = make(ledger, gateway);
    expect(g.toolFormat("legal")).toBe("openai-chat");
    expect(g.limits("legal")).toMatchObject({ maxOutputTokens: 1000, priced: true });
    expect(g.limits("nope")).toBeNull();
    let broken = false;
    const flaky = { ...gateway, limits: (m: string) => { if (broken) throw new Error("sk-SECRET"); return gateway.limits(m); }, toolFormat: () => { if (broken) throw new Error("sk-SECRET"); return "openai-chat" as const; } };
    const g2 = make(ledger, flaky as never);
    broken = true;
    expect(g2.toolFormat("legal")).toBeNull();
    expect(g2.limits("legal")).toBeNull();
  });
});

describe("metered-tool-gateway · ردّ پیش از رزرو (بی‌رزرو، بی‌تماس)", () => {
  const cases: [string, unknown, string][] = [
    ["غیرشیء", "x", "INVALID_REQUEST"],
    ["پیام‌های خالی", { ...STEP, messages: [] }, "INVALID_REQUEST"],
    ["محتوای غیررشته", { ...STEP, messages: [{ role: "user", content: 5 }] }, "INVALID_REQUEST"],
    ["ابزارِ نامعتبر", { ...STEP, tools: [] }, "INVALID_REQUEST"],
    ["ادامهٔ بزرگ‌تر از سقف", { ...STEP, continuation: [{ role: "assistant", content: "x".repeat(400_001) }] }, "INVALID_REQUEST"],
    ["سقفِ خروجیِ بیش از مدل", { ...STEP, maxOutputTokens: 1001 }, "INVALID_REQUEST"],
    ["سقفِ خروجیِ غیرصحیح", { ...STEP, maxOutputTokens: 1.5 }, "INVALID_REQUEST"],
    ["مدلِ ناشناخته", { ...STEP, model: "nope" }, "UNKNOWN_MODEL"],
    ["مدلِ بی‌قیمت", { ...STEP, model: "free" }, "UNPRICED_MODEL"],
    ["ارزِ دیگر", { ...STEP, model: "usd" }, "CURRENCY_MISMATCH"],
  ];
  it.each(cases)("%s ⇒ %s و هیچ رزرو/تماسی نیست", async (_n, input, code) => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway, inputs } = stubGateway(stepOk(1));
    const g = make(ledger, gateway);
    const r = await g.completeStep(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INTERNAL_ERROR");
    expect(r.error.retryable).toBe(false);
    expect(r.error.usage).toBeNull();
    expect(r.error.cost).toBeNull();
    expect(r.error.metering).toMatchObject({ outcome: "refused", reservationId: null, reserved: 0, charged: 0 });
    expect(r.error.metering.refusal?.code).toBe(code);
    expect(inputs).toHaveLength(0);
    const b = await balance(ledger);
    expect(b).toMatchObject({ available: 10_000, held: 0, openReservations: 0 });
    expect(JSON.stringify(r)).not.toContain("abcd");
  });

  it("دروازهٔ درونیِ بی‌قالبِ ابزار (toolFormat=null) ⇒ ردِ INVALID_REQUEST", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway, inputs } = stubGateway(stepOk(1), { format: null });
    const r = await make(ledger, gateway).completeStep(STEP);
    expect(!r.ok && r.error.metering.refusal?.code).toBe("INVALID_REQUEST");
    expect(inputs).toHaveLength(0);
  });

  it("ورودیِ getter/Proxyِ پرتاب‌کننده یا دایره‌ای ⇒ ردّ، بی‌پرتاب", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway, inputs } = stubGateway(stepOk(1));
    const g = make(ledger, gateway);
    const evil = new Proxy({}, { ownKeys: () => { throw new Error("sk-SECRET"); }, get: () => { throw new Error("sk-SECRET"); } });
    const cyc: Record<string, unknown> = { ...STEP };
    cyc["self"] = cyc;
    for (const input of [evil, cyc]) {
      const r = await g.completeStep(input);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("sk-SECRET");
    }
    expect(inputs).toHaveLength(0);
  });

  it("بستنِ TOCTOU: getterی که بار دوم محتوا را بزرگ‌تر می‌دهد، اثری ندارد (عکسِ یک‌باره)", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway, inputs } = stubGateway(stepOk(1));
    let reads = 0;
    const input = { ...STEP, get maxOutputTokens() { reads += 1; return reads === 1 ? 100 : 999; } };
    const r = await make(ledger, gateway).completeStep(input);
    expect(r.ok).toBe(true);
    expect((inputs[0] as { maxOutputTokens: number }).maxOutputTokens).toBe(100);
    expect(r.ok && r.value.metering.reserved).toBe(WORST);
  });

  it("اعتبارِ ناکافی ⇒ INSUFFICIENT_CREDIT بی‌تماس", async () => {
    const { ledger } = await fundedLedger(WORST - 1);
    const { gateway, inputs } = stubGateway(stepOk(1));
    const r = await make(ledger, gateway).completeStep(STEP);
    expect(!r.ok && r.error.metering.refusal).toEqual({ code: "INSUFFICIENT_CREDIT", ledgerCode: "INSUFFICIENT_CREDIT" });
    expect(inputs).toHaveLength(0);
  });

  it("اعتبارِ دقیقاً برابرِ بدترین‌هزینه کافی است", async () => {
    const { ledger } = await fundedLedger(WORST);
    const { gateway } = stubGateway(stepOk(WORST));
    const r = await make(ledger, gateway).completeStep(STEP);
    expect(r.ok && r.value.metering.outcome).toBe("billed");
    expect((await balance(ledger)).available).toBe(0);
  });

  it("استفادهٔ دوبارهٔ scopeId (نمونهٔ دوم روی همان دفتر) ⇒ SCOPE_REUSED بی‌تماس", async () => {
    const { ledger } = await fundedLedger(100_000);
    const a = stubGateway(stepOk(1));
    const b = stubGateway(stepOk(1));
    await make(ledger, a.gateway).completeStep(STEP);
    const r = await make(ledger, b.gateway).completeStep(STEP);
    expect(!r.ok && r.error.metering.refusal?.code).toBe("SCOPE_REUSED");
    expect(b.inputs).toHaveLength(0);
  });

  it("حسابِ ناموجود ⇒ ACCOUNT_NOT_FOUND", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepOk(1));
    const r = await make(ledger, gateway, { account: { tenantId: "x", accountId: "y" } }).completeStep(STEP);
    expect(!r.ok && r.error.metering.refusal?.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("پرتابِ دفتر در reserve ⇒ RESERVE_FAILED بی‌تماس و بی‌نشتِ پیام", async () => {
    const { ledger } = await fundedLedger(10_000);
    const bad = { ...ledger, reserve: () => { throw new Error("sk-SECRET-db"); } } as never;
    const { gateway, inputs } = stubGateway(stepOk(1));
    const r = await make(bad, gateway).completeStep(STEP);
    expect(!r.ok && r.error.metering.refusal?.code).toBe("RESERVE_FAILED");
    expect(inputs).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain("sk-SECRET");
  });
});

describe("metered-tool-gateway · تسویهٔ هزینه", () => {
  it("هزینهٔ واقعی بیش از رزرو ⇒ SHORTFALL با زنگ و needsAttention", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepOk(WORST + 50));
    const g = make(ledger, gateway);
    const r = await g.completeStep(STEP);
    expect(r.ok && r.value.metering).toMatchObject({ outcome: "billed", charged: WORST, shortfall: 50, alarms: ["SHORTFALL"] });
    expect(g.summary()).toMatchObject({ shortfall: 50, needsAttention: true, alarms: ["SHORTFALL"] });
  });

  it("هزینهٔ صفر (قیمت صفر) ⇒ billed با ۰ و رزرو کاملاً آزاد", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepOk(0));
    const r = await make(ledger, gateway).completeStep(STEP);
    expect(r.ok && r.value.metering).toMatchObject({ outcome: "billed", charged: 0 });
    expect(await balance(ledger)).toMatchObject({ available: 10_000, held: 0 });
  });

  it("گامِ موفق بی‌هزینه (cost=null) ⇒ نامعلوم: با forfeit همهٔ رزرو سوخته می‌شود + COST_UNKNOWN", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepOk(null));
    const g = make(ledger, gateway, { onUnknownCost: "forfeit" });
    const r = await g.completeStep(STEP);
    expect(r.ok && r.value.metering).toMatchObject({ outcome: "forfeited", alarms: ["COST_UNKNOWN"] });
    expect((await balance(ledger)).available).toBe(10_000 - WORST);
    expect(g.summary().needsAttention).toBe(true);
  });

  it("همان با release ⇒ کلِ رزرو آزاد می‌شود ولی زنگ می‌ماند", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepOk(null));
    const r = await make(ledger, gateway, { onUnknownCost: "release" }).completeStep(STEP);
    expect(r.ok && r.value.metering).toMatchObject({ outcome: "released", alarms: ["COST_UNKNOWN"] });
    expect((await balance(ledger)).available).toBe(10_000);
  });

  it("گامِ شکست‌خورده با هزینهٔ معلوم (پاسخِ بریده/خراب) ⇒ هزینه مصرف می‌شود (تفاوت با observeCostِ metering)", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepErr("PROVIDER_BAD_RESPONSE", { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, cost: { micros: 250, currency: "IRR", priceVersion: "v" } }));
    const g = make(ledger, gateway);
    const r = await g.completeStep(STEP);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("PROVIDER_BAD_RESPONSE");
    expect(r.error.metering).toMatchObject({ outcome: "billed", charged: 250, alarms: [] });
    expect((await balance(ledger)).available).toBe(10_000 - 250);
  });

  it.each(["TIMEOUT", "ABORTED", "PROVIDER_UNAVAILABLE", "PROVIDER_ERROR", "INTERNAL_ERROR"])("خطای %s بی‌هزینهٔ گزارش‌شده ⇒ نامعلوم (ممکن است تماس رسیده باشد)", async (code) => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepErr(code));
    const r = await make(ledger, gateway, { onUnknownCost: "forfeit" }).completeStep(STEP);
    expect(!r.ok && r.error.metering).toMatchObject({ outcome: "forfeited", alarms: ["COST_UNKNOWN"] });
    expect(!r.ok && r.error.code).toBe(code);
  });

  it.each(["INVALID_REQUEST", "UNKNOWN_MODEL", "INVALID_CONFIG"])("خطای %s اثباتاً بی‌تماس ⇒ released بی‌زنگ", async (code) => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepErr(code));
    const r = await make(ledger, gateway).completeStep(STEP);
    expect(!r.ok && r.error.metering).toMatchObject({ outcome: "released", charged: 0, alarms: [] });
    expect(await balance(ledger)).toMatchObject({ available: 10_000, held: 0 });
  });

  it("ارزِ هزینهٔ گزارش‌شده با ارزِ حساب فرق دارد ⇒ نامعلوم، نه شارژِ عدد", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway({ ...(stepOk(5) as object), value: { ...((stepOk(5) as { value: object }).value), cost: { micros: 5, currency: "USD", priceVersion: "v" } } });
    const r = await make(ledger, gateway).completeStep(STEP);
    expect(r.ok && r.value.metering).toMatchObject({ outcome: "forfeited", charged: 0, alarms: ["COST_UNKNOWN"] });
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "5"])("مبلغِ هزینهٔ ناهنجار %s ⇒ نامعلوم", async (micros) => {
    const { ledger } = await fundedLedger(10_000);
    const ok = stepOk(1) as { ok: true; value: Record<string, unknown> };
    const { gateway } = stubGateway({ ok: true, value: { ...ok.value, cost: { micros, currency: "IRR", priceVersion: "v" } } });
    const r = await make(ledger, gateway).completeStep(STEP);
    expect(r.ok && r.value.metering.alarms).toEqual(["COST_UNKNOWN"]);
  });

  it.each([null, undefined, 5, "x", [], { ok: "yes" }, { ok: true }, { ok: false }])("نتیجهٔ بی‌شکلِ دروازهٔ درونی (%j) ⇒ INTERNAL_ERROR و هزینهٔ نامعلوم", async (bogus) => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(bogus);
    const r = await make(ledger, gateway).completeStep(STEP);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("INTERNAL_ERROR");
    expect(!r.ok && r.error.metering.alarms).toEqual(["COST_UNKNOWN"]);
  });

  it("پرتابِ دروازهٔ درونی ⇒ INTERNAL_ERROR، هزینهٔ نامعلوم، بی‌نشتِ پیام", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(() => { throw new Error("sk-SECRET-gw"); });
    const r = await make(ledger, gateway).completeStep(STEP);
    expect(!r.ok && r.error.metering.outcome).toBe("forfeited");
    expect(JSON.stringify(r)).not.toContain("sk-SECRET");
  });

  it("رزرو پیش از تسویه منقضی شد (ttl کم) ⇒ unbilled با زنگ UNBILLED", async () => {
    const { ledger, clock } = await fundedLedger(10_000);
    const { gateway } = stubGateway(() => { clock.advance(61_000); return stepOk(100); });
    const g = make(ledger, gateway);
    const r = await g.completeStep(STEP);
    expect(r.ok && r.value.metering).toMatchObject({ outcome: "unbilled", charged: 0, alarms: ["UNBILLED"] });
    expect(g.summary().needsAttention).toBe(true);
  });

  it("charge پس از ۳ تلاشِ گذرا ناموفق ⇒ settlement-failed و رزروِ باز (آزادنکردن)", async () => {
    const { ledger } = await fundedLedger(10_000);
    let charges = 0;
    const flaky = { ...ledger, reserve: ledger.reserve.bind(ledger), close: ledger.close.bind(ledger), charge: async () => { charges += 1; return { ok: false as const, error: { code: "STORE_FAILURE" as const, message: "m" } }; } } as never;
    const { gateway } = stubGateway(stepOk(100));
    const g = make(flaky, gateway);
    const r = await g.completeStep(STEP);
    expect(charges).toBe(3);
    expect(r.ok && r.value.metering).toMatchObject({ outcome: "settlement-failed", alarms: ["SETTLEMENT_PENDING"] });
    expect((await balance(ledger)).held).toBe(WORST);
  });

  it("charge با خطای گذرا یک‌بار و سپس موفق ⇒ billed", async () => {
    const { ledger } = await fundedLedger(10_000);
    let n = 0;
    const flaky = { ...ledger, reserve: ledger.reserve.bind(ledger), close: ledger.close.bind(ledger), charge: (i: Parameters<typeof ledger.charge>[0]) => (++n === 1 ? Promise.resolve({ ok: false as const, error: { code: "STORE_FAILURE" as const, message: "m" } }) : ledger.charge(i)) } as never;
    const { gateway } = stubGateway(stepOk(100));
    const r = await make(flaky, gateway).completeStep(STEP);
    expect(r.ok && r.value.metering).toMatchObject({ outcome: "billed", charged: 100 });
  });

  it("close ناموفق پس از charge ⇒ billed با CLOSE_PENDING", async () => {
    const { ledger } = await fundedLedger(10_000);
    const flaky = { ...ledger, reserve: ledger.reserve.bind(ledger), charge: ledger.charge.bind(ledger), close: async () => ({ ok: false as const, error: { code: "VALIDATION_FAILED" as const, message: "m" } }) } as never;
    const { gateway } = stubGateway(stepOk(100));
    const r = await make(flaky, gateway).completeStep(STEP);
    expect(r.ok && r.value.metering).toMatchObject({ outcome: "billed", charged: 100, alarms: ["CLOSE_PENDING"] });
  });

  it("پرتابِ دفتر در charge/close بی‌نشت و بی‌پرتاب (settlement-failed)", async () => {
    const { ledger } = await fundedLedger(10_000);
    const bad = { ...ledger, reserve: ledger.reserve.bind(ledger), charge: () => { throw new Error("sk-SECRET-c"); }, close: () => { throw new Error("sk-SECRET-x"); } } as never;
    const { gateway } = stubGateway(stepOk(100));
    const r = await make(bad, gateway).completeStep(STEP);
    expect(r.ok && r.value.metering.outcome).toBe("settlement-failed");
    expect(JSON.stringify(r)).not.toContain("sk-SECRET");
  });
});

describe("metered-tool-gateway · رسیدها و جمع‌ها", () => {
  it("رسیدها و نتیجه‌ها یخ‌زده‌اند و receipts() کپیِ جدا می‌دهد", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepOk(10));
    const g = make(ledger, gateway);
    const r = await g.completeStep(STEP);
    expect(Object.isFrozen(r)).toBe(true);
    expect(r.ok && Object.isFrozen(r.value.metering)).toBe(true);
    const list = g.receipts();
    expect(Object.isFrozen(list)).toBe(true);
    expect(g.receipts()).not.toBe(list);
    expect(Object.isFrozen(g.summary())).toBe(true);
  });

  it("رسید و نتیجه هرگز متنِ پیام، ابزار یا کلید ندارند", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepOk(10));
    const g = make(ledger, gateway);
    await g.completeStep({ ...STEP, messages: [{ role: "user", content: "راز-کاربر-۱۲۳" }] });
    expect(JSON.stringify(g.receipts())).not.toContain("راز");
    expect(JSON.stringify(g.summary())).not.toContain("راز");
  });

  it("سقفِ رسیدها: فقط قدیمی‌ترین ۲۵۶ نگه داشته می‌شود ولی جمع‌ها کامل‌اند", async () => {
    const { ledger } = await fundedLedger(10_000_000);
    const { gateway } = stubGateway(stepOk(1));
    const g = make(ledger, gateway);
    for (let i = 0; i < MAX_RECEIPTS + 3; i++) await g.completeStep(STEP);
    expect(g.receipts()).toHaveLength(MAX_RECEIPTS);
    expect(g.summary()).toMatchObject({ calls: MAX_RECEIPTS + 3, charged: MAX_RECEIPTS + 3, receiptsTruncated: true });
  });

  it("ردّها هم در جمع‌ها می‌آیند اما needsAttention نمی‌شوند", async () => {
    const { ledger } = await fundedLedger(10_000);
    const { gateway } = stubGateway(stepOk(1));
    const g = make(ledger, gateway);
    await g.completeStep({ ...STEP, model: "free" });
    expect(g.summary()).toMatchObject({ calls: 1, needsAttention: false });
    expect(g.summary().outcomes.refused).toBe(1);
  });

  it("سرریزِ جمع به MAX_SAFE_INTEGER می‌چسبد و needsAttention می‌شود", async () => {
    const { ledger } = await fundedLedger(10_000);
    const huge = Number.MAX_SAFE_INTEGER - 10;
    const { gateway } = stubGateway(stepOk(1));
    // دفترِ ساختگی که رزروِ بسیار بزرگ برمی‌گرداند: فقط مسیرِ جمع را می‌سنجد.
    const fake = { ...ledger, reserve: async () => ({ ok: true as const, value: { amount: huge, replayed: false } }), charge: async () => ({ ok: true as const, value: { charged: 1, shortfall: 0 } }), close: async () => ({ ok: true as const, value: {} }) } as never;
    const g = make(fake, gateway);
    await g.completeStep(STEP);
    await g.completeStep(STEP);
    expect(g.summary()).toMatchObject({ reserved: Number.MAX_SAFE_INTEGER, needsAttention: true });
  });

  it("ابزارِ TOOL از نوعِ مرجع است (محافظِ آزمون)", () => {
    expect(TOOL.name).toBe("t");
  });
});

describe("metered-tool-gateway · ساخت", () => {
  it("createMeteredToolGateway هرگز نمی‌پرتابد (ورودی‌های بی‌شکل)", async () => {
    const { ledger } = await fundedLedger(1);
    const { gateway } = stubGateway(stepOk(1));
    for (const raw of [undefined, null, 5, "x", [], baseOptions(ledger, gateway, { models: undefined }), new Proxy({}, { ownKeys: () => { throw new Error("sk-SECRET"); } })]) {
      const r = createMeteredToolGateway(raw);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("sk-SECRET");
    }
  });
});

describe("metered-tool-gateway · scopeId تکراری با محتوای دیگر (یافتهٔ جهش‌آزمایی)", () => {
  it("همان scopeId با بدترین‌هزینهٔ دیگر ⇒ IDEMPOTENCY_CONFLICT دفتر به SCOPE_REUSED نگاشت می‌شود، نه RESERVE_FAILED", async () => {
    const { ledger } = await fundedLedger(100_000);
    const a = stubGateway(stepOk(1));
    const b = stubGateway(stepOk(1));
    await make(ledger, a.gateway).completeStep(STEP);
    const r = await make(ledger, b.gateway).completeStep({ ...STEP, maxOutputTokens: 50 });
    expect(!r.ok && r.error.metering.refusal).toEqual({ code: "SCOPE_REUSED", ledgerCode: "IDEMPOTENCY_CONFLICT" });
    expect(b.inputs).toHaveLength(0);
  });
});
