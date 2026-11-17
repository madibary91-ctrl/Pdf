import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, MAX_RETRY_AFTER_MS, ProviderFailure } from "./index";
import { makeError } from "./errors";
import { createGateway } from "./gateway";
import type { Completion, GatewayError, GatewayResult } from "./types";
import { OK_REPLY, PRICE, REQUEST, deferred, manualClock, rig } from "./test-kit";

const value = (r: GatewayResult<Completion>): Completion => {
  if (!r.ok) throw new Error(`${r.error.code}: ${JSON.stringify(r.error.issues)}`);
  return r.value;
};
const error = (r: GatewayResult<unknown>): GatewayError => {
  if (r.ok) throw new Error("انتظار خطا بود");
  return r.error;
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("ai-gateway · مسیر موفق", () => {
  it("نتیجهٔ کامل: متن، مصرف، هزینهٔ صحیح، مدل واقعی، شناسه و تأخیر؛ بدون هشدار", async () => {
    const t = rig([{ run: () => OK_REPLY }]);
    t.clock.t = 5000;
    const res = value(await t.gw.complete({ ...REQUEST, requestId: "req-1" }));
    expect(res).toEqual({
      text: "پاسخ آزمایشی",
      finishReason: "stop",
      model: "m1",
      provider: "p1",
      servedModel: "served-model-1",
      requestId: "req-1",
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      // ۱۰۰۰×۳٬۰۰۰٬۰۰۰ + ۵۰۰×۱۵٬۰۰۰٬۰۰۰ = ۱۰٫۵×۱۰⁹ ⇒ ۱۰٬۵۰۰ خرد-واحد
      cost: { micros: 10_500, currency: "IRR", priceVersion: "test-prices-v1" },
      latencyMs: 0,
      warnings: [],
    });
  });

  it("به ارائه‌دهنده می‌رسد: نام مدل ارائه‌دهنده، دمای پیش‌فرض صریحِ ۰، توقف‌ها، پیام‌های ثابت و سیگنالِ فعال", async () => {
    const t = rig();
    value(await t.gw.complete({ ...REQUEST, stopSequences: ["###"], temperature: 0.7 }));
    const [first] = t.provider.calls;
    expect(first).toMatchObject({ model: "provider-model-1", temperature: 0.7, stopSequences: ["###"], maxOutputTokens: 100, messages: [{ role: "user", content: "سلام" }] });
    expect(first?.signal.aborted).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.messages)).toBe(true);
    expect(Object.isFrozen(first?.messages[0])).toBe(true);
  });

  it("دمای پیش‌فرض ۰ و توقف‌های پیش‌فرض تهی صراحتاً فرستاده می‌شوند (نه undefined)", async () => {
    const t = rig();
    value(await t.gw.complete(REQUEST));
    expect(t.provider.calls[0]).toMatchObject({ temperature: 0, stopSequences: [] });
  });

  it("پاسخ تهی/غیرتهی: متن عیناً برمی‌گردد (بدون trim)", async () => {
    const t = rig([{ reply: { ...OK_REPLY, text: "  x \n" } }]);
    expect(value(await t.gw.complete(REQUEST)).text).toBe("  x \n");
  });

  it("تأخیر از ساعت تزریقی: کف عدد صحیح؛ ساعت پس‌رونده ⇒ ۰", async () => {
    const t = rig([
      { run: () => { t.clock.t += 1234.9; return OK_REPLY; } },
      { run: () => { t.clock.t -= 500; return OK_REPLY; } },
    ]);
    expect(value(await t.gw.complete(REQUEST)).latencyMs).toBe(1234);
    expect(value(await t.gw.complete(REQUEST)).latencyMs).toBe(0);
  });

  it("limits(): حدهای مدل و قیمت‌دار بودن؛ ناشناخته/غیرمتن ⇒ null (حتی نام‌های prototype)", () => {
    const t = rig();
    expect(t.gw.limits("m1")).toEqual({ maxInputChars: 10_000, maxOutputTokens: 4096, priced: true });
    expect(rig([], {}, { price: null }).gw.limits("m1")?.priced).toBe(false);
    for (const n of ["nope", "__proto__", "constructor", "toString", "", 5 as unknown as string]) expect(t.gw.limits(n)).toBeNull();
  });
});

