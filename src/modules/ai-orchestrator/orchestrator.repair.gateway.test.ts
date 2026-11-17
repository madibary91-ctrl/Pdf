/**
 * ترمیم (ADR-0017) روی دروازه‌های **واقعی** (`createGateway` و `createResilientGateway`) با ارائه‌دهندهٔ ساختگی:
 * `report` تاب‌آور میان دو تلاش بی‌گمشدگی تجمیع می‌شود، دروازهٔ هزینه روی قیمتِ واقعیِ دروازه می‌سنجد، و بی‌قیمتی/نامعلومی ترمیم را می‌بندد.
 * همهٔ قیمت‌ها ساختگیِ آزمون‌اند.
 */
import { describe, expect, it } from "vitest";
import { createGateway, createResilientGateway, ProviderFailure, type Gateway, type ModelProvider, type ProviderCall, type ProviderReply, type UsageEvent } from "@/modules/ai-gateway";
import { createOrchestrator } from "./orchestrator";
import { fakeChecker, fakeSearcher, type FakeArticle } from "./test-kit";
import type { Answer, AnswerPolicy, AskResult } from "./types";

const BODY1 = "فروشنده مکلف است مبیع را ظرف ۱۰ روز تحویل دهد.";
const ARTICLES: FakeArticle[] = [{ documentId: "law-a", article: "1", validFrom: "2001-01-01", validTo: null, text: BODY1, verified: true }];
const INPUT = { question: "فروشنده مبیع تحویل", asOf: "2024-03-01", model: "legal-chat", maxOutputTokens: 800, requestId: "req-rp-1" };
const GOOD = JSON.stringify({ answer: "فروشنده مکلف است ظرف ۱۰ روز تحویل دهد [S1].", insufficient: false, citations: [{ source: "S1", quote: "مکلف است مبیع" }] });
const BAD = JSON.stringify({ answer: "فروشنده مکلف است [S1].", insufficient: false, citations: [{ source: "S1", quote: "جمله‌ای که در ماده نیست" }] });

const PRICE = { currency: "IRR", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, version: "test-prices-1" };
const spec = (provider: string, price: typeof PRICE | null = PRICE) => ({ provider, providerModel: `${provider}-model`, maxInputChars: 60_000, maxOutputTokens: 4096, price });
const reply = (text: string, over: Partial<ProviderReply> = {}): ProviderReply => ({ text, finishReason: "stop", usage: { inputTokens: 100, outputTokens: 50 }, ...over });
const COST_PER_CALL = 200; // 100×1 + 50×2 میکرو

type Step = ProviderReply | Error;
function provider(steps: Step[]): ModelProvider & { calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  let i = 0;
  return {
    calls,
    async complete(call) {
      calls.push(call);
      const s = steps[i++];
      if (s === undefined) throw new Error("script exhausted");
      if (s instanceof Error) throw s;
      return s;
    },
  };
}
const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
const clock = { nowMs: () => Date.now() };
const cap = (n: number): AnswerPolicy => ({ onRejectedCitation: "withhold", requireQuotes: true, repair: { maxFirstAttemptSpendMicros: n, currency: "IRR" } });

function over(gateway: Gateway, policy: AnswerPolicy) {
  const checker = fakeChecker({ texts: { "law-a#1": BODY1 } });
  const made = createOrchestrator({ searcher: fakeSearcher(ARTICLES), gateway, checker, policy });
  if (!made.ok) throw new Error(made.error.code);
  return made.value;
}
const ok = (r: AskResult): Answer => {
  if (!r.ok) throw new Error(`${r.error.code} ${JSON.stringify(r.error)}`);
  return r.value;
};
const POLICY = {
  maxAttemptsPerModel: 2,
  maxTotalAttempts: 4,
  totalTimeoutMs: 20_000,
  backoff: { baseDelayMs: 0, maxDelayMs: 0, jitter: "none" },
  retryOn: ["PROVIDER_UNAVAILABLE"],
  fallbackOn: ["PROVIDER_AUTH", "PROVIDER_UNAVAILABLE"],
  fallbacks: { "legal-chat": ["backup-chat"] },
} as const;
const NO_FALLBACK = { ...POLICY, fallbackOn: [], fallbacks: {} } as const;

