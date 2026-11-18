import { describe, expect, it } from "vitest";
import { createMeteredGateway, SETTLE_ATTEMPTS } from "./index";
import type { MeteredGateway, MeteredResult } from "./index";
import { ACCOUNT, TENANT, UNIT, WORST, REQUEST, balance, config, errResult, fakeGateway, flakyLedger, fundedLedger, okResult, report } from "./test-kit";

function make(c: Parameters<typeof createMeteredGateway>[0]): MeteredGateway {
  const r = createMeteredGateway(c);
  if (!r.ok) throw new Error(`createMeteredGateway failed: ${r.error.issues.join("; ")}`);
  return r.value;
}
const meta = (r: MeteredResult) => (r.ok ? r.value.metering : r.error.metering);
const KEY = { tenantId: TENANT, accountId: ACCOUNT };

describe("metering · مسیر شاد: رزرو ← تماس ← مصرف ← آزادسازی", () => {
  it("بدترین‌هزینه رزرو، هزینهٔ واقعی مصرف و باقیمانده آزاد می‌شود؛ نتیجهٔ دروازه بی‌تغییر + metering", async () => {
    const { ledger } = await fundedLedger(10_000);
    const gw = fakeGateway([okResult(120)]);
    const r = await make(config(ledger, gw)).complete(REQUEST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("t");
    expect(r.value.cost).toEqual({ micros: 120, currency: "IRR", priceVersion: "test-v1" });
    expect(r.value.metering).toEqual({ outcome: "billed", unit: UNIT, reservationId: "scope-1.r1", reserved: WORST, charged: 120, shortfall: 0, alarms: [] });
    const b = await balance(ledger);
    expect(b.available).toBe(10_000 - 120);
    expect(b.held).toBe(0);
    expect(b.totals.charged).toBe(120);
    expect(gw.calls).toHaveLength(1);
  });

  it("پیش از تماس، رزرو دقیقاً بدترین‌هزینه است (۱۴ + ۳×۱۰۰ = ۳۱۴) و در لحظهٔ تماس نگه داشته شده", async () => {
    const { ledger } = await fundedLedger(10_000);
    let heldDuring = -1;
    const gw = fakeGateway(async () => {
      heldDuring = (await balance(ledger)).held;
      return okResult(50);
    });
    await make(config(ledger, gw)).complete(REQUEST);
    expect(heldDuring).toBe(WORST);
  });

  it("هزینهٔ صفر (قیمت صفر) = billed با charged ۰؛ کل رزرو برمی‌گردد", async () => {
    const { ledger } = await fundedLedger(1000);
    const r = await make(config(ledger, fakeGateway([okResult(0)]))).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "billed", charged: 0, shortfall: 0 });
    expect((await balance(ledger)).available).toBe(1000);
  });

  it("درخواست عیناً (عکس یک‌بارخوان) به دروازهٔ درونی می‌رسد، نه همان شیء و با همهٔ کلیدها (temperature، requestId، …)", async () => {
    const { ledger } = await fundedLedger(10_000);
    const gw = fakeGateway([okResult(1)]);
    const input = { ...REQUEST, messages: [{ role: "user", content: "abcd" }], temperature: 0.5, requestId: "req-1", timeoutMs: 5000 };
    await make(config(ledger, gw)).complete(input);
    expect(gw.calls[0]).toEqual(input);
    expect(gw.calls[0]).not.toBe(input);
  });

  it("signal فراخواننده به دروازهٔ درونی می‌رسد", async () => {
    const { ledger } = await fundedLedger(10_000);
    const gw = fakeGateway([okResult(1)]);
    const ac = new AbortController();
    await make(config(ledger, gw)).complete(REQUEST, { signal: ac.signal });
    expect(gw.signals[0]).toBe(ac.signal);
  });

  it("نتیجه و رسید فریز‌اند؛ رسید هرگز متن پیام یا پاسخ را نمی‌آورد", async () => {
    const { ledger } = await fundedLedger(10_000);
    const secret = "متن-محرمانهٔ-پرسش";
    const r = await make(config(ledger, fakeGateway([okResult(5, { text: "پاسخ-محرمانه" })]))).complete({ ...REQUEST, messages: [{ role: "user", content: secret }] });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(meta(r))).toBe(true);
    expect(JSON.stringify(meta(r))).not.toContain(secret);
    expect(JSON.stringify(meta(r))).not.toContain("پاسخ-محرمانه");
  });

  it("limits به دروازهٔ درونی واگذار می‌شود؛ پرتاب ⇒ null", async () => {
    const { ledger } = await fundedLedger(1);
    const gw = fakeGateway([], { maxInputChars: 7, maxOutputTokens: 9, priced: true });
    expect(make(config(ledger, gw)).limits("main")).toEqual({ maxInputChars: 7, maxOutputTokens: 9, priced: true });
    const thrower = { complete: gw.complete, limits: () => { throw new Error("x"); } };
    expect(make(config(ledger, thrower)).limits("main")).toBeNull();
  });
});