describe("ai-gateway · هشدارها (هیچ ناهنجاری‌ای بی‌صدا نیست)", () => {
  it("نبودن مصرف ⇒ USAGE_MISSING، هزینه null (نه ۰)", async () => {
    const t = rig([{ reply: { text: "x", finishReason: "stop" } }]);
    const r = value(await t.gw.complete(REQUEST));
    expect(r.usage).toBeNull();
    expect(r.cost).toBeNull();
    expect(r.warnings).toEqual(["USAGE_MISSING"]);
  });

  it("مدل بدون قیمت ⇒ UNPRICED با مصرف سالم و هزینهٔ null", async () => {
    const t = rig([{ reply: OK_REPLY }], {}, { price: null });
    const r = value(await t.gw.complete(REQUEST));
    expect(r.usage?.totalTokens).toBe(1500);
    expect(r.cost).toBeNull();
    expect(r.warnings).toEqual(["UNPRICED"]);
  });

  it("پاسخ بریده ⇒ OUTPUT_TRUNCATED؛ پاسخ تهی/فقط‌فاصله ⇒ EMPTY_OUTPUT؛ ترکیب به ترتیب ثابت", async () => {
    const t = rig([{ reply: { ...OK_REPLY, finishReason: "length" } }, { reply: { ...OK_REPLY, text: " \n" } }, { reply: { text: "", finishReason: "length" } }], {}, { price: null });
    expect(value(await t.gw.complete(REQUEST)).warnings).toEqual(["UNPRICED", "OUTPUT_TRUNCATED"]);
    expect(value(await t.gw.complete(REQUEST)).warnings).toEqual(["UNPRICED", "EMPTY_OUTPUT"]);
    expect(value(await t.gw.complete(REQUEST)).warnings).toEqual(["USAGE_MISSING", "UNPRICED", "OUTPUT_TRUNCATED", "EMPTY_OUTPUT"]);
  });

  it("content_filter و other هشدار نمی‌سازند ولی در finishReason می‌مانند", async () => {
    const t = rig([{ reply: { ...OK_REPLY, finishReason: "content_filter" } }, { reply: { ...OK_REPLY, finishReason: "other" } }]);
    for (const f of ["content_filter", "other"]) {
      const r = value(await t.gw.complete(REQUEST));
      expect(r.finishReason).toBe(f);
      expect(r.warnings).toEqual([]);
    }
  });
});

