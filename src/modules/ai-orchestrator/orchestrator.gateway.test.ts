/**
 * قرارداد با دروازهٔ **واقعی** (`createGateway` و `createResilientGateway`) و ارائه‌دهندهٔ ساختگی: ثابت می‌کند نوع‌ها و رفتارِ دو دروازه
 * بی‌تغییر در ارکستراتور می‌نشینند و حسابداری (`report`) گم نمی‌شود. همهٔ قیمت‌ها ساختگیِ آزمون‌اند.
 */
import { describe, expect, it } from "vitest";
import { createGateway, createResilientGateway, ProviderFailure, type Gateway, type ModelProvider, type ProviderCall, type ProviderReply, type UsageEvent } from "@/modules/ai-gateway";
import { createOrchestrator } from "./orchestrator";
import { fakeChecker, fakeSearcher, type FakeArticle } from "./test-kit";
import type { Answer, AskResult } from "./types";

const BODY1 = "فروشنده مکلف است مبیع را ظرف ۱۰ روز تحویل دهد.";
const ARTICLES: FakeArticle[] = [{ documentId: "law-a", article: "1", validFrom: "2001-01-01", validTo: null, text: BODY1, verified: true }];
const INPUT = { question: "فروشنده مبیع تحویل", asOf: "2024-03-01", model: "legal-chat", maxOutputTokens: 800, requestId: "req-gw-1" };
const GOOD = JSON.stringify({ answer: "فروشنده مکلف است ظرف ۱۰ روز تحویل دهد [S1].", insufficient: false, citations: [{ source: "S1", quote: "مکلف است مبیع" }] });

const PRICE = { currency: "IRR", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, version: "test-prices-1" };
const spec = (provider: string) => ({ provider, providerModel: `${provider}-model`, maxInputChars: 60_000, maxOutputTokens: 4096, price: PRICE });
const reply = (text: string, over: Partial<ProviderReply> = {}): ProviderReply => ({ text, finishReason: "stop", usage: { inputTokens: 100, outputTokens: 50 }, ...over });

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

function orchestratorOver(gateway: Gateway) {
  const checker = fakeChecker({ texts: { "law-a#1": BODY1 } });
  const made = createOrchestrator({ searcher: fakeSearcher(ARTICLES), gateway, checker, policy: { onRejectedCitation: "withhold", requireQuotes: true } });
  if (!made.ok) throw new Error(made.error.code);
  return { orchestrator: made.value, checker };
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
const POLICY_NO_FALLBACK = { ...POLICY, fallbackOn: [], fallbacks: {} } as const;

describe("ai-orchestrator × createGateway (واقعی)", () => {
  it("پاسخ مستند؛ هزینهٔ صحیح؛ پیام‌ها و پارامترها دقیقاً همان‌اند که ارکستراتور فرستاد؛ رویداد مصرف بی‌متن", async () => {
    const p = provider([reply(GOOD)]);
    const events: UsageEvent[] = [];
    const g = createGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers, usageSink: { record: (e: UsageEvent) => void events.push(e) } });
    if (!g.ok) throw new Error(g.error.code);
    const { orchestrator } = orchestratorOver(g.value);
    const a = ok(await orchestrator.ask(INPUT));
    expect(a).toMatchObject({ status: "answered", citations: [{ id: "S1" }] });
    expect(a.accounting).toEqual({ source: "completion", providerCalls: 1, spend: [{ currency: "IRR", micros: 200 }], costUnknownCalls: 0, retried: false, fellBack: false });
    expect(a.generation).toMatchObject({ provider: "main", requestId: "req-gw-1", cost: { micros: 200, currency: "IRR", priceVersion: "test-prices-1" } });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]).toMatchObject({ model: "main-model", temperature: 0, maxOutputTokens: 800 });
    expect(p.calls[0]?.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "ok", requestId: "req-gw-1" });
    expect(JSON.stringify(events)).not.toContain("مکلف");
  });

  it("پاسخ بریده (length) ⇒ MODEL_OUTPUT_INVALID(finish-reason) و هزینهٔ تلاش در حسابداری می‌ماند", async () => {
    const g = createGateway({ providers: { main: provider([reply(GOOD, { finishReason: "length" })]) }, models: { "legal-chat": spec("main") }, clock, timers });
    if (!g.ok) throw new Error(g.error.code);
    const { orchestrator } = orchestratorOver(g.value);
    const r = await orchestrator.ask(INPUT);
    expect(r).toMatchObject({ ok: false, error: { code: "MODEL_OUTPUT_INVALID", reason: "finish-reason" } });
    if (!r.ok) expect(r.error.accounting).toMatchObject({ source: "completion", spend: [{ currency: "IRR", micros: 200 }] });
  });

  it("مصرفِ گزارش‌نشده ⇒ هزینهٔ نامعلوم (نه صفر)", async () => {
    const g = createGateway({ providers: { main: provider([{ text: GOOD, finishReason: "stop" }]) }, models: { "legal-chat": spec("main") }, clock, timers });
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await orchestratorOver(g.value).orchestrator.ask(INPUT));
    expect(a.accounting).toMatchObject({ source: "completion", spend: [], costUnknownCalls: 1 });
    expect(a.generation?.warnings).toContain("USAGE_MISSING");
  });

  it("شکست ارائه‌دهنده ⇒ GENERATION_FAILED با کد دروازه؛ پیام خام ارائه‌دهنده نشت نمی‌کند", async () => {
    const g = createGateway({ providers: { main: provider([new ProviderFailure("rate_limited", { retryAfterMs: 2000, cause: new Error("SECRET_PROVIDER_BODY") })]) }, models: { "legal-chat": spec("main") }, clock, timers });
    if (!g.ok) throw new Error(g.error.code);
    const r = await orchestratorOver(g.value).orchestrator.ask(INPUT);
    expect(r).toMatchObject({ ok: false, error: { code: "GENERATION_FAILED", gatewayCode: "PROVIDER_RATE_LIMITED", retryable: true, retryAfterMs: 2000 } });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("دروازه با مدل کوچک: بودجهٔ زمینه رعایت می‌شود و دروازه ورودی را رد نمی‌کند", async () => {
    const small = { ...spec("main"), maxInputChars: 2200 };
    const p = provider([reply(GOOD)]);
    const g = createGateway({ providers: { main: p }, models: { "legal-chat": small }, clock, timers });
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await orchestratorOver(g.value).orchestrator.ask(INPUT));
    expect(a.status).toBe("answered");
    const sent = p.calls[0]?.messages.reduce((n, m) => n + m.content.length, 0) ?? 0;
    expect(sent).toBeLessThanOrEqual(2200);
  });
});