describe("metering · ردِ پیش از تماس: دروازهٔ درونی هرگز صدا زده نمی‌شود و دفتر دست‌نخورده می‌ماند", () => {
  const cases: Array<[string, Record<string, unknown> | unknown, string]> = [
    ["ورودی شیء نیست", "x", "INVALID_REQUEST"],
    ["ورودی null", null, "INVALID_REQUEST"],
    ["messages نیست", { model: "main", maxOutputTokens: 5 }, "INVALID_REQUEST"],
    ["messages تهی", { model: "main", messages: [], maxOutputTokens: 5 }, "INVALID_REQUEST"],
    ["content رشته نیست", { model: "main", messages: [{ role: "user", content: 5 }], maxOutputTokens: 5 }, "INVALID_REQUEST"],
    ["بیش از ۶۴ پیام", { model: "main", messages: Array.from({ length: 65 }, () => ({ role: "user", content: "a" })), maxOutputTokens: 5 }, "INVALID_REQUEST"],
    ["maxOutputTokens صفر", { ...REQUEST, maxOutputTokens: 0 }, "INVALID_REQUEST"],
    ["maxOutputTokens اعشاری", { ...REQUEST, maxOutputTokens: 1.5 }, "INVALID_REQUEST"],
    ["maxOutputTokens بیش از سقف مدل", { ...REQUEST, maxOutputTokens: 1001 }, "INVALID_REQUEST"],
    ["maxOutputTokens ناموجود", { model: "main", messages: REQUEST.messages }, "INVALID_REQUEST"],
    ["model رشته نیست", { ...REQUEST, model: 7 }, "INVALID_REQUEST"],
    ["مدل ناشناخته", { ...REQUEST, model: "nope" }, "UNKNOWN_MODEL"],
    ["مدل بی‌قیمت", { ...REQUEST, model: "free" }, "UNPRICED_MODEL"],
    ["مدل با ارز دیگر", { ...REQUEST, model: "usd" }, "CURRENCY_MISMATCH"],
  ];
  for (const [name, input, code] of cases) {
    it(`${name} ⇒ ${code}`, async () => {
      const { ledger, store } = await fundedLedger(10_000);
      const gw = fakeGateway([okResult(1)]);
      const r = await make(config(ledger, gw)).complete(input);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("INTERNAL_ERROR");
      expect(r.error.retryable).toBe(false);
      expect(r.error.metering).toMatchObject({ outcome: "refused", reservationId: null, reserved: 0, charged: 0, refusal: { code } });
      expect(gw.calls).toHaveLength(0);
      expect((await store.journal(KEY)).length).toBe(1); // فقط اعطای نخستین
      expect((await balance(ledger)).available).toBe(10_000);
    });
  }

  it("جایگزینِ بی‌قیمتِ زنجیره ⇒ UNPRICED_MODEL (سقفش نامعلوم است)", async () => {
    const { ledger } = await fundedLedger(10_000);
    const gw = fakeGateway([okResult(1)]);
    const r = await make(config(ledger, gw, { fallbacks: { main: ["free"] } })).complete(REQUEST);
    expect(meta(r).refusal?.code).toBe("UNPRICED_MODEL");
    expect(gw.calls).toHaveLength(0);
  });

  it("اعتبار ناکافی: یک خرد کمتر از بدترین‌هزینه رد می‌شود؛ دقیقاً برابر پذیرفته می‌شود", async () => {
    const low = await fundedLedger(WORST - 1);
    const gw1 = fakeGateway([okResult(1)]);
    const r1 = await make(config(low.ledger, gw1)).complete(REQUEST);
    expect(meta(r1).refusal).toEqual({ code: "INSUFFICIENT_CREDIT", ledgerCode: "INSUFFICIENT_CREDIT" });
    expect(gw1.calls).toHaveLength(0);
    expect((await balance(low.ledger)).available).toBe(WORST - 1);

    const exact = await fundedLedger(WORST);
    const r2 = await make(config(exact.ledger, fakeGateway([okResult(1)]))).complete(REQUEST);
    expect(meta(r2).outcome).toBe("billed");
  });

  it("حساب ناموجود ⇒ ACCOUNT_NOT_FOUND", async () => {
    const { ledger } = await fundedLedger(1000);
    const gw = fakeGateway([okResult(1)]);
    const r = await make(config(ledger, gw, { account: { tenantId: "other", accountId: "x" } })).complete(REQUEST);
    expect(meta(r).refusal).toEqual({ code: "ACCOUNT_NOT_FOUND", ledgerCode: "ACCOUNT_NOT_FOUND" });
    expect(gw.calls).toHaveLength(0);
  });

  it("واحد حساب ناهمخوان (حساب با واحد دیگر) ⇒ RESERVE_FAILED با ledgerCode", async () => {
    const { ledger } = await fundedLedger(1000);
    const gw = fakeGateway([okResult(1)]);
    const r = await make(config(ledger, gw, { currency: "EUR", models: { main: { price: { currency: "EUR", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, version: "v" }, maxOutputTokens: 1000 } } })).complete(REQUEST);
    expect(meta(r).refusal).toEqual({ code: "RESERVE_FAILED", ledgerCode: "UNIT_MISMATCH" });
    expect(gw.calls).toHaveLength(0);
  });

  it("سرریز برآورد (قیمت بسیار بزرگ × تماس‌ها) ⇒ ESTIMATE_OVERFLOW", async () => {
    const { ledger } = await fundedLedger(1000);
    const huge = { price: { currency: "IRR", inputMicrosPerMTok: 1_000_000_000_000, outputMicrosPerMTok: 1_000_000_000_000, version: "h" }, maxOutputTokens: 1_000_000_000 };
    const gw = fakeGateway([okResult(1)]);
    const r = await make(config(ledger, gw, { models: { main: huge }, maxProviderCalls: 20 })).complete({ ...REQUEST, maxOutputTokens: 1_000_000_000 });
    expect(meta(r).refusal?.code).toBe("ESTIMATE_OVERFLOW");
    expect(gw.calls).toHaveLength(0);
  });
});