describe("ai-gateway · نگاشت خطاهای ارائه‌دهنده (بی‌نشت)", () => {
  const SECRET = "sk-LIVE-SECRET-123 https://internal.example/v1 پرسش‌محرمانه";

  it.each([
    ["rate_limited", "PROVIDER_RATE_LIMITED", true],
    ["unavailable", "PROVIDER_UNAVAILABLE", true],
    ["auth", "PROVIDER_AUTH", false],
    ["rejected", "PROVIDER_REJECTED", false],
  ] as const)("ProviderFailure(%s) ⇒ %s (retryable=%s)", async (kind, code, retryable) => {
    const t = rig([{ fail: new ProviderFailure(kind, { cause: new Error(SECRET) }) }]);
    const e = error(await t.gw.complete(REQUEST));
    expect(e).toMatchObject({ code, retryable, warnings: [] });
    expect(JSON.stringify(e)).not.toContain("SECRET");
    expect(JSON.stringify(e)).not.toContain("internal.example");
    expect("retryAfterMs" in e).toBe(false);
  });

  it("retryAfterMs فقط برای rate_limited/unavailable و فقط وقتی معتبر باشد", async () => {
    const mk = (kind: "rate_limited" | "unavailable" | "auth" | "rejected", ms: number | undefined) => new ProviderFailure(kind, ms === undefined ? {} : { retryAfterMs: ms });
    const t = rig([
      { fail: mk("rate_limited", 1500) },
      { fail: mk("unavailable", 0) },
      { fail: mk("rate_limited", MAX_RETRY_AFTER_MS) },
      { fail: mk("rate_limited", MAX_RETRY_AFTER_MS + 1) },
      { fail: mk("rate_limited", -1) },
      { fail: mk("rate_limited", 1.5) },
      { fail: mk("rate_limited", Number.NaN) },
      { fail: mk("auth", 1000) },
      { fail: mk("rejected", 1000) },
    ]);
    const got: Array<number | undefined> = [];
    for (let i = 0; i < 9; i++) got.push(error(await t.gw.complete(REQUEST)).retryAfterMs);
    expect(got).toEqual([1500, 0, MAX_RETRY_AFTER_MS, undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it("هر استثنای دیگر (Error، رشته، null، شیء) ⇒ PROVIDER_ERROR ثابت و غیرقابل‌تلاش؛ پیام خام نمی‌رسد", async () => {
    const t = rig([{ fail: new Error(SECRET) }, { fail: SECRET }, { fail: null }, { fail: { message: SECRET } }, { fail: new TypeError(SECRET) }]);
    for (let i = 0; i < 5; i++) {
      const e = error(await t.gw.complete(REQUEST));
      expect(e).toMatchObject({ code: "PROVIDER_ERROR", retryable: false });
      expect(JSON.stringify(e)).not.toContain("SECRET");
      expect(JSON.stringify(e)).not.toContain("پرسش‌محرمانه");
    }
  });

  it("پرتاب هم‌زمان (غیر async) از complete هم گرفته می‌شود", async () => {
    const provider = { complete: () => { throw new Error(SECRET); } };
    const g = createGateway({ providers: { p: provider }, models: { m: { provider: "p", providerModel: "x", maxInputChars: 100, maxOutputTokens: 10, price: null } }, clock: manualClock() });
    if (!g.ok) throw new Error("config");
    const e = error(await g.value.complete({ model: "m", messages: [{ role: "user", content: "a" }], maxOutputTokens: 1 }));
    expect(e.code).toBe("PROVIDER_ERROR");
    expect(JSON.stringify(e)).not.toContain("SECRET");
  });

  it("ProviderFailure با kind ناشناخته (JS) ⇒ PROVIDER_ERROR", async () => {
    const bogus = new ProviderFailure("auth");
    (bogus as unknown as { kind: string }).kind = "weird";
    const t = rig([{ fail: bogus }]);
    expect(error(await t.gw.complete(REQUEST)).code).toBe("PROVIDER_ERROR");
  });
});

describe("ai-gateway · پاسخ نامعتبر ارائه‌دهنده", () => {
  const bads: Array<[string, unknown]> = [
    ["null", null],
    ["رشته", "text"],
    ["آرایه", []],
    ["بدون text", { finishReason: "stop" }],
    ["text غیرمتن", { text: 5, finishReason: "stop" }],
    ["بدون finishReason", { text: "x" }],
    ["finishReason ناشناخته", { text: "x", finishReason: "tool_calls" }],
    ["finishReason غیرمتن", { text: "x", finishReason: 1 }],
    ["usage غیرشیء", { text: "x", finishReason: "stop", usage: 5 }],
    ["usage منفی", { text: "x", finishReason: "stop", usage: { inputTokens: -1, outputTokens: 0 } }],
    ["usage اعشاری", { text: "x", finishReason: "stop", usage: { inputTokens: 1.5, outputTokens: 0 } }],
    ["usage ناقص", { text: "x", finishReason: "stop", usage: { inputTokens: 1 } }],
    ["usage بیش از سقف", { text: "x", finishReason: "stop", usage: { inputTokens: 1_000_000_001, outputTokens: 0 } }],
    ["model تهی", { text: "x", finishReason: "stop", model: "" }],
    ["model بلند", { text: "x", finishReason: "stop", model: "a".repeat(201) }],
    ["model غیرمتن", { text: "x", finishReason: "stop", model: 3 }],
  ];
  it.each(bads)("%s ⇒ PROVIDER_BAD_RESPONSE با issues", async (_n, raw) => {
    const t = rig([{ reply: raw }]);
    const e = error(await t.gw.complete(REQUEST));
    expect(e).toMatchObject({ code: "PROVIDER_BAD_RESPONSE", retryable: false });
    expect(e.issues?.length).toBeGreaterThan(0);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]?.outcome).toBe("PROVIDER_BAD_RESPONSE");
  });

  it("مرز معتبر: usage صفر و سقف ۱۰⁹، مدل ۲۰۰ نویسه", async () => {
    const t = rig([
      { reply: { text: "x", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } } },
      { reply: { text: "x", finishReason: "stop", usage: { inputTokens: 1_000_000_000, outputTokens: 1_000_000_000 }, model: "a".repeat(200) } },
    ]);
    expect(value(await t.gw.complete(REQUEST)).cost?.micros).toBe(0);
    const r = value(await t.gw.complete(REQUEST));
    expect(r.usage?.totalTokens).toBe(2_000_000_000);
    expect(r.cost?.micros).toBe(3_000_000_000 + 15_000_000_000);
  });

  it("مصرفِ معتبر در پاسخِ خراب «نجات» و برای هزینه ثبت می‌شود (نه خطا، نه از دست رفته)", async () => {
    const t = rig([{ reply: { text: 5, finishReason: "stop", usage: { inputTokens: 1000, outputTokens: 500 } } }]);
    const e = error(await t.gw.complete(REQUEST));
    expect(e.code).toBe("PROVIDER_BAD_RESPONSE");
    expect(t.events[0]).toMatchObject({ usage: { totalTokens: 1500 }, cost: { micros: 10_500 }, finishReason: null, servedModel: null });
  });

  it("پاسخ با getter پرتاب‌کننده هم پرتاب نمی‌کند", async () => {
    const hostile = { get text(): string { throw new Error("boom"); }, finishReason: "stop" };
    const t = rig([{ reply: hostile }]);
    expect(error(await t.gw.complete(REQUEST)).code).toBe("PROVIDER_BAD_RESPONSE");
  });
});

describe("ai-gateway · مهلت و لغو", () => {
  it("مهلت: TIMEOUT قابل‌تلاش؛ سیگنال ارائه‌دهنده فعال؛ تایمر پاک؛ مهلتِ درخواست > مدل > پیش‌فرض", async () => {
    const t = rig([{ hang: true }, { hang: true }, { hang: true }], {}, { timeoutMs: 700 });
    const p = t.gw.complete({ ...REQUEST, timeoutMs: 250 });
    await tick();
    expect(t.timers.pending).toBe(1);
    t.timers.advance(249);
    expect(t.provider.calls[0]?.signal.aborted).toBe(false);
    t.timers.advance(1);
    const e = error(await p);
    expect(e).toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(t.provider.calls[0]?.signal.aborted).toBe(true);
    expect(t.timers.pending).toBe(0);

    const p2 = t.gw.complete(REQUEST);
    await tick();
    t.timers.advance(700);
    expect(error(await p2).code).toBe("TIMEOUT");

    const only = rig([{ hang: true }]);
    const p3 = only.gw.complete(REQUEST);
    await tick();
    expect(only.timers.setCalls[0]).toBe(60_000);
    only.timers.advance(60_000);
    expect(error(await p3).code).toBe("TIMEOUT");
  });

  it("پاسخِ دیرهنگام پس از مهلت نادیده گرفته می‌شود و rejection کنترل‌نشده نمی‌سازد", async () => {
    const unhandled: unknown[] = [];
    const h = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", h);
    try {
      const d = deferred<unknown>();
      const t = rig([{ run: () => d.promise }, { run: () => d.promise }]);
      const p = t.gw.complete(REQUEST);
      await tick();
      t.timers.advance(60_000);
      expect(error(await p).code).toBe("TIMEOUT");
      d.reject(new Error("late failure"));
      await tick();
      await tick();
      const d2 = deferred<unknown>();
      const t2 = rig([{ run: () => d2.promise }]);
      const p2 = t2.gw.complete(REQUEST);
      await tick();
      t2.timers.advance(60_000);
      expect(error(await p2).code).toBe("TIMEOUT");
      d2.resolve(OK_REPLY);
      await tick();
      expect(unhandled).toEqual([]);
      expect(t2.events).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", h);
    }
  });

  it("سیگنال از پیش لغوشده: ABORTED بدون فراخوانی ارائه‌دهنده و بدون رویداد", async () => {
    const t = rig();
    const c = new AbortController();
    c.abort();
    expect(error(await t.gw.complete(REQUEST, { signal: c.signal }))).toMatchObject({ code: "ABORTED", retryable: false });
    expect(t.provider.calls).toHaveLength(0);
    expect(t.events).toHaveLength(0);
    expect(t.timers.setCalls).toHaveLength(0);
  });

  it("لغو حین کار: ABORTED، سیگنال ارائه‌دهنده فعال، تایمر پاک، رویداد ABORTED ثبت می‌شود", async () => {
    const t = rig([{ hang: true }]);
    const c = new AbortController();
    const p = t.gw.complete(REQUEST, { signal: c.signal });
    await tick();
    c.abort();
    expect(error(await p).code).toBe("ABORTED");
    expect(t.provider.calls[0]?.signal.aborted).toBe(true);
    expect(t.timers.pending).toBe(0);
    expect(t.events.map((e) => e.outcome)).toEqual(["ABORTED"]);
  });

  it("پس از موفقیت، شنونده‌ای روی سیگنال بیرونی نمی‌ماند و لغوِ بعدی بی‌اثر است", async () => {
    const t = rig();
    const c = new AbortController();
    const added: string[] = [];
    const orig = c.signal.removeEventListener.bind(c.signal);
    c.signal.removeEventListener = ((type: string, ...rest: unknown[]) => { added.push(type); return (orig as (...a: unknown[]) => void)(type, ...rest); }) as typeof c.signal.removeEventListener;
    value(await t.gw.complete(REQUEST, { signal: c.signal }));
    expect(added).toContain("abort");
    expect(t.provider.calls[0]?.signal.aborted).toBe(false);
    c.abort();
    expect(t.provider.calls[0]?.signal.aborted).toBe(false);
  });

  it("options نامعتبر: signal غیر AbortSignal یا options غیرشیء ⇒ INVALID_REQUEST بدون فراخوانی", async () => {
    const t = rig();
    for (const o of [{ signal: {} }, { signal: null }, { signal: "x" }, 5, null, "x"]) {
      expect(error(await t.gw.complete(REQUEST, o as never)).code).toBe("INVALID_REQUEST");
    }
    expect(t.provider.calls).toHaveLength(0);
  });
});

describe("ai-gateway · رویداد مصرف", () => {
  it("برای هر فراخوانیِ انجام‌شده دقیقاً یک رویداد؛ ناموفق هم ثبت می‌شود؛ اعتبارسنجی‌نشده ثبت نمی‌شود", async () => {
    const t = rig([{ reply: OK_REPLY }, { fail: new ProviderFailure("rate_limited") }, { reply: { text: 1 } }]);
    await t.gw.complete({ ...REQUEST, requestId: "a" });
    await t.gw.complete({ ...REQUEST, requestId: "b" });
    await t.gw.complete({ ...REQUEST, requestId: "c" });
    await t.gw.complete({ model: "nope", messages: [], maxOutputTokens: 1 });
    await t.gw.complete({ ...REQUEST, maxOutputTokens: 0 });
    expect(t.events.map((e) => `${e.requestId}:${e.outcome}`)).toEqual(["a:ok", "b:PROVIDER_RATE_LIMITED", "c:PROVIDER_BAD_RESPONSE"]);
    expect(t.provider.calls).toHaveLength(3);
  });

  it("محتوای رویداد: همهٔ فیلدها؛ مصرف ناشناخته null؛ هرگز متن پیام/پاسخ", async () => {
    const t = rig([{ run: () => { t.clock.t += 40; return OK_REPLY; } }, { fail: new ProviderFailure("unavailable") }]);
    const startedAt = t.clock.t;
    await t.gw.complete({ messages: [{ role: "user", content: "CANARY-پرسش" }], model: "m1", maxOutputTokens: 5, requestId: "r1" });
    await t.gw.complete({ ...REQUEST, requestId: "r2" });
    expect(t.events[0]).toEqual({
      requestId: "r1", model: "m1", provider: "p1", providerModel: "provider-model-1", servedModel: "served-model-1",
      startedAtMs: startedAt, latencyMs: 40, outcome: "ok", finishReason: "stop",
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }, cost: { micros: 10_500, currency: "IRR", priceVersion: "test-prices-v1" },
    });
    expect(t.events[1]).toMatchObject({ requestId: "r2", outcome: "PROVIDER_UNAVAILABLE", finishReason: null, usage: null, cost: null, servedModel: null });
    for (const e of t.events) {
      const s = JSON.stringify(e);
      expect(s).not.toContain("CANARY");
      expect(s).not.toContain("پاسخ آزمایشی");
      expect(Object.isFrozen(e)).toBe(true);
    }
  });

  it("رویداد بدون requestId ⇒ null", async () => {
    const t = rig();
    await t.gw.complete(REQUEST);
    expect(t.events[0]?.requestId).toBeNull();
  });

  it("بدون usageSink همه‌چیز کار می‌کند", async () => {
    const t = rig([{ reply: OK_REPLY }], { usageSink: undefined });
    expect(value(await t.gw.complete(REQUEST)).warnings).toEqual([]);
  });

  it("مصرف رویداد و نتیجه یک مقدار و تغییرناپذیرند", async () => {
    const t = rig();
    const r = value(await t.gw.complete(REQUEST));
    expect(r.usage).toEqual(t.events[0]?.usage);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.usage)).toBe(true);
    expect(Object.isFrozen(r.cost)).toBe(true);
    expect(Object.isFrozen(r.warnings)).toBe(true);
  });
});