describe("ترمیم × createGateway (واقعی)", () => {
  it("دو تماس واقعی؛ هزینهٔ هر دو جمع می‌شود؛ رویدادهای مصرف دو تا و بی‌متن؛ یک requestId برای هر دو", async () => {
    const p = provider([reply(BAD), reply(GOOD)]);
    const events: UsageEvent[] = [];
    const g = createGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers, usageSink: { record: (e: UsageEvent) => void events.push(e) } });
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await over(g.value, cap(COST_PER_CALL)).ask(INPUT));
    expect(a).toMatchObject({ status: "answered", repair: { outcome: "adopted", trigger: "citation-rejected", attempts: 2 } });
    expect(a.accounting).toEqual({ source: "completion", providerCalls: 2, spend: [{ currency: "IRR", micros: 2 * COST_PER_CALL }], costUnknownCalls: 0, retried: false, fellBack: false });
    expect(p.calls).toHaveLength(2);
    expect(p.calls.map((c) => c.messages.length)).toEqual([2, 2]);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.requestId)).toEqual(["req-rp-1", "req-rp-1"]);
    expect(JSON.stringify(events)).not.toContain("مکلف");
    expect(JSON.stringify(events)).not.toContain("جمله‌ای که در ماده نیست");
  });

  it("دروازهٔ هزینه روی قیمت واقعی: سقف = هزینهٔ تلاش نخست ⇒ ترمیم؛ یکی کمتر ⇒ بی‌ترمیم با یک تماس", async () => {
    const mk = (n: number, steps: Step[]) => {
      const p = provider(steps);
      const g = createGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers });
      if (!g.ok) throw new Error(g.error.code);
      return { p, o: over(g.value, cap(n)) };
    };
    const at = mk(COST_PER_CALL, [reply(BAD), reply(GOOD)]);
    expect(ok(await at.o.ask(INPUT)).repair?.outcome).toBe("adopted");
    const below = mk(COST_PER_CALL - 1, [reply(BAD)]);
    const a = ok(await below.o.ask(INPUT));
    expect(a.repair).toMatchObject({ outcome: "skipped-cost-cap", attempts: 1 });
    expect(below.p.calls).toHaveLength(1);
  });

  it("مدل بی‌قیمت (price: null) یا مصرفِ گزارش‌نشده ⇒ هزینهٔ نامعلوم ⇒ ترمیم نمی‌شود", async () => {
    for (const [model, steps] of [
      [spec("main", null), [reply(BAD)]],
      [spec("main"), [{ text: BAD, finishReason: "stop" } as ProviderReply]],
    ] as const) {
      const p = provider([...steps]);
      const g = createGateway({ providers: { main: p }, models: { "legal-chat": model }, clock, timers });
      if (!g.ok) throw new Error(g.error.code);
      const a = ok(await over(g.value, cap(1_000_000)).ask(INPUT));
      expect(a.repair).toMatchObject({ outcome: "skipped-cost-unknown", attempts: 1 });
      expect(a.status).toBe("withheld");
      expect(p.calls).toHaveLength(1);
    }
  });

  it("خطای قالب (not-json) با دروازهٔ واقعی ترمیم می‌شود", async () => {
    const p = provider([reply("نه JSON"), reply(GOOD)]);
    const g = createGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers });
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await over(g.value, cap(COST_PER_CALL)).ask(INPUT));
    expect(a).toMatchObject({ status: "answered", repair: { outcome: "adopted", trigger: "output-invalid" } });
  });
});