describe("metering · TOCTOU و یکتایی", () => {
  it("getter/Proxy که در هر خواندن مقدار دیگری بدهد: فقط یک‌بار خوانده می‌شود و همان به دروازه می‌رسد", async () => {
    const { ledger } = await fundedLedger(10_000);
    const gw = fakeGateway([okResult(1)]);
    let reads = 0;
    const input = { model: "main", maxOutputTokens: 100, messages: [{ role: "user", get content() { reads++; return reads === 1 ? "abcd" : "x".repeat(50_000); } }] };
    const r = await make(config(ledger, gw)).complete(input);
    expect(reads).toBe(1);
    expect((gw.calls[0] as { messages: { content: string }[] }).messages[0]?.content).toBe("abcd");
    expect(meta(r).reserved).toBe(WORST);
  });

  it("getterِ پرتاب‌کننده ⇒ INVALID_REQUEST، بی‌پرتاب", async () => {
    const { ledger } = await fundedLedger(10_000);
    const gw = fakeGateway([okResult(1)]);
    const input = { get model(): string { throw new Error("x"); } };
    const r = await make(config(ledger, gw)).complete(input);
    expect(meta(r).refusal?.code).toBe("INVALID_REQUEST");
    expect(gw.calls).toHaveLength(0);
  });

  it("scopeId تکراری روی همان حساب (نمونهٔ دیگر): SCOPE_REUSED، بی‌تماس و بی‌اثر", async () => {
    const { ledger, store } = await fundedLedger(10_000);
    const first = make(config(ledger, fakeGateway([okResult(100)])));
    expect(meta(await first.complete(REQUEST)).outcome).toBe("billed");
    const before = (await store.journal(KEY)).length;
    const gw2 = fakeGateway([okResult(1)]);
    const r = await make(config(ledger, gw2)).complete(REQUEST); // همان scope و همان n=1 و همان مبلغ ⇒ replayed
    expect(meta(r)).toMatchObject({ outcome: "refused", reservationId: null, refusal: { code: "SCOPE_REUSED" } });
    expect(gw2.calls).toHaveLength(0);
    expect((await store.journal(KEY)).length).toBe(before);
    expect((await balance(ledger)).available).toBe(10_000 - 100);
  });

  it("scopeId تکراری با مبلغ متفاوت (IDEMPOTENCY_CONFLICT) هم SCOPE_REUSED است", async () => {
    const { ledger } = await fundedLedger(10_000);
    await make(config(ledger, fakeGateway([okResult(100)]))).complete(REQUEST);
    const gw2 = fakeGateway([okResult(1)]);
    const r = await make(config(ledger, gw2)).complete({ ...REQUEST, maxOutputTokens: 50 });
    expect(meta(r).refusal).toEqual({ code: "SCOPE_REUSED", ledgerCode: "IDEMPOTENCY_CONFLICT" });
    expect(gw2.calls).toHaveLength(0);
  });

  it("تماس‌های پیاپی و هم‌زمان روی یک نمونه شناسهٔ جدا می‌گیرند (r1…rN)", async () => {
    const { ledger, store } = await fundedLedger(100_000);
    const gw = make(config(ledger, fakeGateway(() => okResult(10))));
    const rs = await Promise.all(Array.from({ length: 8 }, () => gw.complete(REQUEST)));
    const ids = rs.map((r) => meta(r).reservationId).sort();
    expect(ids).toEqual(Array.from({ length: 8 }, (_, i) => `scope-1.r${i + 1}`).sort());
    expect(rs.every((r) => meta(r).outcome === "billed")).toBe(true);
    const b = await balance(ledger);
    expect(b.available).toBe(100_000 - 80);
    expect(b.held).toBe(0);
    const state = await store.read(KEY);
    expect(Object.keys(state?.reservations ?? {})).toHaveLength(8);
  });

  it("ردِ پیش از رزرو شمارنده را مصرف می‌کند اما شناسه‌ای نمی‌سوزاند که بعداً تداخل کند", async () => {
    const { ledger } = await fundedLedger(10_000);
    const gw = make(config(ledger, fakeGateway(() => okResult(10))));
    expect(meta(await gw.complete("bad")).outcome).toBe("refused"); // n=1
    expect(meta(await gw.complete(REQUEST)).reservationId).toBe("scope-1.r2");
  });
});