describe("ai-gateway · شکست ثبت مصرف (هشدار صریح، پاسخ از دست نمی‌رود)", () => {
  it.each([
    ["پرتاب هم‌زمان", () => { throw new Error("sink down"); }],
    ["رد شدن Promise", () => Promise.reject(new Error("sink down"))],
  ] as const)("sink با %s ⇒ USAGE_SINK_FAILED کنار پاسخ", async (_n, record) => {
    const t = rig([{ reply: OK_REPLY }, { fail: new ProviderFailure("auth") }], { usageSink: { record } });
    const r = value(await t.gw.complete(REQUEST));
    expect(r.text).toBe("پاسخ آزمایشی");
    expect(r.warnings).toEqual(["USAGE_SINK_FAILED"]);
    const e = error(await t.gw.complete(REQUEST));
    expect(e).toMatchObject({ code: "PROVIDER_AUTH", warnings: ["USAGE_SINK_FAILED"] });
    expect(JSON.stringify(e)).not.toContain("sink down");
  });

  it("sink گیرکرده ⇒ پس از sinkTimeoutMs هشدار USAGE_SINK_TIMEOUT؛ تایمر پاک", async () => {
    const t = rig([{ reply: OK_REPLY }], { usageSink: { record: () => new Promise<void>(() => undefined) }, sinkTimeoutMs: 300 });
    const p = t.gw.complete(REQUEST);
    await tick();
    expect(t.timers.setCalls).toEqual([60_000, 300]);
    t.timers.advance(300);
    expect(value(await p).warnings).toEqual(["USAGE_SINK_TIMEOUT"]);
    expect(t.timers.pending).toBe(0);
  });

  it("هشدارهای مصرف با هشدارهای sink ترکیب می‌شوند (به ترتیب)", async () => {
    const t = rig([{ reply: { text: "x", finishReason: "length" } }], { usageSink: { record: () => { throw new Error("x"); } } }, { price: null });
    expect(value(await t.gw.complete(REQUEST)).warnings).toEqual(["USAGE_MISSING", "UNPRICED", "OUTPUT_TRUNCATED", "USAGE_SINK_FAILED"]);
  });
});

