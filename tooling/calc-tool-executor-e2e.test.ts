import { describe, expect, it } from "vitest";
import { createHttpToolProvider } from "@/modules/ai-provider-http";
import { createToolGateway, sumStepSpend, type ToolWireFormat, type UsageEvent } from "@/modules/ai-gateway";
import { CALC_TOOLS } from "@/modules/calc-tools";
import { createCalcToolExecutor, type CalcToolExecutorOptions, type CalcToolObservation } from "@/modules/calc-tool-executor";
import { COURT_FEE_TARIFFS } from "@/modules/legal-calc";
import { createToolLoop } from "@/modules/tool-loop";
import { createToolRunner, type RunReport } from "@/modules/tool-runner";

/**
 * «fetchِ درون‌حافظه ← ai-provider-http ← ai-gateway ← tool-loop ← tool-runner ← **calc-tool-executor** ← calc-tools ← legal-calc»، همه واقعی (ADR-0059).
 * فقط مدلِ پشتِ fetch شبیه‌سازی است (پاسخ‌های از پیش‌نوشته)؛ هیچ سوکت/تماسِ اینترنتی/کلیدِ واقعی نیست.
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

function rig(format: ToolWireFormat, replies: readonly unknown[], executorOptions: CalcToolExecutorOptions = {}) {
  const bodies: string[] = [];
  const events: UsageEvent[] = [];
  const observations: CalcToolObservation[] = [];
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
  const ex = createCalcToolExecutor({ ...executorOptions, onResult: (o) => { observations.push(o); executorOptions.onResult?.(o); } });
  if (!ex.ok) throw new Error(JSON.stringify(ex.error));
  const r = createToolRunner({ gateway: g.value, loop: l.value, executeTool: ex.value, totalTimeoutMs: 10_000, toolTimeoutMs: 2_000, maxResultChars: 20_000 });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return { runner: r.value, bodies, events, observations };
}
const ok = async (p: Promise<{ ok: true; value: RunReport } | { ok: false; error: unknown }>): Promise<RunReport> => {
  const r = await p;
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("calc-tool-executor ⇄ tool-runner ⇄ calc-tools ⇄ legal-calc (سرتاسری)", () => {
  it.each(FORMATS)("%s: حلقهٔ دو‌گامی؛ نتیجهٔ بی‌واسطهٔ legal-calc در ناظر و reviewPending=true تا پایانِ حلقه", async (format) => {
    const { runner, bodies, events, observations } = rig(format, [toolReply(format, "call_1", "court_fee", GOOD), textReply(format, "هزینهٔ دادرسی محاسبه شد.")]);
    const out = await ok(runner.run(INPUT));
    expect(out.outcome).toMatchObject({ status: "answered", steps: 2, toolCalls: 1, reviewPending: true });
    expect(out.toolRuns).toEqual([{ id: "call_1", name: "court_fee", status: "ok", code: null, reviewPending: true }]);
    expect(out.outcome.spend).toEqual(sumStepSpend(events));
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ callId: "call_1", tool: "court_fee", reviewPending: true });
    expect(observations[0]!.notes.length).toBeGreaterThan(0);
    // مدل همان نتیجه را دیده است (محتوای دقیقاً از ناظر)، و پرچمِ بازبینی در محتوای رفته به مدل هست
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("call_1");
    expect(bodies[1]).toContain("pending-legal-review");
    expect(bodies[1]).toContain(JSON.stringify(JSON.stringify(observations[0]!.result)).slice(1, -1));
    expect(JSON.stringify(out)).not.toContain("sk-e2e-KEY-987");
  });

  it.each(FORMATS)("%s: جدولِ تزریقیِ «legally-verified» ⇒ reviewPending=false در ناظر، ممیزی و نتیجهٔ حلقه (فقط وقتی legal-calc بگوید)", async (format) => {
    const base = COURT_FEE_TARIFFS.find((t) => t.year === 1405);
    if (!base) throw new Error("جدول ۱۴۰۵ نیست");
    const verified = { ...base, review: { status: "legally-verified" as const, reviewedBy: "آزمون", reviewedOn: "1405-01-01" } };
    const { runner, observations } = rig(format, [toolReply(format, "call_1", "court_fee", { ...GOOD, date: { year: 1405, month: 6, day: 15 } }), textReply(format, "تمام.")], { deps: { courtFeeTariffs: [verified] } });
    const out = await ok(runner.run(INPUT));
    expect(out.outcome).toMatchObject({ status: "answered", reviewPending: false });
    expect(out.toolRuns[0]).toMatchObject({ status: "ok", reviewPending: false });
    expect(observations[0]).toMatchObject({ reviewPending: false, review: { status: "legally-verified" } });
  });

  it.each(FORMATS)("%s: آرگومانِ نادرست ⇒ خطا به مدل، ناظر صدا زده نمی‌شود؛ مدل اصلاح می‌کند", async (format) => {
    const { runner, bodies, observations } = rig(format, [
      toolReply(format, "call_1", "court_fee", { ...GOOD, claim: { kind: "known", amountRials: "صد" } }),
      toolReply(format, "call_2", "court_fee", GOOD),
      textReply(format, "اصلاح شد."),
    ]);
    const out = await ok(runner.run(INPUT));
    expect(out.outcome).toMatchObject({ status: "answered", toolCalls: 2, reviewPending: true });
    expect(out.toolRuns.map((t) => [t.id, t.status, t.code])).toEqual([["call_1", "error", "TOOL_REPORTED_ERROR"], ["call_2", "ok", null]]);
    expect(observations.map((o) => o.callId)).toEqual(["call_2"]);
    expect(bodies[1]).toContain("INVALID_INPUT");
  });

  it.each(FORMATS)("%s: ناظرِ پرتاب‌کننده ⇒ TOOL_FAILED؛ نه نتیجه و نه متنِ استثنا به مدل می‌رسد", async (format) => {
    const { runner, bodies } = rig(format, [toolReply(format, "call_1", "court_fee", GOOD), textReply(format, "ادامه.")], { onResult: () => { throw new Error("sink-down-SECRET"); } });
    const out = await ok(runner.run(INPUT));
    expect(out.toolRuns).toEqual([{ id: "call_1", name: "court_fee", status: "error", code: "TOOL_FAILED", reviewPending: false }]);
    expect(out.outcome).toMatchObject({ status: "answered", reviewPending: false });
    expect(bodies[1]).not.toContain("sink-down-SECRET");
    expect(bodies[1]).not.toContain("pending-legal-review");
  });

  it.each(FORMATS)("%s: ابزارِ بیرون از فهرستِ درخواست (حتی calc-tools واقعی) هرگز اجرا نمی‌شود", async (format) => {
    const { runner, observations } = rig(format, [toolReply(format, "call_1", "court_fee", GOOD), textReply(format, "باشد.")]);
    const out = await ok(runner.run({ ...INPUT, tools: CALC_TOOLS.filter((t) => t.name === "late_payment") }));
    expect(out.toolRuns[0]).toMatchObject({ name: "court_fee", code: "UNKNOWN_TOOL" });
    expect(observations).toHaveLength(0);
  });

  it.each(FORMATS)("%s: لغوِ فراخواننده پیش از اجرا ⇒ ابزار اجرا نمی‌شود و ناظر ساکت است", async (format) => {
    const { runner, observations, bodies } = rig(format, [toolReply(format, "call_1", "court_fee", GOOD)]);
    const ac = new AbortController();
    ac.abort();
    const out = await ok(runner.run(INPUT, { signal: ac.signal }));
    expect(out.abortedBy).toBe("caller");
    expect(observations).toHaveLength(0);
    expect(bodies.length).toBeLessThanOrEqual(1);
  });
});
