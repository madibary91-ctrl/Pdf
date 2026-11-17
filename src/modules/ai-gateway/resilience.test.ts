import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, ProviderFailure, createGateway, createResilientGateway } from "./index";
import type { Gateway, ResilientCompletion, ResilientError, ResilientResult } from "./index";
import { resolveConfig } from "./config";
import { makeError } from "./errors";
import { completeObserved } from "./gateway";
import { BASE_POLICY, drive, rrig, seqRandom, tick } from "./resilience-kit";
import type { RRig } from "./resilience-kit";
import { ManualTimers, OK_REPLY, PRICE, REQUEST, manualClock, scriptedProvider } from "./test-kit";
import type { Step } from "./test-kit";

const CANARY = "CANARY-نشت-نباید-شود";
const val = (r: ResilientResult): ResilientCompletion => {
  if (!r.ok) throw new Error(`${r.error.code}: ${JSON.stringify(r.error.report.stoppedBecause)}`);
  return r.value;
};
const err = (r: ResilientResult): ResilientError => {
  if (r.ok) throw new Error("انتظار خطا بود");
  return r.error;
};
const unavailable = (): Step => ({ fail: new ProviderFailure("unavailable") });
const rate = (retryAfterMs?: number): Step => ({ fail: new ProviderFailure("rate_limited", retryAfterMs === undefined ? {} : { retryAfterMs }) });
const auth = (): Step => ({ fail: new ProviderFailure("auth") });
const ok: Step = { reply: OK_REPLY };
const outcomes = (r: ResilientCompletion | ResilientError) => r.report.attempts.map((a) => a.outcome);
const run = (t: RRig, input: unknown = REQUEST, options?: { signal?: AbortSignal }, step = 100) => drive(t.gw.complete(input, options), t, step);
const CHAIN = { fallbacks: { m1: ["m2", "m3"] } };
const ONE_SHOT = { maxAttemptsPerModel: 1, retryOn: [] as string[] };

describe("ai-gateway · تاب‌آوری · مسیر بی‌تلاش", () => {
  it("موفقیتِ نخست: نتیجهٔ هسته + report؛ بدون هشدار؛ یک رویداد؛ هزینهٔ کل = هزینهٔ همان تلاش", async () => {
    const t = rrig({ m1: { steps: [ok] } });
    const res = val(await run(t, { ...REQUEST, requestId: "req-1" }));
    expect(res).toEqual({
      text: "پاسخ آزمایشی",
      finishReason: "stop",
      model: "m1",
      provider: "p-m1",
      servedModel: "served-model-1",
      requestId: "req-1",
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      cost: { micros: 10_500, currency: "IRR", priceVersion: "test-prices-v1" },
      latencyMs: 0,
      warnings: [],
      report: {
        requestedModel: "m1",
        attempts: [
          { index: 1, model: "m1", modelAttempt: 1, waitedMs: 0, outcome: "ok", reachedProvider: true, usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }, cost: { micros: 10_500, currency: "IRR", priceVersion: "test-prices-v1" }, latencyMs: 0 },
        ],
        spend: [{ currency: "IRR", micros: 10_500 }],
        costUnknownAttempts: 0,
        stoppedBecause: "success",
      },
    });
    expect(t.events).toHaveLength(1);
    expect(t.timers.pending).toBe(0);
  });

  it("هشدارهای خودِ هسته (مثلاً USAGE_MISSING، OUTPUT_TRUNCATED) روی موفقیتِ بی‌تلاش حفظ می‌شوند و RETRIED نمی‌آید", async () => {
    const t = rrig({ m1: { steps: [{ reply: { text: "x", finishReason: "length" } }] } });
    const res = val(await run(t));
    expect(res.warnings).toEqual(["USAGE_MISSING", "OUTPUT_TRUNCATED"]);
    expect(res.report.costUnknownAttempts).toBe(1);
    expect(res.report.spend).toEqual([]);
  });

  it("درخواست نامعتبر روی مدل اصلی: هیچ تلاش/جایگزینی نیست؛ صفر فراخوانی؛ خطای هسته با report تهی", async () => {
    const t = rrig({ m1: { steps: [ok] }, m2: { steps: [ok] }, m3: { steps: [ok] } }, CHAIN);
    const e = err(await run(t, { ...REQUEST, maxOutputTokens: 999_999, messages: [{ role: "user", content: CANARY }] }));
    expect(e.code).toBe("INVALID_REQUEST");
    expect(e.retryable).toBe(false);
    expect(e.report).toEqual({ requestedModel: null, attempts: [], spend: [], costUnknownAttempts: 0, stoppedBecause: "non_retryable" });
    expect(t.totalCalls()).toBe(0);
    expect(JSON.stringify(e)).not.toContain(CANARY);
  });

  it("مدل ناشناخته و ورودی‌های غیرشیء: UNKNOWN_MODEL/INVALID_REQUEST بی‌پرتاب", async () => {
    const t = rrig({ m1: { steps: [ok] } });
    expect(err(await run(t, { ...REQUEST, model: "constructor" })).code).toBe("UNKNOWN_MODEL");
    for (const bad of [null, undefined, 5, "x", [], () => 1]) expect(err(await t.gw.complete(bad)).code).toBe("INVALID_REQUEST");
    expect(t.totalCalls()).toBe(0);
  });

  it("options.signal نامعتبر ⇒ INVALID_REQUEST بی‌فراخوانی", async () => {
    const t = rrig({ m1: { steps: [ok] } });
    for (const options of [{ signal: "x" }, { signal: {} }, 5, null]) {
      const e = err(await t.gw.complete(REQUEST, options as never));
      expect(e.code).toBe("INVALID_REQUEST");
      expect(e.issues).toEqual(["options.signal باید AbortSignal باشد."]);
      // همین لایه رد می‌کند (نه هسته): تلاشی ثبت نمی‌شود
      expect(e.report).toEqual({ requestedModel: null, attempts: [], spend: [], costUnknownAttempts: 0, stoppedBecause: "non_retryable" });
    }
    expect(t.totalCalls()).toBe(0);
  });
});