describe("ai-gateway · پایداری: هرگز پرتاب نمی‌کند", () => {
  it("ساعت خراب (پرتاب/NaN/Infinity/غیرعدد) ⇒ INTERNAL_ERROR، نه پرتاب و نه زمان جعلی", async () => {
    for (const bad of [() => { throw new Error("clock"); }, () => Number.NaN, () => Infinity, () => "1" as unknown as number]) {
      const t = rig([{ reply: OK_REPLY }], { clock: { nowMs: bad } });
      expect(error(await t.gw.complete(REQUEST))).toMatchObject({ code: "INTERNAL_ERROR", retryable: false });
    }
  });

  it("درخواست با getter پرتاب‌کننده یا Proxy خصمانه ⇒ INVALID_REQUEST", async () => {
    const t = rig();
    const getter = { get model(): string { throw new Error("boom"); } };
    const proxy = new Proxy({}, { ownKeys() { throw new Error("boom"); } });
    for (const x of [getter, proxy]) expect(error(await t.gw.complete(x)).code).toBe("INVALID_REQUEST");
    expect(t.provider.calls).toHaveLength(0);
  });

  it("جدول خطا: هر کد پیام فارسیِ یکتا دارد؛ فقط TIMEOUT و محدودیت نرخ و در دسترس‌نبودن قابل‌تلاش‌اند", () => {
    expect(ERROR_CODES).toHaveLength(12);
    const messages = ERROR_CODES.map((c) => makeError(c).message);
    expect(new Set(messages).size).toBe(12);
    for (const m of messages) expect(m).toMatch(/[\u0600-\u06FF]/);
    expect(ERROR_CODES.filter((c) => makeError(c).retryable).sort()).toEqual(["PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE", "TIMEOUT"]);
  });

  it("درخواست‌های هم‌زمان مستقل‌اند: پاسخ هر کدام به خودش برمی‌گردد", async () => {
    const t = rig(Array.from({ length: 25 }, (_, i) => ({ run: async () => { await tick(); return { text: `reply-${i}`, finishReason: "stop", usage: { inputTokens: i, outputTokens: 0 } }; } })));
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => t.gw.complete({ ...REQUEST, requestId: `c${i}` })));
    const texts = rs.map((r) => value(r).text);
    expect(new Set(texts).size).toBe(25);
    expect(t.events).toHaveLength(25);
    for (const e of t.events) expect(e.outcome).toBe("ok");
    expect(t.timers.pending).toBe(0);
  });
});

