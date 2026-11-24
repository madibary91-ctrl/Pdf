import { describe, expect, it } from "vitest";
import { createHttpToolProvider } from "@/modules/ai-provider-http";
import { createToolGateway, type ToolWireFormat, type UsageEvent } from "@/modules/ai-gateway";
import { createCardCollector, NOTICES, type CardCollector } from "@/modules/calc-answer-cards";
import { CALC_TOOLS } from "@/modules/calc-tools";
import { createCalcToolExecutor, type CalcToolExecutorOptions, type CalcToolObservation } from "@/modules/calc-tool-executor";
import { COURT_FEE_TARIFFS } from "@/modules/legal-calc";
import { createToolLoop } from "@/modules/tool-loop";
import { createToolRunner, type RunReport } from "@/modules/tool-runner";

/**
 * «fetchِ درون‌حافظه ← ai-provider-http ← ai-gateway ← tool-loop ← tool-runner ← calc-tool-executor ← **calc-answer-cards**»، همه واقعی (ADR-0060).
 * فقط مدلِ پشتِ fetch شبیه‌سازی است؛ هیچ سوکت/تماسِ اینترنتی/کلیدِ واقعی نیست.
 */
const FORMATS: readonly ToolWireFormat[] = ["openai-chat", "anthropic-messages"];
const PRICE = { currency: "IRR", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, version: "test-prices-v1" };
const GOOD = { date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } };
const INPUT = { model: "legal", messages: [{ role: "user", content: "هزینهٔ دادرسی؟" }], maxOutputTokens: 500, tools: CALC_TOOLS };

const toolReply = (format: ToolWireFormat, id: string, name: string, args: unknown): unknown =>
  format === "openai-chat"
    ? { model: "served", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }
    : { type: "message", role: "assistant", model: "served", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input: args }], usage: { input_tokens: 1000, output_tokens: 200 } };
const textReply = (format: ToolWireFormat, text: string): unknown =>
  format === "openai-chat"
    ? { model: "served", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }
    : { type: "message", role: "assistant", model: "served", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 500, output_tokens: 60 } };