describe("ai-gateway · تاب‌آوری · تلاش دوباره و backoff", () => {
  it("یک شکست گذرا ⇒ تلاش دوباره پس از ۱۰۰ms؛ دو رویداد؛ RETRIED؛ هزینه: فقط موفق، ولی شکست در «نامعلوم»", async () => {
    const t = rrig({ m1: { steps: [unavailable(), ok] } });
    const res = val(await run(t));
    expect(t.providers["p-m1"]?.calls).toHaveLength(2);
    expect(res.warnings).toEqual(["RETRIED"]);
    expect(res.report.attempts.map((a) => [a.modelAttempt, a.waitedMs, a.outcome, a.reachedProvider])).toEqual([
      [1, 0, "PROVIDER_UNAVAILABLE", true],
      [2, 100, "ok", true],
    ]);
    expect(res.report.attempts[0]).toMatchObject({ usage: null, cost: null });
    expect(res.report.costUnknownAttempts).toBe(1);
    expect(res.report.spend).toEqual([{ currency: "IRR", micros: 10_500 }]);
    expect(t.events.map((e) => e.outcome)).toEqual(["PROVIDER_UNAVAILABLE", "ok"]);
    expect(t.timers.pending).toBe(0);
  });

  it("نمایی: ۱۰۰ سپس ۲۰۰؛ با سقفِ ۵۰۰ ⇒ ۴۰۰ سپس ۵۰۰", async () => {
    const t1 = rrig({ m1: { steps: [unavailable(), unavailable(), ok] } });
    expect(val(await run(t1)).report.attempts.map((a) => a.waitedMs)).toEqual([0, 100, 200]);
    const t2 = rrig({ m1: { steps: [unavailable(), unavailable(), ok] } }, { backoff: { baseDelayMs: 400, maxDelayMs: 500, jitter: "none" } });
    expect(val(await run(t2)).report.attempts.map((a) => a.waitedMs)).toEqual([0, 400, 500]);
    // انتظارِ واقعی همان است که گزارش شد (تایمر تزریقی دیده)
    expect(t2.timerCalls().filter((ms) => ms < 60_000)).toEqual([400, 500]);
  });

  it("پایهٔ صفر ⇒ بی‌انتظار و بی‌تایمر", async () => {
    const t = rrig({ m1: { steps: [unavailable(), ok] } }, { backoff: { baseDelayMs: 0, maxDelayMs: 0, jitter: "none" } });
    const res = val(await run(t));
    expect(res.report.attempts.map((a) => a.waitedMs)).toEqual([0, 0]);
    expect(t.timerCalls().filter((ms) => ms < 60_000)).toEqual([]);
  });

  it("تلاش‌ها که تمام شد: خطای آخرین تلاش، RETRIED، هر سه رویداد، attempts_exhausted", async () => {
    const t = rrig({ m1: { steps: [unavailable(), unavailable(), unavailable(), ok] } });
    const e = err(await run(t));
    expect(e.code).toBe("PROVIDER_UNAVAILABLE");
    expect(e.retryable).toBe(true);
    expect(e.message).toBe(makeError("PROVIDER_UNAVAILABLE").message);
    expect(e.warnings).toEqual(["RETRIED"]);
    expect(e.report.stoppedBecause).toBe("attempts_exhausted");
    expect(outcomes(e)).toEqual(["PROVIDER_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "PROVIDER_UNAVAILABLE"]);
    expect(t.providers["p-m1"]?.calls).toHaveLength(3);
    expect(t.events).toHaveLength(3);
    expect(e.report.costUnknownAttempts).toBe(3);
  });

  it("بودجهٔ کل: ۵ تلاش مجاز ولی سقف کل ۲ ⇒ budget_exhausted پس از ۲ فراخوانی", async () => {
    const t = rrig({ m1: { steps: [unavailable(), unavailable(), unavailable(), unavailable(), unavailable()] } }, { maxAttemptsPerModel: 5, maxTotalAttempts: 2 });
    const e = err(await run(t));
    expect(e.report.stoppedBecause).toBe("budget_exhausted");
    expect(t.providers["p-m1"]?.calls).toHaveLength(2);
  });

  it("بودجهٔ کل میان مدل‌ها مشترک است", async () => {
    const t = rrig({ m1: { steps: [unavailable(), unavailable()] }, m2: { steps: [unavailable(), unavailable()] } }, { maxAttemptsPerModel: 2, maxTotalAttempts: 3, fallbacks: { m1: ["m2"] } });
    const e = err(await run(t));
    expect(e.report.stoppedBecause).toBe("budget_exhausted");
    expect(t.providers["p-m1"]?.calls).toHaveLength(2);
    expect(t.providers["p-m2"]?.calls).toHaveLength(1);
    expect(e.report.attempts.map((a) => a.model)).toEqual(["m1", "m1", "m2"]);
  });

  it("خطاهای غیرقابل‌تلاش هرگز تلاش دوباره نمی‌شوند: AUTH، REJECTED، BAD_RESPONSE، استثنای ناشناخته", async () => {
    const cases: Array<[Step, string]> = [
      [auth(), "PROVIDER_AUTH"],
      [{ fail: new ProviderFailure("rejected") }, "PROVIDER_REJECTED"],
      [{ reply: { text: 1 } }, "PROVIDER_BAD_RESPONSE"],
      [{ fail: new Error(CANARY) }, "PROVIDER_ERROR"],
    ];
    for (const [step, code] of cases) {
      const t = rrig({ m1: { steps: [step, ok] } });
      const e = err(await run(t));
      expect(e.code).toBe(code);
      expect(e.report.stoppedBecause).toBe("non_retryable");
      expect(t.providers["p-m1"]?.calls).toHaveLength(1);
      expect(JSON.stringify(e)).not.toContain(CANARY);
    }
  });

  it("TIMEOUT: در retryOn باشد دوباره تلاش می‌شود (مصرفِ نامعلومِ تلاشِ اول شمرده می‌شود)", async () => {
    const t = rrig({ m1: { steps: [{ hang: true }, ok] } }, { totalTimeoutMs: 1_000_000 });
    const res = await drive(t.gw.complete(REQUEST), t, 60_000);
    const v = val(res);
    expect(outcomes(v)).toEqual(["TIMEOUT", "ok"]);
    expect(v.warnings).toEqual(["RETRIED"]);
    expect(v.report.costUnknownAttempts).toBe(1);
    expect(t.events[0]).toMatchObject({ outcome: "TIMEOUT", usage: null, cost: null });
  });

  it("TIMEOUT در retryOn نباشد: همان شکست برمی‌گردد (پرهیز از دوباره‌خرجی)", async () => {
    const t = rrig({ m1: { steps: [{ hang: true }, ok] } }, { retryOn: ["PROVIDER_UNAVAILABLE"], fallbackOn: [] });
    const e = err(await drive(t.gw.complete(REQUEST), t, 60_000));
    expect(e.code).toBe("TIMEOUT");
    expect(e.report.stoppedBecause).toBe("non_retryable");
    expect(t.providers["p-m1"]?.calls).toHaveLength(1);
  });

  it("PROVIDER_RATE_LIMITED با retryAfterMs: کفِ انتظار؛ کوچک‌تر از backoff ⇒ backoff", async () => {
    const big = rrig({ m1: { steps: [rate(700), ok] } });
    expect(val(await run(big)).report.attempts[1]?.waitedMs).toBe(700);
    const small = rrig({ m1: { steps: [rate(10), ok] } });
    expect(val(await run(small)).report.attempts[1]?.waitedMs).toBe(100);
    const edge = rrig({ m1: { steps: [rate(1000), ok] } });
    expect(val(await run(edge)).report.attempts[1]?.waitedMs).toBe(1000);
  });

  it("retryAfterMs بیش از maxDelayMs: زودتر تلاش نمی‌شود؛ خطا با retryAfterMs برمی‌گردد", async () => {
    const t = rrig({ m1: { steps: [rate(5000), ok] } });
    const e = err(await run(t));
    expect(e.code).toBe("PROVIDER_RATE_LIMITED");
    expect(e.retryAfterMs).toBe(5000);
    expect(e.report.stoppedBecause).toBe("retry_after_too_long");
    expect(t.providers["p-m1"]?.calls).toHaveLength(1);
    expect(e.warnings).toEqual([]);
  });

  it("retryAfterMs بیش از maxDelayMs با جایگزین: بی‌انتظار به جایگزین می‌رود", async () => {
    const t = rrig({ m1: { steps: [rate(5000)] }, m2: { steps: [ok] } }, { fallbacks: { m1: ["m2"] } });
    const res = val(await run(t));
    expect(res.model).toBe("m2");
    expect(res.report.attempts.map((a) => a.waitedMs)).toEqual([0, 0]);
  });

  it("retryAfterMs بزرگ‌تر از زمان باقی‌مانده: تلاش نمی‌شود (deadline)", async () => {
    const t = rrig({ m1: { steps: [rate(900), ok] } }, { totalTimeoutMs: 800 });
    const e = err(await run(t));
    expect(e.report.stoppedBecause).toBe("deadline");
    expect(e.code).toBe("PROVIDER_RATE_LIMITED");
    expect(e.retryAfterMs).toBe(900);
  });
});

describe("ai-gateway · تاب‌آوری · jitter تزریقی", () => {
  const J = (jitter: string) => ({ backoff: { baseDelayMs: 100, maxDelayMs: 1000, jitter } });
  it("full: ⌊۱۰۰×۰٫۵⌋ = ۵۰؛ equal: ۷۵؛ هر تلاش دوباره یک‌بار تصادف می‌گیرد", async () => {
    const r1 = seqRandom([0.5]);
    const t1 = rrig({ m1: { steps: [unavailable(), unavailable(), ok] } }, { ...J("full"), random: r1 });
    expect(val(await run(t1)).report.attempts.map((a) => a.waitedMs)).toEqual([0, 50, 100]);
    expect(r1.calls).toBe(2);
    const r2 = seqRandom([0.5]);
    const t2 = rrig({ m1: { steps: [unavailable(), ok] } }, { ...J("equal"), random: r2 });
    expect(val(await run(t2)).report.attempts[1]?.waitedMs).toBe(75);
  });
  it("none: random هرگز صدا زده نمی‌شود؛ شکستِ غیرقابل‌تلاش هم تصادف مصرف نمی‌کند", async () => {
    const r = seqRandom([0.1]);
    const t = rrig({ m1: { steps: [unavailable(), ok] } }, { random: r });
    val(await run(t));
    expect(r.calls).toBe(0);
    const r3 = seqRandom([0.1]);
    const t3 = rrig({ m1: { steps: [auth()] } }, { ...J("full"), random: r3 });
    await run(t3);
    expect(r3.calls).toBe(0);
  });
  it("تصادف نامعتبر یا پرتاب‌کننده ⇒ بی‌کاهش (۱۰۰)، نه تلاشِ زودتر و نه شکستِ غیرمنتظره", async () => {
    for (const random of [{ next: () => Number.NaN }, { next: () => 1.5 }, { next: () => -0.2 }, { next: () => "0.1" as unknown as number }, { next: (): number => { throw new Error(CANARY); } }]) {
      const t = rrig({ m1: { steps: [unavailable(), ok] } }, { ...J("full"), random });
      const res = val(await run(t));
      expect(res.report.attempts[1]?.waitedMs).toBe(100);
      expect(JSON.stringify(res)).not.toContain(CANARY);
    }
  });
  it("full با u=۰ ⇒ انتظار ۰ و بی‌تایمر", async () => {
    const t = rrig({ m1: { steps: [unavailable(), ok] } }, { ...J("full"), random: seqRandom([0]) });
    const res = val(await run(t));
    expect(res.report.attempts[1]?.waitedMs).toBe(0);
    expect(t.timerCalls().filter((ms) => ms < 60_000)).toEqual([]);
  });
});

describe("ai-gateway · تاب‌آوری · زنجیرهٔ جایگزین", () => {
  it("تلاش‌های m1 تمام شد ⇒ m2؛ model/provider نتیجه جایگزین است؛ RETRIED و FELL_BACK؛ رویداد برای هر تلاش", async () => {
    const t = rrig({ m1: { steps: [unavailable(), unavailable(), unavailable()] }, m2: { steps: [ok] } }, { fallbacks: { m1: ["m2"] } });
    const res = val(await run(t, { ...REQUEST, requestId: "req-9" }));
    expect(res).toMatchObject({ model: "m2", provider: "p-m2", requestId: "req-9" });
    expect(res.warnings).toEqual(["RETRIED", "FELL_BACK"]);
    expect(res.report.requestedModel).toBe("m1");
    expect(res.report.attempts.map((a) => `${a.model}#${a.modelAttempt}:${a.outcome}`)).toEqual(["m1#1:PROVIDER_UNAVAILABLE", "m1#2:PROVIDER_UNAVAILABLE", "m1#3:PROVIDER_UNAVAILABLE", "m2#1:ok"]);
    expect(res.report.attempts.map((a) => a.waitedMs)).toEqual([0, 100, 200, 0]); // جایگزین بی‌انتظار
    expect(t.events.map((e) => [e.model, e.provider, e.outcome])).toEqual([
      ["m1", "p-m1", "PROVIDER_UNAVAILABLE"],
      ["m1", "p-m1", "PROVIDER_UNAVAILABLE"],
      ["m1", "p-m1", "PROVIDER_UNAVAILABLE"],
      ["m2", "p-m2", "ok"],
    ]);
    expect(t.events.every((e) => e.requestId === "req-9")).toBe(true);
  });

  it("AUTH بر m1 ⇒ بی‌درنگ m2 (بدون تلاش دوباره)؛ FELL_BACK بدون RETRIED", async () => {
    const t = rrig({ m1: { steps: [auth()] }, m2: { steps: [ok] } }, { fallbacks: { m1: ["m2"] } });
    const res = val(await run(t));
    expect(res.warnings).toEqual(["FELL_BACK"]);
    expect(t.providers["p-m1"]?.calls).toHaveLength(1);
  });

  it("کد در fallbackOn نباشد ⇒ جایگزین نمی‌رود و m2 دست‌نخورده می‌ماند", async () => {
    const t = rrig({ m1: { steps: [auth()] }, m2: { steps: [ok] } }, { fallbacks: { m1: ["m2"] }, fallbackOn: ["TIMEOUT"] });
    const e = err(await run(t));
    expect(e.code).toBe("PROVIDER_AUTH");
    expect(t.providers["p-m2"]?.calls).toHaveLength(0);
  });

  it("تمام زنجیره شکست: خطای آخرین تلاشِ رسیده؛ chain_exhausted؛ همهٔ مدل‌ها دیده‌اند", async () => {
    const t = rrig({ m1: { steps: [unavailable()] }, m2: { steps: [auth()] }, m3: { steps: [rate()] } }, { ...CHAIN, ...ONE_SHOT });
    const e = err(await run(t));
    expect(e.code).toBe("PROVIDER_RATE_LIMITED");
    expect(e.report.stoppedBecause).toBe("chain_exhausted");
    expect(outcomes(e)).toEqual(["PROVIDER_UNAVAILABLE", "PROVIDER_AUTH", "PROVIDER_RATE_LIMITED"]);
    expect(e.warnings).toEqual(["FELL_BACK"]);
  });

  it("جایگزینی که درخواست برایش نامعتبر است (سقف خروجی کوچک‌تر) بی‌هزینه رد می‌شود، کوتاه نمی‌شود، و سقف کل را نمی‌خورد", async () => {
    const t = rrig(
      { m1: { steps: [unavailable()] }, m2: { steps: [ok], model: { maxOutputTokens: 50 } }, m3: { steps: [ok] } },
      { ...CHAIN, ...ONE_SHOT, maxTotalAttempts: 2 },
    );
    const res = val(await run(t, { ...REQUEST, maxOutputTokens: 100 }));
    expect(res.model).toBe("m3");
    expect(res.report.attempts.map((a) => [a.model, a.outcome, a.reachedProvider])).toEqual([
      ["m1", "PROVIDER_UNAVAILABLE", true],
      ["m2", "INVALID_REQUEST", false],
      ["m3", "ok", true],
    ]);
    expect(t.providers["p-m2"]?.calls).toHaveLength(0);
    expect(t.providers["p-m3"]?.calls[0]?.maxOutputTokens).toBe(100); // کوتاه نشد
    expect(t.events).toHaveLength(2);
  });

  it("همهٔ جایگزین‌ها نامعتبر: خطای m1 (آخرین تلاشِ واقعی) با chain_exhausted؛ بدون FELL_BACK", async () => {
    const t = rrig(
      { m1: { steps: [unavailable()] }, m2: { steps: [ok], model: { maxOutputTokens: 50 } }, m3: { steps: [ok], model: { maxInputChars: 1 } } },
      { ...CHAIN, ...ONE_SHOT },
    );
    const e = err(await run(t, { ...REQUEST, maxOutputTokens: 100 }));
    expect(e.code).toBe("PROVIDER_UNAVAILABLE");
    expect(e.report.stoppedBecause).toBe("chain_exhausted");
    expect(e.warnings).toEqual([]);
    expect(e.issues).toBeUndefined();
  });

  it("غیرتراگذر: جایگزینِ جایگزین دنبال نمی‌شود", async () => {
    const t = rrig({ m1: { steps: [auth()] }, m2: { steps: [auth()] }, m3: { steps: [ok] } }, { fallbacks: { m1: ["m2"], m2: ["m3"] } });
    const e = err(await run(t));
    expect(e.report.stoppedBecause).toBe("chain_exhausted");
    expect(t.providers["p-m3"]?.calls).toHaveLength(0);
  });

  it("درخواست به مدلی که خودش زنجیره ندارد: فقط همان", async () => {
    const t = rrig({ m1: { steps: [ok] }, m2: { steps: [auth()] }, m3: { steps: [ok] } }, { fallbacks: { m1: ["m3"] } });
    const e = err(await run(t, { ...REQUEST, model: "m2" }));
    expect(e.code).toBe("PROVIDER_AUTH");
    expect(t.providers["p-m3"]?.calls).toHaveLength(0);
  });

  it("مهلتِ هر مدل از خودش می‌آید؛ مهلتِ صریحِ درخواست برای همهٔ تلاش‌ها یکی است", async () => {
    const mk = () => rrig({ m1: { steps: [auth()], model: { timeoutMs: 5000 } }, m2: { steps: [ok], model: { timeoutMs: 7000 } } }, { fallbacks: { m1: ["m2"] } });
    const a = mk();
    val(await run(a));
    expect(a.timerCalls()).toEqual([5000, 7000]);
    const b = mk();
    val(await run(b, { ...REQUEST, timeoutMs: 2500 }));
    expect(b.timerCalls()).toEqual([2500, 2500]);
  });
});

describe("ai-gateway · تاب‌آوری · مهلت کل", () => {
  it("مهلتِ هر تلاش به زمان باقی‌مانده کوتاه می‌شود (نه مهلت ۶۰ثانیه‌ای مدل)", async () => {
    const t = rrig({ m1: { steps: [{ hang: true }] } }, { totalTimeoutMs: 1000, fallbackOn: [] });
    const p = t.gw.complete(REQUEST);
    await tick();
    expect(t.timerCalls()).toEqual([1000]);
    t.clock.t += 1000;
    t.timers.advance(1000);
    const e = err(await p);
    expect(e.code).toBe("TIMEOUT");
    expect(e.report.stoppedBecause).toBe("deadline");
    expect(t.providers["p-m1"]?.calls).toHaveLength(1);
    expect(t.timers.pending).toBe(0);
  });

  it("تلاش دوم فقط زمانِ باقی‌مانده را می‌گیرد", async () => {
    let t!: RRig;
    t = rrig({ m1: { steps: [{ run: () => { t.clock.t += 300; throw new ProviderFailure("unavailable"); } }, ok] } }, { totalTimeoutMs: 1000 });
    const p = t.gw.complete(REQUEST);
    await tick(); // تلاش ۱ تمام، خواب ۱۰۰
    t.clock.t += 100;
    t.timers.advance(100);
    val(await p);
    expect(t.timerCalls()).toEqual([1000, 100, 600]);
  });

  it("انتظارِ backoff که در زمان باقی‌مانده جا نمی‌شود اجرا نمی‌شود (deadline) و خطای واقعی برمی‌گردد", async () => {
    let t!: RRig;
    t = rrig({ m1: { steps: [{ run: () => { t.clock.t += 100; throw new ProviderFailure("unavailable"); } }, ok] } }, { totalTimeoutMs: 150 });
    const e = err(await t.gw.complete(REQUEST)); // باقی‌مانده ۵۰ < ۱۰۰+۱
    expect(e.code).toBe("PROVIDER_UNAVAILABLE");
    expect(e.report.stoppedBecause).toBe("deadline");
    expect(t.providers["p-m1"]?.calls).toHaveLength(1);
    expect(t.timerCalls()).toEqual([150]);
  });

  it("پس از خواب اگر ساعت از مهلت گذشته بود، تلاش تازه‌ای نیست", async () => {
    let t!: RRig;
    t = rrig({ m1: { steps: [unavailable(), ok] } }, { totalTimeoutMs: 1000 });
    const p = t.gw.complete(REQUEST);
    await tick();
    t.clock.t += 5000; // ساعت جلو رفت ولی تایمر نه؛ بعد تایمر می‌رسد
    t.timers.advance(100);
    const e = err(await p);
    expect(e.report.stoppedBecause).toBe("deadline");
    expect(t.providers["p-m1"]?.calls).toHaveLength(1);
  });
});

describe("ai-gateway · تاب‌آوری · مرزِ زمانِ باقی‌مانده", () => {
  it("باقی‌مانده دقیقاً ۰ پس از انتظار ⇒ deadline (تلاشِ بامهلتِ صفر نمی‌شود)", async () => {
    const t = rrig({ m1: { steps: [unavailable(), ok] } }, { totalTimeoutMs: 1000 });
    const p = t.gw.complete(REQUEST);
    await tick();
    t.clock.t += 1000; // دقیقاً به مهلت رسیدیم
    t.timers.advance(100);
    const e = err(await p);
    expect(e.report.stoppedBecause).toBe("deadline");
    expect(e.code).toBe("PROVIDER_UNAVAILABLE");
    expect(t.providers["p-m1"]?.calls).toHaveLength(1);
  });
  it("باقی‌مانده دقیقاً ۱ms ⇒ تلاش با مهلت ۱ انجام می‌شود", async () => {
    let t!: RRig;
    t = rrig({ m1: { steps: [{ run: () => { t.clock.t += 899; throw new ProviderFailure("unavailable"); } }, ok] } }, { totalTimeoutMs: 1000 });
    const p = t.gw.complete(REQUEST);
    await tick(); // پس از تلاش ۱ باقی‌مانده ۱۰۱ است ⇒ انتظار ۱۰۰ جا می‌شود
    t.clock.t += 100;
    t.timers.advance(100);
    val(await p);
    expect(t.timerCalls()).toEqual([1000, 100, 1]);
  });
});

describe("ai-gateway · تاب‌آوری · لغو", () => {
  it("لغوِ پیشین: هیچ فراخوانی‌ای نیست", async () => {
    const t = rrig({ m1: { steps: [ok] } });
    const ctl = new AbortController();
    ctl.abort();
    const e = err(await t.gw.complete(REQUEST, { signal: ctl.signal }));
    expect(e.code).toBe("ABORTED");
    expect(e.report.stoppedBecause).toBe("aborted");
    expect(e.report.attempts).toEqual([]);
    expect(t.totalCalls()).toBe(0);
    expect(t.events).toHaveLength(0);
  });

  it("لغو در حینِ انتظارِ backoff: فوراً ABORTED، تلاش تازه‌ای نیست، تایمر پاک", async () => {
    const t = rrig({ m1: { steps: [unavailable(), ok] } });
    const ctl = new AbortController();
    const p = t.gw.complete(REQUEST, { signal: ctl.signal });
    await tick();
    expect(t.timers.pending).toBe(1);
    ctl.abort();
    const e = err(await p);
    expect(e.code).toBe("ABORTED");
    expect(e.retryable).toBe(false);
    expect(e.report.stoppedBecause).toBe("aborted");
    expect(outcomes(e)).toEqual(["PROVIDER_UNAVAILABLE"]);
    expect(t.providers["p-m1"]?.calls).toHaveLength(1);
    expect(t.timers.pending).toBe(0);
  });

  it("لغو در حینِ یک تلاش: ABORTED؛ نه تلاش دوباره نه جایگزین؛ رویداد همان تلاش ثبت", async () => {
    const t = rrig({ m1: { steps: [{ hang: true }, ok] }, m2: { steps: [ok] } }, { fallbacks: { m1: ["m2"] } });
    const ctl = new AbortController();
    const p = t.gw.complete(REQUEST, { signal: ctl.signal });
    await tick();
    ctl.abort();
    const e = err(await p);
    expect(e.code).toBe("ABORTED");
    expect(t.totalCalls()).toBe(1);
    expect(t.events.map((x) => x.outcome)).toEqual(["ABORTED"]);
    expect(e.warnings).toEqual([]);
    expect(t.timers.pending).toBe(0);
  });

  it("لغوِ پس از یک شکست و پیش از تلاش بعدی (خواب صفر): هیچ فراخوانیِ تازه‌ای نیست", async () => {
    const ctl = new AbortController();
    const t = rrig({ m1: { steps: [{ run: () => { ctl.abort(); throw new ProviderFailure("unavailable"); } }, ok] } }, { backoff: { baseDelayMs: 0, maxDelayMs: 0, jitter: "none" } });
    const e = err(await t.gw.complete(REQUEST, { signal: ctl.signal }));
    expect(e.code).toBe("ABORTED");
    expect(t.providers["p-m1"]?.calls).toHaveLength(1);
  });

  it("هر تلاش سیگنالِ خودش را دارد: سیگنالِ تلاشِ شکست‌خورده لغو شده، سیگنالِ تلاشِ بعدی نه", async () => {
    const t = rrig({ m1: { steps: [unavailable(), ok] } });
    val(await run(t));
    const [a, b] = t.providers["p-m1"]?.calls ?? [];
    expect(a?.signal).not.toBe(b?.signal);
    expect(a?.signal.aborted).toBe(true);
    expect(b?.signal.aborted).toBe(false);
  });
});

describe("ai-gateway · تاب‌آوری · حسابداری و شفافیت", () => {
  const USD = { currency: "USD", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, version: "test-usd" };
  const BAD_WITH_USAGE: Step = { reply: { text: 123, finishReason: "stop", usage: { inputTokens: 1000, outputTokens: 500 } } };

  it("تأخیرِ هر تلاش از رویدادِ خودِ همان تلاش می‌آید (نه جمع و نه صفر)", async () => {
    let t!: RRig;
    t = rrig({ m1: { steps: [{ run: () => { t.clock.t += 250; throw new ProviderFailure("unavailable"); } }, { run: () => { t.clock.t += 40; return OK_REPLY; } }] } });
    const res = val(await run(t));
    expect(res.report.attempts.map((a) => a.latencyMs)).toEqual([250, 40]);
    expect(res.latencyMs).toBe(40);
  });

  it("هزینهٔ تلاشِ شکست‌خورده (مصرفِ نجات‌یافته) در spend می‌آید؛ ارزها جدا؛ Completion.cost فقط مالِ آخر", async () => {
    const t = rrig({ m1: { steps: [BAD_WITH_USAGE] }, m2: { steps: [ok], model: { price: USD } } }, { fallbacks: { m1: ["m2"] }, ...ONE_SHOT });
    const res = val(await run(t));
    expect(res.cost).toEqual({ micros: 2000, currency: "USD", priceVersion: "test-usd" });
    expect(res.report.spend).toEqual([
      { currency: "IRR", micros: 10_500 },
      { currency: "USD", micros: 2000 },
    ]);
    expect(res.report.costUnknownAttempts).toBe(0);
    // و رویدادها همان دو هزینه را دارند (دفتر کامل است)
    expect(t.events.map((e) => e.cost?.micros)).toEqual([10_500, 2000]);
  });

  it("چند تلاشِ هم‌ارز جمع می‌شوند؛ بی‌قیمت و بی‌مصرف ‘نامعلوم’ شمرده می‌شوند، نه صفر", async () => {
    const t = rrig(
      { m1: { steps: [BAD_WITH_USAGE] }, m2: { steps: [BAD_WITH_USAGE] }, m3: { steps: [ok], model: { price: null } } },
      { ...CHAIN, ...ONE_SHOT },
    );
    const res = val(await run(t));
    expect(res.report.spend).toEqual([{ currency: "IRR", micros: 21_000 }]);
    expect(res.report.costUnknownAttempts).toBe(1); // m3: بی‌قیمت
    expect(res.cost).toBeNull();
  });

  it("جمعِ فراتر از 2^53−1 هرگز گرد نمی‌شود: micros = null؛ ۴ تلاش (۸×۱۰¹⁵) هنوز دقیق", async () => {
    const MAX = { currency: "IRR", inputMicrosPerMTok: 1e12, outputMicrosPerMTok: 1e12, version: "test-max" };
    const BIG: Step = { reply: { text: 1, finishReason: "stop", usage: { inputTokens: 1e9, outputTokens: 1e9 } } };
    const BIG_OK: Step = { reply: { text: "x", finishReason: "stop", usage: { inputTokens: 1e9, outputTokens: 1e9 } } };
    const model = (step: Step) => ({ steps: [step], model: { price: MAX } });
    const four = rrig({ m1: model(BIG), m2: model(BIG), m3: model(BIG), m4: model(BIG_OK) }, { fallbacks: { m1: ["m2", "m3", "m4"] }, ...ONE_SHOT });
    expect(val(await run(four)).report.spend).toEqual([{ currency: "IRR", micros: 8_000_000_000_000_000 }]);
    const five = rrig({ m1: model(BIG), m2: model(BIG), m3: model(BIG), m4: model(BIG), m5: model(BIG_OK) }, { fallbacks: { m1: ["m2", "m3", "m4", "m5"] }, ...ONE_SHOT, maxTotalAttempts: 5 });
    expect(val(await run(five)).report.spend).toEqual([{ currency: "IRR", micros: null }]);
  });

  it("هشدارهای تلاش‌های پیشین گم نمی‌شوند (ثبت مصرفِ تلاشِ اول شکست خورد) و تکراری نمی‌شوند", async () => {
    let n = 0;
    const t = rrig({ m1: { steps: [unavailable(), ok] } }, {}, { usageSink: { record: () => { if (n++ === 0) throw new Error(CANARY); } } });
    const res = val(await run(t));
    expect(res.warnings).toEqual(["USAGE_SINK_FAILED", "RETRIED"]);
    expect(JSON.stringify(res)).not.toContain(CANARY);
    const bad = rrig({ m1: { steps: [unavailable(), unavailable(), unavailable()] } }, {}, { usageSink: { record: () => { throw new Error("x"); } } });
    const e = err(await run(bad));
    expect(e.warnings).toEqual(["USAGE_SINK_FAILED", "RETRIED"]);
  });

  it("درخواست در همهٔ تلاش‌ها یکی است: دمای صریح ۰، توقف‌ها، پیام‌ها؛ نام مدلِ ارائه‌دهندهٔ خودِ هر مدل", async () => {
    const t = rrig({ m1: { steps: [unavailable()] }, m2: { steps: [ok] } }, { fallbacks: { m1: ["m2"] }, ...ONE_SHOT });
    val(await run(t, { ...REQUEST, stopSequences: ["###"], messages: [{ role: "system", content: "قانون" }, { role: "user", content: "سلام" }] }));
    const [c1] = t.providers["p-m1"]?.calls ?? [];
    const [c2] = t.providers["p-m2"]?.calls ?? [];
    expect(c1).toMatchObject({ model: "provider-m1", temperature: 0, stopSequences: ["###"], maxOutputTokens: 100 });
    expect(c2).toMatchObject({ model: "provider-m2", temperature: 0, stopSequences: ["###"], maxOutputTokens: 100 });
    expect(c2?.messages).toEqual(c1?.messages);
  });

  it("درخواست یک‌بار گرفته می‌شود: ویرایش ورودی در میانهٔ انتظار اثری ندارد", async () => {
    const input = { model: "m1", messages: [{ role: "user", content: "اصلی" }], maxOutputTokens: 100 };
    const t = rrig({ m1: { steps: [unavailable(), ok] } });
    const p = t.gw.complete(input);
    await tick();
    input.messages[0]!.content = "دست‌کاری‌شده";
    input.maxOutputTokens = 1;
    val(await drive(p, t));
    expect(t.providers["p-m1"]?.calls[1]?.messages).toEqual([{ role: "user", content: "اصلی" }]);
    expect(t.providers["p-m1"]?.calls[1]?.maxOutputTokens).toBe(100);
  });

  it("بی‌نشت: متن پرسش و پیام/cause خامِ ارائه‌دهنده در نتیجه، report و رویدادها نیست", async () => {
    const t = rrig(
      { m1: { steps: [{ fail: new ProviderFailure("unavailable", { cause: new Error(CANARY) }) }, { fail: new Error(CANARY) }] }, m2: { steps: [{ reply: { text: "x", finishReason: "bad", model: CANARY } }] } },
      { fallbacks: { m1: ["m2"] }, fallbackOn: ["PROVIDER_ERROR", "PROVIDER_BAD_RESPONSE"] },
    );
    const e = err(await run(t, { ...REQUEST, messages: [{ role: "user", content: `${CANARY}-پرسش` }] }));
    expect(JSON.stringify(e)).not.toContain("CANARY");
    expect(JSON.stringify(t.events)).not.toContain("CANARY");
    expect(e.code).toBe("PROVIDER_BAD_RESPONSE");
    expect(e.issues).toEqual(["reply.finishReason باید stop، length، content_filter یا other باشد."]); // فقط نام فیلد، نه محتوا
  });

  it("نتیجه‌ها و گزارش دست‌نخورده‌اند (منجمد)", async () => {
    const t = rrig({ m1: { steps: [unavailable(), ok] } });
    const res = val(await run(t));
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen(res.report)).toBe(true);
    expect(Object.isFrozen(res.report.attempts)).toBe(true);
    expect(Object.isFrozen(res.report.attempts[0])).toBe(true);
    expect(Object.isFrozen(res.report.spend)).toBe(true);
    expect(Object.isFrozen(res.warnings)).toBe(true);
    const e = err(await run(rrig({ m1: { steps: [auth()] } })));
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.report)).toBe(true);
    expect(Object.isFrozen(e.warnings)).toBe(true);
  });

  it("خطای نهایی شکل ثابت دارد: پیام ثابتِ هسته، retryable واقعی، retryAfterMs فقط وقتی هست", async () => {
    const e = err(await run(rrig({ m1: { steps: [rate(), rate(), rate()] } })));
    expect(Object.keys(e).sort()).toEqual(["code", "message", "report", "retryable", "warnings"]);
    expect(e.message).toBe(makeError("PROVIDER_RATE_LIMITED").message);
    const e2 = err(await run(rrig({ m1: { steps: [rate(5000)] } })));
    expect(e2.retryAfterMs).toBe(5000);
  });

  it("فراخوانی‌های هم‌زمان مستقل‌اند (هر کدام ردیابیِ خودش)", async () => {
    const t = rrig({ m1: { steps: [unavailable(), ok, ok] } });
    const [a, b] = await drive(Promise.all([t.gw.complete(REQUEST), t.gw.complete(REQUEST)]), t);
    const ra = val(a), rb = val(b);
    expect(ra.report.attempts.length + rb.report.attempts.length).toBe(3);
    expect(t.events).toHaveLength(3);
    expect(Math.min(ra.report.attempts.length, rb.report.attempts.length)).toBe(1);
  });
});