describe("ai-orchestrator × createResilientGateway (واقعی)", () => {
  it("تلاش دوباره: report به حسابداری می‌رسد (دو فراخوانی، retried)", async () => {
    const p = provider([new ProviderFailure("unavailable"), reply(GOOD)]);
    const g = createResilientGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers }, POLICY_NO_FALLBACK);
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await orchestratorOver(g.value).orchestrator.ask(INPUT));
    expect(a.status).toBe("answered");
    expect(p.calls).toHaveLength(2);
    expect(a.accounting).toMatchObject({ source: "report", providerCalls: 2, retried: true, fellBack: false });
    expect(a.accounting?.spend).toEqual([{ currency: "IRR", micros: 200 }]);
    expect(a.generation?.warnings).toContain("RETRIED");
  });

  it("جایگزین: داده به ارائه‌دهندهٔ دیگری رفته ⇒ fellBack و هشدار FELL_BACK", async () => {
    const main = provider([new ProviderFailure("auth")]);
    const backup = provider([reply(GOOD)]);
    const g = createResilientGateway({ providers: { main, backup }, models: { "legal-chat": spec("main"), "backup-chat": spec("backup") }, clock, timers }, POLICY);
    if (!g.ok) throw new Error(g.error.code);
    const a = ok(await orchestratorOver(g.value).orchestrator.ask(INPUT));
    expect(a.status).toBe("answered");
    expect(a.accounting).toMatchObject({ source: "report", fellBack: true, providerCalls: 2 });
    expect(a.generation?.warnings).toContain("FELL_BACK");
    expect(backup.calls).toHaveLength(1);
  });

  it("همهٔ تلاش‌ها شکست: GENERATION_FAILED با حسابداری از report (پول گم نمی‌شود)", async () => {
    const p = provider([new ProviderFailure("unavailable"), new ProviderFailure("unavailable")]);
    const g = createResilientGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers }, POLICY_NO_FALLBACK);
    if (!g.ok) throw new Error(g.error.code);
    const r = await orchestratorOver(g.value).orchestrator.ask(INPUT);
    expect(r).toMatchObject({ ok: false, error: { code: "GENERATION_FAILED", gatewayCode: "PROVIDER_UNAVAILABLE" } });
    if (!r.ok) expect(r.error.accounting).toMatchObject({ source: "report", providerCalls: 2, retried: true });
  });

  it("خروجی نامعتبرِ پس از تلاش دوباره: هزینهٔ همهٔ تلاش‌ها در خطا هست", async () => {
    const p = provider([new ProviderFailure("unavailable"), reply("نه JSON")]);
    const g = createResilientGateway({ providers: { main: p }, models: { "legal-chat": spec("main") }, clock, timers }, POLICY_NO_FALLBACK);
    if (!g.ok) throw new Error(g.error.code);
    const r = await orchestratorOver(g.value).orchestrator.ask(INPUT);
    expect(r).toMatchObject({ ok: false, error: { code: "MODEL_OUTPUT_INVALID", reason: "not-json" } });
    if (!r.ok) expect(r.error.accounting).toMatchObject({ source: "report", providerCalls: 2, spend: [{ currency: "IRR", micros: 200 }] });
  });

  it("لغو: سیگنال تا دروازهٔ واقعی می‌رسد و ABORTED برمی‌گردد", async () => {
    const hang: ModelProvider = { complete: (call) => new Promise((_, rej) => call.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })) };
    const g = createResilientGateway({ providers: { main: hang }, models: { "legal-chat": spec("main") }, clock, timers }, POLICY_NO_FALLBACK);
    if (!g.ok) throw new Error(g.error.code);
    const ac = new AbortController();
    const pending = orchestratorOver(g.value).orchestrator.ask(INPUT, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, error: { code: "ABORTED" } });
  });
});