describe("ai-gateway · پیکربندی «گرفته‌شده» است و ماژول بی‌I/O", () => {
  it("ویرایش پیکربندی/ارائه‌دهنده/ساعت پس از ساخت اثری ندارد", async () => {
    const provider = { calls: 0, complete: async () => { provider.calls++; return OK_REPLY; } };
    const clock = manualClock();
    const models = { m1: { provider: "p1", providerModel: "pm", maxInputChars: 100, maxOutputTokens: 50, price: { ...PRICE } } };
    const config = { providers: { p1: provider }, models, clock };
    const g = createGateway(config);
    if (!g.ok) throw new Error("config");
    const hijack = { calls: 0, complete: async () => ({ text: "HIJACK", finishReason: "stop" }) };
    (provider as { complete: unknown }).complete = hijack.complete;
    models.m1.maxOutputTokens = 1_000_000;
    models.m1.price.inputMicrosPerMTok = 0;
    (clock as { nowMs: () => number }).nowMs = () => Number.NaN;
    (config.providers as Record<string, unknown>)["evil"] = hijack;
    const ok = value(await g.value.complete({ model: "m1", messages: [{ role: "user", content: "a" }], maxOutputTokens: 50 }));
    expect(ok.text).toBe("پاسخ آزمایشی");
    expect(ok.cost?.micros).toBe(10_500);
    expect(error(await g.value.complete({ model: "m1", messages: [{ role: "user", content: "a" }], maxOutputTokens: 51 })).code).toBe("INVALID_REQUEST");
  });

  it("ویرایش timers و usageSink تزریقی پس از ساخت اثری ندارد", async () => {
    const t = rig();
    const timers = t.timers as { setTimeout: unknown };
    const original = t.timers.setTimeout;
    timers.setTimeout = () => { throw new Error("timers hijacked"); };
    value(await t.gw.complete(REQUEST));
    expect(t.events).toHaveLength(1);
    timers.setTimeout = original;

    const events: string[] = [];
    const sinkB = { record: () => void events.push("original") };
    const g = createGateway({ providers: { p1: { complete: async () => OK_REPLY } }, models: { m1: { provider: "p1", providerModel: "pm", maxInputChars: 100, maxOutputTokens: 50, price: null } }, clock: manualClock(), usageSink: sinkB });
    if (!g.ok) throw new Error("config");
    (sinkB as { record: unknown }).record = () => events.push("hijacked");
    await g.value.complete({ model: "m1", messages: [{ role: "user", content: "a" }], maxOutputTokens: 5 });
    expect(events).toEqual(["original"]);
  });

  it("کد منبع ماژول: بدون ساعت سیستم، تصادف، محیط، شبکه، فایل و import از ماژول‌های دیگر", () => {
    const dir = __dirname;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-kit.ts");
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of [/Date\.now/, /new Date\(/, /Math\.random/, /process\.env/, /\bfetch\(/, /node:/, /from "@\/modules\//, /from "@\/db/, /performance\.now/, /\bXMLHttpRequest\b/]) {
        expect(forbidden.test(src), `${f} ${String(forbidden)}`).toBe(false);
      }
    }
  });
});