function rig(format: ToolWireFormat, replies: readonly unknown[], opts: { deps?: CalcToolExecutorOptions["deps"]; maxCards?: number; maxResultChars?: number; collector?: CardCollector } = {}) {
  const bodies: string[] = [];
  const events: UsageEvent[] = [];
  const observations: CalcToolObservation[] = [];
  const cc = opts.collector ?? (() => { const m = createCardCollector({ maxCards: opts.maxCards ?? 6 }); if (!m.ok) throw new Error(JSON.stringify(m.error)); return m.value; })();
  const fetchFn = (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    const next = replies[bodies.length - 1];
    return Promise.resolve(next === undefined ? new Response("", { status: 599 }) : new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } }));
  };
  const p = createHttpToolProvider({ format, endpoint: `https://models.example.invalid/${format}`, getApiKey: () => "sk-e2e-KEY-987", fetch: fetchFn as never });
  if (!p.ok) throw new Error(JSON.stringify(p.error));
  const g = createToolGateway(
    {
      providers: { p: { complete: () => Promise.reject(new Error("unused")) } },
      models: { legal: { provider: "p", providerModel: "served-model-x", maxInputChars: 20_000, maxOutputTokens: 2048, price: PRICE } },
      clock: { nowMs: () => Date.now() },
      usageSink: { record: (e: UsageEvent) => void events.push(e) },
    },
    { models: { legal: { format, provider: p.value } } },
  );
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const l = createToolLoop({ maxSteps: 5, maxToolCalls: 6, maxIdenticalCalls: 2, truncationRetries: 1, budget: { kind: "none" } });
  if (!l.ok) throw new Error(JSON.stringify(l.error));
  const ex = createCalcToolExecutor({ ...(opts.deps ? { deps: opts.deps } : {}), onResult: (o) => { observations.push(o); cc.observe(o); } });
  if (!ex.ok) throw new Error(JSON.stringify(ex.error));
  const r = createToolRunner({ gateway: g.value, loop: l.value, executeTool: ex.value, totalTimeoutMs: 10_000, toolTimeoutMs: 2_000, maxResultChars: opts.maxResultChars ?? 20_000 });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return { runner: r.value, bodies, events, observations, cc };
}
const ok = async (p: Promise<{ ok: true; value: RunReport } | { ok: false; error: unknown }>): Promise<RunReport> => {
  const r = await p;
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("calc-answer-cards ⇄ calc-tool-executor ⇄ tool-runner (سرتاسری)", () => {
  it.each(FORMATS)("%s: کارت از ناظرِ legal-calc؛ مدل عددِ غلط نقل می‌کند ولی کارت عددِ درست و هشدار را دارد", async (format) => {
    const { runner, observations, cc } = rig(format, [toolReply(format, "call_1", "court_fee", GOOD), textReply(format, "هزینهٔ دادرسی دقیقاً ۱ ریال است.")]);
    const report = await ok(runner.run(INPUT));
    const composed = cc.compose(report);
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const v = composed.value;
    expect(v.text).toBe("هزینهٔ دادرسی دقیقاً ۱ ریال است."); // متنِ مدل دست‌نخورده (و ممکن است غلط باشد)
    expect(v.cards).toHaveLength(1);
    expect(v.cards[0]!.result).toEqual(JSON.parse(JSON.stringify(observations[0]!.result)));
    expect(v.cards[0]!.notes).toEqual(observations[0]!.notes);
    expect(v.cards[0]!.notes.length).toBeGreaterThan(0);
    expect(JSON.stringify(v.cards[0]!.result)).not.toContain("دقیقاً ۱ ریال");
    expect(v.reviewPending).toBe(true);
    expect(v.notices).toEqual([NOTICES.reviewPending, NOTICES.cardPrecedence]);
    expect(v.droppedCards).toBe(0);
    expect(JSON.stringify(v)).not.toContain("sk-e2e-KEY-987");
  });

  it.each(FORMATS)("%s: جدولِ تزریقیِ legally-verified ⇒ کارتِ تأییدشده بی‌اعلانِ تأییدنشدگی", async (format) => {
    const base = COURT_FEE_TARIFFS.find((t) => t.year === 1405);
    if (!base) throw new Error("جدول ۱۴۰۵ نیست");
    const verified = { ...base, review: { status: "legally-verified" as const, reviewedBy: "آزمون", reviewedOn: "1405-01-01" } };
    const { runner, cc } = rig(format, [toolReply(format, "call_1", "court_fee", { ...GOOD, date: { year: 1405, month: 6, day: 15 } }), textReply(format, "تمام.")], { deps: { courtFeeTariffs: [verified] } });
    const composed = cc.compose(await ok(runner.run(INPUT)));
    expect(composed.ok && composed.value.reviewPending).toBe(false);
    expect(composed.ok && composed.value.notices).toEqual([NOTICES.cardPrecedence]);
    expect(composed.ok && composed.value.cards[0]).toMatchObject({ reviewPending: false, reviewLabel: "تأییدشده توسط آزمون در تاریخ 1405-01-01." });
  });

  it.each(FORMATS)("%s: سقفِ کارت پر شود ⇒ ناظر پرتاب می‌کند، فراخوانیِ دوم TOOL_FAILED و نتیجه‌اش به مدل نمی‌رسد؛ پاسخ با یک کارتِ درست", async (format) => {
    const { runner, bodies, observations, cc } = rig(
      format,
      [toolReply(format, "call_1", "court_fee", GOOD), toolReply(format, "call_2", "court_fee", { ...GOOD, claim: { kind: "known", amountRials: 200_000_000 } }), textReply(format, "پایان.")],
      { maxCards: 1 },
    );
    const report = await ok(runner.run(INPUT));
    expect(report.toolRuns.map((t) => [t.id, t.status, t.code])).toEqual([["call_1", "ok", null], ["call_2", "error", "TOOL_FAILED"]]);
    expect(observations).toHaveLength(2);
    expect(JSON.stringify(observations[0]!.result)).not.toBe(JSON.stringify(observations[1]!.result));
    expect(bodies[2]).toContain(JSON.stringify(JSON.stringify(observations[0]!.result)).slice(1, -1));
    expect(bodies[2]).not.toContain(JSON.stringify(JSON.stringify(observations[1]!.result)).slice(1, -1));
    const composed = cc.compose(report);
    expect(composed.ok && composed.value.cards.map((c) => c.callId)).toEqual(["call_1"]);
    expect(composed.ok && composed.value.droppedCards).toBe(0);
  });

  it.each(FORMATS)("%s: نتیجهٔ بزرگ‌تر از سقف (به مدل نمی‌رسد) ⇒ کارتش نمایش داده نمی‌شود و در droppedCards می‌آید", async (format) => {
    const { runner, bodies, observations, cc } = rig(format, [toolReply(format, "call_1", "court_fee", GOOD), textReply(format, "نتیجه‌ای نشد.")], { maxResultChars: 64 });
    const report = await ok(runner.run(INPUT));
    expect(report.toolRuns[0]).toMatchObject({ status: "error", code: "TOOL_RESULT_TOO_LARGE" });
    expect(observations).toHaveLength(1); // ناظر پیش از مجری دیده
    expect(bodies[1]).not.toContain("pending-legal-review");
    const composed = cc.compose(report);
    expect(composed.ok && composed.value).toMatchObject({ cards: [], droppedCards: 1, reviewPending: false, text: "نتیجه‌ای نشد." });
  });

  it.each(FORMATS)("%s: جمع‌آورندهٔ وصل‌نشده (ناظر فراموش شده) ⇒ CARD_MISSING و پاسخ نمایش داده نمی‌شود", async (format) => {
    const { runner } = rig(format, [toolReply(format, "call_1", "court_fee", GOOD), textReply(format, "پاسخِ مدل")]);
    const stray = createCardCollector({ maxCards: 3 });
    if (!stray.ok) throw new Error("x");
    const composed = stray.value.compose(await ok(runner.run(INPUT)));
    expect(composed.ok).toBe(false);
    expect(!composed.ok && composed.error.code).toBe("CARD_MISSING");
    expect(JSON.stringify(composed)).not.toContain("پاسخِ مدل");
  });

  it.each(FORMATS)("%s: استفادهٔ دوباره از یک جمع‌آورنده در اجرای دوم ⇒ callIdِ تکراری شکست‌بسته (TOOL_FAILED)", async (format) => {
    const first = rig(format, [toolReply(format, "call_1", "court_fee", GOOD), textReply(format, "یک")]);
    await ok(first.runner.run(INPUT));
    const second = rig(format, [toolReply(format, "call_1", "court_fee", GOOD), textReply(format, "دو")], { collector: first.cc });
    const report = await ok(second.runner.run(INPUT));
    expect(report.toolRuns[0]).toMatchObject({ status: "error", code: "TOOL_FAILED" });
    expect(first.cc.snapshot()).toHaveLength(1);
  });

  it.each(FORMATS)("%s: آرگومانِ نادرست و اصلاح ⇒ فقط کارتِ اجرای موفق", async (format) => {
    const { runner, cc } = rig(format, [
      toolReply(format, "call_1", "court_fee", { ...GOOD, claim: { kind: "known", amountRials: "صد" } }),
      toolReply(format, "call_2", "court_fee", GOOD),
      textReply(format, "اصلاح شد."),
    ]);
    const composed = cc.compose(await ok(runner.run(INPUT)));
    expect(composed.ok && composed.value.cards.map((c) => c.callId)).toEqual(["call_2"]);
    expect(composed.ok && composed.value.droppedCards).toBe(0);
  });

  it.each(FORMATS)("%s: لغوِ فراخواننده پیش از اجرا ⇒ بی‌کارت؛ ترکیب ممکن و abortedBy حفظ می‌شود", async (format) => {
    const { runner, cc } = rig(format, [toolReply(format, "call_1", "court_fee", GOOD)]);
    const ac = new AbortController();
    ac.abort();
    const composed = cc.compose(await ok(runner.run(INPUT, { signal: ac.signal })));
    expect(composed.ok).toBe(true);
    expect(composed.ok && composed.value).toMatchObject({ cards: [], abortedBy: "caller" });
  });

  it.each(FORMATS)("%s: ابزارِ بیرون از فهرست ⇒ نه اجرا، نه کارت", async (format) => {
    const { runner, cc } = rig(format, [toolReply(format, "call_1", "court_fee", GOOD), textReply(format, "باشد.")]);
    const report = await ok(runner.run({ ...INPUT, tools: CALC_TOOLS.filter((t) => t.name === "late_payment") }));
    const composed = cc.compose(report);
    expect(composed.ok && composed.value.cards).toEqual([]);
  });
});