describe("ai-gateway · تاب‌آوری · پیکربندی و قرارداد", () => {
  const goodConfig = () => ({
    providers: { p1: scriptedProvider([ok]) },
    models: {
      m1: { provider: "p1", providerModel: "pm", maxInputChars: 100, maxOutputTokens: 100, price: PRICE },
      free: { provider: "p1", providerModel: "pm2", maxInputChars: 7, maxOutputTokens: 9, price: null },
    },
    clock: manualClock(),
  });

  it("پیکربندیِ هسته و سیاست هر دو رد شوند: همهٔ مشکل‌ها یک‌جا در INVALID_CONFIG", () => {
    const g = createResilientGateway({ providers: {}, models: {} }, { retryOn: 1 });
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.error.code).toBe("INVALID_CONFIG");
    const issues = (g.error.issues ?? []).join("|");
    expect(issues).toContain("providers");
    expect(issues).toContain("clock");
    expect(issues).toContain("policy.retryOn");
    expect(issues).toContain("policy.maxAttemptsPerModel");
  });
  it("پیکربندیِ سالم ولی سیاستِ ناسالم (جایگزینِ تعریف‌نشده) ⇒ INVALID_CONFIG", () => {
    const g = createResilientGateway(goodConfig(), { ...BASE_POLICY, fallbacks: { m1: ["ghost"] } });
    expect(g.ok).toBe(false);
    if (!g.ok) expect((g.error.issues ?? []).join("|")).toContain("ghost");
  });
  it("هرگز پرتاب نمی‌کند: ورودی‌های خصمانه", () => {
    const hostile = { get providers(): never { throw new Error(CANARY); } };
    for (const [c, p] of [[null, null], [undefined, undefined], [5, "x"], [hostile, BASE_POLICY], [goodConfig(), hostile]] as const) {
      const g = createResilientGateway(c, p);
      expect(g.ok).toBe(false);
      expect(JSON.stringify(g)).not.toContain(CANARY);
    }
  });
  it("سیاست «گرفته» می‌شود: ویرایشِ بعدیِ ورودی رفتار را عوض نمی‌کند", async () => {
    const policy = { ...BASE_POLICY, backoff: { ...BASE_POLICY.backoff }, retryOn: [...BASE_POLICY.retryOn], fallbacks: {} } as Record<string, unknown> & { maxAttemptsPerModel: number; retryOn: string[] };
    const provider = scriptedProvider([unavailable(), unavailable(), unavailable(), ok]);
    const timers = new ManualTimers();
    const clock = manualClock();
    const g = createResilientGateway({ ...goodConfig(), providers: { p1: provider }, timers, clock }, policy);
    if (!g.ok) throw new Error("رد");
    policy.maxAttemptsPerModel = 1;
    policy.retryOn.length = 0;
    const e = err(await drive(g.value.complete({ model: "m1", messages: [{ role: "user", content: "س" }], maxOutputTokens: 10 }), { timers, clock }));
    expect(e.report.attempts).toHaveLength(3); // همچنان ۳ تلاش
  });
  it("ساختاراً یک Gateway است (زیرنوع) و limits مثل هسته است؛ شیء منجمد", () => {
    const cfg = goodConfig();
    const rg = createResilientGateway(cfg, BASE_POLICY);
    const core = createGateway(cfg);
    if (!rg.ok || !core.ok) throw new Error("رد");
    const asGateway: Gateway = rg.value; // وارسی نوعی: اگر ناسازگار شود tsc می‌شکند
    expect(asGateway.limits("m1")).toEqual(core.value.limits("m1"));
    expect(asGateway.limits("free")).toEqual({ maxInputChars: 7, maxOutputTokens: 9, priced: false });
    expect(asGateway.limits("free")).toEqual(core.value.limits("free"));
    expect(asGateway.limits("nope")).toBeNull();
    expect(asGateway.limits(5 as never)).toBeNull();
    expect(Object.isFrozen(rg.value)).toBe(true);
  });
  it("ERROR_CODES دست‌نخورده: همچنان ۱۲ کد (این برش کد خطای تازه نمی‌سازد)", () => {
    expect(ERROR_CODES).toHaveLength(12);
  });
});