describe("ترمیم × createResilientGateway (واقعی)", () => {
  it("report دو تلاش تجمیع می‌شود: source=report، دو فراخوانی، جمع هزینه", async () => {
    const p = provider([reply(BAD), reply(GOOD)]);
    const g = createResilientGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers }, NO_FALLBACK);
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await over(g.value, cap(COST_PER_CALL)).ask(INPUT));
    expect(a.repair).toMatchObject({ outcome: "adopted", attempts: 2 });
    expect(a.accounting).toEqual({ source: "report", providerCalls: 2, spend: [{ currency: "IRR", micros: 2 * COST_PER_CALL }], costUnknownCalls: 0, retried: false, fellBack: false });
  });

  it("تلاش نخست retry داشت ⇒ تماسِ شکست‌خورده «هزینهٔ نامعلوم» است ⇒ دروازهٔ هزینه ترمیم را می‌بندد (محافظه‌کارانه)", async () => {
    const p = provider([new ProviderFailure("unavailable"), reply(BAD)]);
    const g = createResilientGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers }, NO_FALLBACK);
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await over(g.value, cap(1_000_000)).ask(INPUT));
    expect(a).toMatchObject({ status: "withheld", repair: { outcome: "skipped-cost-unknown", attempts: 1 } });
    expect(a.accounting).toMatchObject({ source: "report", providerCalls: 2, retried: true, costUnknownCalls: 1 });
    expect(p.calls).toHaveLength(2);
  });

  it("retry فقط در تلاش دوم: تماس‌ها جمع، retried و costUnknownCalls سرایت می‌کنند، پاسخ پذیرفته می‌شود", async () => {
    const p = provider([reply(BAD), new ProviderFailure("unavailable"), reply(GOOD)]);
    const g = createResilientGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers }, NO_FALLBACK);
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await over(g.value, cap(COST_PER_CALL)).ask(INPUT));
    expect(a).toMatchObject({ status: "answered", repair: { outcome: "adopted", attempts: 2 } });
    expect(p.calls).toHaveLength(3);
    expect(a.accounting).toMatchObject({ source: "report", providerCalls: 3, retried: true, fellBack: false, costUnknownCalls: 1 });
    expect(a.accounting?.spend).toEqual([{ currency: "IRR", micros: 2 * COST_PER_CALL }]);
  });

  it("جایگزینِ مدل در تلاش دوم: fellBack سرایت می‌کند و پاسخ پذیرفته می‌شود", async () => {
    const main = provider([reply(BAD), new ProviderFailure("auth")]);
    const backup = provider([reply(GOOD)]);
    const g = createResilientGateway({ providers: { main, backup }, models: { "legal-chat": spec("main"), "backup-chat": spec("backup") }, clock, timers }, POLICY);
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await over(g.value, cap(COST_PER_CALL)).ask(INPUT));
    expect(a).toMatchObject({ status: "answered", repair: { outcome: "adopted" } });
    expect(a.accounting).toMatchObject({ source: "report", fellBack: true, retried: false });
    expect(backup.calls).toHaveLength(1);
  });

  it("تلاش دومِ شکست‌خورده با report: نتیجهٔ نخست + failed و حسابداری **معلوم** (از report خطا)", async () => {
    const p = provider([reply(BAD), new ProviderFailure("unavailable"), new ProviderFailure("unavailable")]);
    const g = createResilientGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers }, NO_FALLBACK);
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await over(g.value, cap(COST_PER_CALL)).ask(INPUT));
    expect(a).toMatchObject({ status: "withheld", repair: { outcome: "failed", attempts: 2 } });
    expect(a.warnings).toContain("REPAIR_FAILED");
    expect(a.accounting).toMatchObject({ source: "report", providerCalls: 3, retried: true, spend: [{ currency: "IRR", micros: COST_PER_CALL }], costUnknownCalls: 2 });
  });

  it("خطای قالب + شکست دوم با report ⇒ خطای نخست با حسابداری تجمیعی", async () => {
    const p = provider([reply("نه JSON"), new ProviderFailure("unavailable"), new ProviderFailure("unavailable")]);
    const g = createResilientGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers }, NO_FALLBACK);
    if (!g.ok) throw new Error(g.error.code);
    const r = await over(g.value, cap(COST_PER_CALL)).ask(INPUT);
    expect(r).toMatchObject({ ok: false, error: { code: "MODEL_OUTPUT_INVALID", reason: "not-json" } });
    if (!r.ok) expect(r.error.accounting).toMatchObject({ source: "report", providerCalls: 3, retried: true, spend: [{ currency: "IRR", micros: COST_PER_CALL }] });
  });

  it("لغو در حین تلاش دوم (دروازهٔ واقعی): پاسخ نخست برمی‌گردد و ترمیم failed است", async () => {
    const ac = new AbortController();
    let n = 0;
    const p: ModelProvider = {
      complete: (call) => {
        n++;
        if (n === 1) return Promise.resolve(reply(BAD));
        queueMicrotask(() => ac.abort());
        return new Promise((_, rej) => call.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
      },
    };
    const g = createResilientGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers }, NO_FALLBACK);
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await over(g.value, cap(COST_PER_CALL)).ask(INPUT, { signal: ac.signal }));
    expect(a).toMatchObject({ status: "withheld", repair: { outcome: "failed", attempts: 2 } });
  });
});