describe("metering · تسویه طبق ADR-0020 تصمیم ۵ (ندانستن ≠ صفر)", () => {
  it("اثباتاً بی‌تماس (INVALID_REQUEST درونی): آزاد، بی‌زنگ، موجودی دست‌نخورده", async () => {
    const { ledger } = await fundedLedger(10_000);
    const r = await make(config(ledger, fakeGateway([errResult("INVALID_REQUEST")]))).complete(REQUEST);
    expect(r.ok).toBe(false);
    expect(meta(r)).toMatchObject({ outcome: "released", charged: 0, alarms: [] });
    const b = await balance(ledger);
    expect([b.available, b.held]).toEqual([10_000, 0]);
  });

  it("نتیجهٔ موفق بی‌هزینه (cost=null) نامعلوم است؛ forfeit: کل رزرو سوخته + COST_UNKNOWN", async () => {
    const { ledger } = await fundedLedger(10_000);
    const r = await make(config(ledger, fakeGateway([okResult(null)]), { onUnknownCost: "forfeit" })).complete(REQUEST);
    expect(r.ok).toBe(true);
    expect(meta(r)).toMatchObject({ outcome: "forfeited", charged: 0, alarms: ["COST_UNKNOWN"] });
    const b = await balance(ledger);
    expect(b.available).toBe(10_000 - WORST);
    expect(b.totals.forfeited).toBe(WORST);
  });

  it("همان با release: کل رزرو برمی‌گردد ولی COST_UNKNOWN بالاست", async () => {
    const { ledger } = await fundedLedger(10_000);
    const r = await make(config(ledger, fakeGateway([okResult(null)]), { onUnknownCost: "release" })).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "released", alarms: ["COST_UNKNOWN"] });
    expect((await balance(ledger)).available).toBe(10_000);
  });

  for (const [name, step] of [
    ["TIMEOUT بی‌گزارش", errResult("TIMEOUT")],
    ["PROVIDER_UNAVAILABLE بی‌گزارش", errResult("PROVIDER_UNAVAILABLE")],
    ["ABORTED بی‌گزارش", errResult("ABORTED")],
    ["INTERNAL_ERROR بی‌گزارش", errResult("INTERNAL_ERROR")],
    ["پرتاب دروازهٔ درونی", new Error("boom")],
    ["نتیجهٔ بی‌شکل (null)", null],
    ["نتیجهٔ بی‌شکل (ok غیرمنطقی)", { ok: "yes" }],
  ] as const) {
    it(`${name}: نامعلوم ⇒ سیاست forfeit + COST_UNKNOWN و خطای قابل‌فهم`, async () => {
      const { ledger } = await fundedLedger(10_000);
      const gw = fakeGateway([step as unknown]);
      const r = await make(config(ledger, gw)).complete(REQUEST);
      expect(r.ok).toBe(false);
      expect(meta(r)).toMatchObject({ outcome: "forfeited", alarms: ["COST_UNKNOWN"] });
      if (!r.ok) expect(typeof r.error.message).toBe("string");
      expect((await balance(ledger)).held).toBe(0);
    });
  }

  it("نتیجهٔ بی‌شکل ⇒ خطای INTERNAL_ERROR با metering (نه ok و نه پرتاب)", async () => {
    const { ledger } = await fundedLedger(10_000);
    const r = await make(config(ledger, fakeGateway([null]))).complete(REQUEST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INTERNAL_ERROR");
  });

  it("خطای دارای هزینهٔ معلوم (گزارش با تلاش رسیده) مصرف می‌شود، حتی وقتی نتیجه خطاست", async () => {
    const { ledger } = await fundedLedger(10_000);
    const rep = report({ spend: [{ currency: "IRR", micros: 77 }], stoppedBecause: "attempts_exhausted" });
    const r = await make(config(ledger, fakeGateway([errResult("TIMEOUT", { report: rep })]), { maxProviderCalls: 3 })).complete(REQUEST);
    expect(r.ok).toBe(false);
    expect(meta(r)).toMatchObject({ outcome: "billed", charged: 77, alarms: [] });
    expect((await balance(ledger)).available).toBe(10_000 - 77);
  });

  it("گزارش تاب‌آور: مجموع هزینهٔ همهٔ تلاش‌ها (نه فقط موفق) مصرف می‌شود؛ رزرو = بدترین × maxProviderCalls", async () => {
    const { ledger } = await fundedLedger(10_000);
    const rep = report({ spend: [{ currency: "IRR", micros: 500 }] });
    const r = await make(config(ledger, fakeGateway([okResult(120, { report: rep })]), { maxProviderCalls: 3 })).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "billed", reserved: WORST * 3, charged: 500 });
    expect((await balance(ledger)).available).toBe(10_000 - 500);
  });

  it("گزارش با costUnknownAttempts>0 ⇒ نامعلوم (نه جمع بخشی)", async () => {
    const { ledger } = await fundedLedger(10_000);
    const rep = report({ costUnknownAttempts: 1 });
    const r = await make(config(ledger, fakeGateway([okResult(120, { report: rep })]), { onUnknownCost: "release" })).complete(REQUEST);
    // کفِ معلوم (۱۰۰ از ردیف هزینه) مصرف می‌شود؛ فقط بخش نامعلوم تابع سیاست release است.
    expect(meta(r)).toMatchObject({ outcome: "released", charged: 100, alarms: ["COST_UNKNOWN"] });
    expect((await balance(ledger)).available).toBe(10_000 - 100);
  });

  it("کفِ معلوم + forfeit: ۱۰۰ مصرف و باقیماندهٔ رزرو سوخته (کل رزرو از دست می‌رود)", async () => {
    const { ledger } = await fundedLedger(10_000);
    const rep = report({ costUnknownAttempts: 1 });
    const r = await make(config(ledger, fakeGateway([okResult(120, { report: rep })]), { onUnknownCost: "forfeit" })).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "forfeited", charged: 100, alarms: ["COST_UNKNOWN"] });
    const b = await balance(ledger);
    expect(b.available).toBe(10_000 - WORST);
    expect([b.totals.charged, b.totals.forfeited]).toEqual([100, WORST - 100]);
  });

  it("کفِ معلومِ بیش از رزرو: shortfall هم در مسیر نامعلوم بالا می‌آید", async () => {
    const { ledger } = await fundedLedger(10_000);
    const rep = report({ costUnknownAttempts: 1, spend: [{ currency: "IRR", micros: WORST + 5 }] });
    const r = await make(config(ledger, fakeGateway([okResult(1, { report: rep })]), { onUnknownCost: "release" })).complete(REQUEST);
    expect(meta(r)).toMatchObject({ charged: WORST, shortfall: 5, alarms: ["COST_UNKNOWN", "SHORTFALL"] });
  });

  it("شکستِ charge در مسیر نامعلوم: settlement-failed با COST_UNKNOWN و SETTLEMENT_PENDING؛ close صدا زده نمی‌شود", async () => {
    const f = await fundedLedger(10_000);
    const flaky = flakyLedger(f.ledger, { charge: { fail: 99 } });
    const rep = report({ costUnknownAttempts: 1 });
    const r = await make(config(flaky, fakeGateway([okResult(1, { report: rep })]))).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "settlement-failed", alarms: ["COST_UNKNOWN", "SETTLEMENT_PENDING"] });
    expect(flaky.count["close"]).toBe(0);
  });

  it("انقضا در مسیر نامعلومِ دارای کف ⇒ unbilled با COST_UNKNOWN و UNBILLED", async () => {
    const f = await fundedLedger(10_000);
    const rep = report({ costUnknownAttempts: 1 });
    const gw = fakeGateway(() => {
      f.clock.advance(60_001);
      return okResult(1, { report: rep });
    });
    const r = await make(config(f.ledger, gw)).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "unbilled", alarms: ["COST_UNKNOWN", "UNBILLED"] });
  });

  it("گزارش بی‌تلاشِ رسیده (مثلاً INVALID_REQUEST بر همهٔ زنجیره) ⇒ اثباتاً بی‌هزینه ⇒ released بی‌زنگ", async () => {
    const { ledger } = await fundedLedger(10_000);
    const rep = report({ attempts: [{ index: 1, model: "main", modelAttempt: 1, waitedMs: 0, outcome: "INVALID_REQUEST", reachedProvider: false, usage: null, cost: null, latencyMs: 0 }], spend: [], costUnknownAttempts: 0, stoppedBecause: "non_retryable" });
    const r = await make(config(ledger, fakeGateway([errResult("INVALID_REQUEST", { report: rep })]))).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "released", alarms: [] });
  });

  it("هزینه از رزرو بیشتر: مصرف تا سقف رزرو، مازاد shortfall + SHORTFALL؛ موجودی هرگز منفی نمی‌شود", async () => {
    const { ledger } = await fundedLedger(10_000);
    const r = await make(config(ledger, fakeGateway([okResult(WORST + 86)]))).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "billed", reserved: WORST, charged: WORST, shortfall: 86, alarms: ["SHORTFALL"] });
    const b = await balance(ledger);
    expect(b.available).toBe(10_000 - WORST);
    expect(b.totals.shortfall).toBe(86);
  });

  it("ارز گزارش‌شده ناهمخوان با واحد حساب ⇒ نامعلوم (تبدیلی نیست)", async () => {
    const { ledger } = await fundedLedger(10_000);
    const rep = report({ spend: [{ currency: "USD", micros: 5 }] });
    const r = await make(config(ledger, fakeGateway([okResult(5, { report: rep })]), { onUnknownCost: "release" })).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "released", alarms: ["COST_UNKNOWN"] });
  });
});