describe("ai-gateway · تاب‌آوری · هرگز پرتاب نمی‌کند", () => {
  const baseCfg = (provider: unknown, clock = manualClock()) => ({
    providers: { p1: provider },
    models: { m1: { provider: "p1", providerModel: "pm", maxInputChars: 100, maxOutputTokens: 100, price: PRICE } },
    clock,
    timers: new ManualTimers(),
  });
  const REQ = { model: "m1", messages: [{ role: "user", content: "س" }], maxOutputTokens: 10 };

  it("ارائه‌دهندهٔ هم‌زمان‌پرتاب‌کننده ⇒ PROVIDER_ERROR، بی‌نشت و بدون تلاش دوباره", async () => {
    let calls = 0;
    const g = createResilientGateway(baseCfg({ complete() { calls++; throw new Error(CANARY); } }), BASE_POLICY);
    if (!g.ok) throw new Error("رد");
    const e = err(await g.value.complete(REQ));
    expect(e.code).toBe("PROVIDER_ERROR");
    expect(calls).toBe(1);
    expect(JSON.stringify(e)).not.toContain(CANARY);
  });
  it("ساعتِ خراب در میانه: INTERNAL_ERROR، ولی ردپای تلاش‌های انجام‌شده در report می‌ماند", async () => {
    const clock = manualClock();
    let broken = false;
    const flaky = { nowMs: () => { if (broken) throw new Error(CANARY); return clock.nowMs(); } };
    const provider = { complete: () => { broken = true; return Promise.reject(new ProviderFailure("unavailable")); } };
    const g = createResilientGateway(baseCfg(provider, flaky as never), BASE_POLICY);
    if (!g.ok) throw new Error("رد");
    const e = err(await g.value.complete(REQ));
    expect(e.code).toBe("INTERNAL_ERROR");
    // تلاشِ انجام‌شده (پولی) در ردپا می‌ماند، رسیده‌به‌ارائه‌دهنده حساب می‌شود و هزینه‌اش «نامعلوم» است
    expect(e.report.attempts).toHaveLength(1);
    expect(e.report.attempts[0]).toMatchObject({ model: "m1", outcome: "INTERNAL_ERROR", reachedProvider: true, cost: null });
    expect(e.report.costUnknownAttempts).toBe(1);
    expect(e.report.stoppedBecause).toBe("non_retryable");
    expect(JSON.stringify(e)).not.toContain(CANARY);
  });
  it("ساعتِ ناعددی از همان آغاز ⇒ INTERNAL_ERROR با report تهی", async () => {
    const g = createResilientGateway(baseCfg({ complete: () => Promise.resolve(OK_REPLY) }, { nowMs: () => Number.NaN } as never), BASE_POLICY);
    if (!g.ok) throw new Error("رد");
    const e = err(await g.value.complete(REQ));
    expect(e.code).toBe("INTERNAL_ERROR");
    expect(e.report.attempts).toEqual([]);
  });
  it("مقصدِ مصرفِ پرتاب‌کننده/گیرکرده: پاسخ از دست نمی‌رود، هشدار می‌آید", async () => {
    const t = rrig({ m1: { steps: [ok] } }, {}, { usageSink: { record: () => new Promise<void>(() => undefined) }, sinkTimeoutMs: 50 });
    const p = t.gw.complete(REQUEST);
    await tick();
    t.timers.advance(50);
    expect(val(await p).warnings).toEqual(["USAGE_SINK_TIMEOUT"]);
  });
});

describe("ai-gateway · تاب‌آوری · کد منبع", () => {
  it("فایل‌های تازه هم بی‌ساعت/تصادف/محیط/شبکه/فایل‌اند و تحت آزمون نگهبانِ هسته قرار می‌گیرند", () => {
    const files = readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-kit.ts");
    for (const f of ["backoff.ts", "decision.ts", "resilience.ts", "resilience-policy.ts", "resilience-types.ts", "resilience-kit.ts"]) expect(files, f).toContain(f);
    for (const f of files.filter((n) => /^(backoff|decision|resilience)/.test(n))) {
      const src = readFileSync(join(__dirname, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of [/Date\.now/, /new Date\(/, /Math\.random/, /process\.env/, /\bfetch\(/, /node:/, /from "@\/modules\//, /from "@\/db/, /performance\.now/, /\bXMLHttpRequest\b/, /\bsetTimeout\(/, /\bsetInterval\(/, /\bcrypto\b/]) {
        // resilience-kit.ts فقط برای tick واقعی از setTimeout استفاده می‌کند (ابزار آزمون است، نه هسته)
        if (f === "resilience-kit.ts" && String(forbidden) === String(/\bsetTimeout\(/)) continue;
        expect(forbidden.test(src), `${f} ${String(forbidden)}`).toBe(false);
      }
    }
  });
  it("هسته فقط از رابط داخلیِ همین ماژول import می‌کند (بدون ماژول دیگر)", () => {
    for (const f of ["backoff.ts", "decision.ts", "resilience.ts", "resilience-policy.ts", "resilience-types.ts"]) {
      const imports = [...readFileSync(join(__dirname, f), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);
      for (const i of imports) expect(i.startsWith("./"), `${f}: ${i}`).toBe(true);
    }
  });
});

describe("ai-gateway · completeObserved (نقطهٔ مشاهدهٔ رویدادِ برش ۲)", () => {
  const cfgOf = (over: Record<string, unknown> = {}) => {
    const r = resolveConfig({ providers: { p1: scriptedProvider([ok, ok]) }, models: { m1: { provider: "p1", providerModel: "pm", maxInputChars: 100, maxOutputTokens: 100, price: PRICE } }, clock: manualClock(), timers: new ManualTimers(), ...over });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  };
  const REQ = { model: "m1", messages: [{ role: "user", content: "س" }], maxOutputTokens: 10 };

  it("مشاهده‌گر دقیقاً یک‌بار رویداد همین فراخوانی را می‌بیند و مقصد مصرف هم رویداد را می‌گیرد", async () => {
    const sunk: unknown[] = [];
    const cfg = cfgOf({ usageSink: { record: (e: unknown) => void sunk.push(e) } });
    const seen: unknown[] = [];
    const res = await completeObserved(cfg, REQ, undefined, (e) => void seen.push(e));
    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ model: "m1", outcome: "ok", usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 } });
    expect(sunk).toEqual(seen);
  });
  it("مشاهده‌گرِ پرتاب‌کننده نتیجه و ثبت مصرف را عوض نمی‌کند", async () => {
    const sunk: unknown[] = [];
    const cfg = cfgOf({ usageSink: { record: (e: unknown) => void sunk.push(e) } });
    const res = await completeObserved(cfg, REQ, undefined, () => { throw new Error(CANARY); });
    expect(res.ok).toBe(true);
    expect(sunk).toHaveLength(1);
  });
  it("برای ورودی نامعتبر مشاهده‌گر صدا زده نمی‌شود (چیزی مصرف نشده)", async () => {
    let n = 0;
    const res = await completeObserved(cfgOf(), { ...REQ, maxOutputTokens: -1 }, undefined, () => void n++);
    expect(res.ok).toBe(false);
    expect(n).toBe(0);
  });
  it("هرگز پرتاب نمی‌کند: ساعتِ خراب ⇒ INTERNAL_ERROR", async () => {
    const res = await completeObserved(cfgOf({ clock: { nowMs: () => { throw new Error(CANARY); } } }), REQ, undefined, () => undefined);
    expect(res.ok ? "ok" : res.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res)).not.toContain(CANARY);
  });
  it("سیگنال در options به هسته می‌رسد", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const res = await completeObserved(cfgOf(), REQ, { signal: ctl.signal }, () => undefined);
    expect(res.ok ? "ok" : res.error.code).toBe("ABORTED");
  });
});