describe("metering · شکست‌های دفتر هنگام تسویه (ADR-0020 تصمیم ۶): تکرارپذیر، کران‌دار، هرگز بی‌نشان", () => {
  it("شکستِ گذرای charge تا SETTLE_ATTEMPTS-1 بار: تکرار می‌شود و billed می‌شود", async () => {
    const f = await fundedLedger(10_000);
    const flaky = flakyLedger(f.ledger, { charge: { fail: SETTLE_ATTEMPTS - 1 } });
    const r = await make(config(flaky, fakeGateway([okResult(120)]))).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "billed", charged: 120, alarms: [] });
    expect(flaky.count["charge"]).toBe(SETTLE_ATTEMPTS);
    expect((await balance(f.ledger)).totals.charged).toBe(120); // دقیقاً یک بار ثبت شد
  });

  it("charge همیشه شکست‌خورده: settlement-failed + SETTLEMENT_PENDING؛ رزرو باز می‌ماند (آزاد نمی‌شود) و close صدا زده نمی‌شود", async () => {
    const f = await fundedLedger(10_000);
    const flaky = flakyLedger(f.ledger, { charge: { fail: 99 } });
    const r = await make(config(flaky, fakeGateway([okResult(120)]))).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "settlement-failed", charged: 0, alarms: ["SETTLEMENT_PENDING"] });
    expect(flaky.count["charge"]).toBe(SETTLE_ATTEMPTS);
    expect(flaky.count["close"]).toBe(0);
    expect((await balance(f.ledger)).held).toBe(WORST);
  });

  it("خطای غیرگذرا در charge (مثلاً RESERVATION_NOT_FOUND) تکرار نمی‌شود", async () => {
    const f = await fundedLedger(10_000);
    const flaky = flakyLedger(f.ledger, { charge: { fail: 99, code: "RESERVATION_NOT_FOUND" } });
    const r = await make(config(flaky, fakeGateway([okResult(120)]))).complete(REQUEST);
    expect(meta(r).outcome).toBe("settlement-failed");
    expect(flaky.count["charge"]).toBe(1);
  });

  it("پرتابِ دفتر در charge مثل شکست گذرا تکرار می‌شود", async () => {
    const f = await fundedLedger(10_000);
    const flaky = flakyLedger(f.ledger, { charge: { fail: 1, mode: "throw" } });
    const r = await make(config(flaky, fakeGateway([okResult(120)]))).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "billed", charged: 120 });
  });

  it("close همیشه شکست‌خورده پس از charge موفق: billed + CLOSE_PENDING و هزینه ثبت‌شده", async () => {
    const f = await fundedLedger(10_000);
    const flaky = flakyLedger(f.ledger, { close: { fail: 99 } });
    const r = await make(config(flaky, fakeGateway([okResult(120)]))).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "billed", charged: 120, alarms: ["CLOSE_PENDING"] });
    const b = await balance(f.ledger);
    expect(b.totals.charged).toBe(120);
    expect(b.held).toBe(WORST - 120); // تا سررسید نگه داشته می‌شود
  });

  it("close شکست‌خوردهٔ هزینهٔ نامعلوم: settlement-failed با هر دو زنگ", async () => {
    const f = await fundedLedger(10_000);
    const flaky = flakyLedger(f.ledger, { close: { fail: 99 } });
    const r = await make(config(flaky, fakeGateway([okResult(null)]))).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "settlement-failed", alarms: ["COST_UNKNOWN", "SETTLEMENT_PENDING"] });
  });

  it("شکستِ reserve: بی‌تلاش دوباره، بی‌تماس، RESERVE_FAILED با ledgerCode", async () => {
    const f = await fundedLedger(10_000);
    const flaky = flakyLedger(f.ledger, { reserve: { fail: 99 } });
    const gw = fakeGateway([okResult(1)]);
    const r = await make(config(flaky, gw)).complete(REQUEST);
    expect(meta(r).refusal).toEqual({ code: "RESERVE_FAILED", ledgerCode: "STORE_FAILURE" });
    expect(flaky.count["reserve"]).toBe(1);
    expect(gw.calls).toHaveLength(0);
  });

  it("پرتابِ دفتر در reserve ⇒ RESERVE_FAILED، بی‌تماس، بی‌پرتاب", async () => {
    const f = await fundedLedger(10_000);
    const flaky = flakyLedger(f.ledger, { reserve: { fail: 99, mode: "throw" } });
    const gw = fakeGateway([okResult(1)]);
    const r = await make(config(flaky, gw)).complete(REQUEST);
    expect(meta(r).refusal).toEqual({ code: "RESERVE_FAILED" });
    expect(gw.calls).toHaveLength(0);
  });

  it("انقضای رزرو در حین تماس: هزینه شد ولی صورتحساب نشد ⇒ unbilled + UNBILLED (نشتِ آشکار)", async () => {
    const f = await fundedLedger(10_000);
    const gw = fakeGateway(() => {
      f.clock.advance(60_001);
      return okResult(120);
    });
    const r = await make(config(f.ledger, gw)).complete(REQUEST);
    expect(r.ok).toBe(true);
    expect(meta(r)).toMatchObject({ outcome: "unbilled", charged: 0, alarms: ["UNBILLED"] });
    expect((await balance(f.ledger)).available).toBe(10_000);
  });

  it("انقضا + هزینهٔ نامعلوم + forfeit ⇒ unbilled با COST_UNKNOWN و UNBILLED", async () => {
    const f = await fundedLedger(10_000);
    const gw = fakeGateway(() => {
      f.clock.advance(60_001);
      return okResult(null);
    });
    const r = await make(config(f.ledger, gw)).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "unbilled", alarms: ["COST_UNKNOWN", "UNBILLED"] });
  });

  it("انقضا + اثباتاً بی‌تماس ⇒ released بی‌زنگ (چیزی از کاربر کم نشد)", async () => {
    const f = await fundedLedger(10_000);
    const gw = fakeGateway(() => {
      f.clock.advance(60_001);
      return errResult("INVALID_REQUEST");
    });
    const r = await make(config(f.ledger, gw)).complete(REQUEST);
    expect(meta(r)).toMatchObject({ outcome: "released", alarms: [] });
  });
});
