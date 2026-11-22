import { describe, expect, it } from "vitest";
import {
  createToolGateway,
  sumStepSpend,
  type ToolGateway,
  type ToolModelProvider,
  type ToolProviderCall,
  type ToolSpec,
  type ToolWireFormat,
  type UsageEvent,
} from "@/modules/ai-gateway";
import { CALC_TOOLS, executeCalcToolJson } from "@/modules/calc-tools";
import { createToolLoop, type LoopOutcome, type ToolLoop, type ToolLoopConfig } from "@/modules/tool-loop";

/**
 * «مدل ← دروازهٔ ابزار ← کنترل‌گرِ حلقه ← calc-tools ← …» (ADR-0056). ماژول‌ها عمداً از هم بی‌خبرند و فقط این‌جا کنار هم
 * دیده می‌شوند. مجریِ این آزمون کوچک است و **فقط آزمون** است (مجریِ واقعی برشِ بعد). پاسخ‌های مدل شبیه‌سازی‌اند؛
 * قیمت‌ها ساختگی؛ هیچ تماسِ زنده‌ای نیست.
 */
const SPECS: readonly ToolSpec[] = CALC_TOOLS;
const FORMATS: readonly ToolWireFormat[] = ["openai-chat", "anthropic-messages"];
const PRICE = { currency: "IRR", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, version: "test-prices-v1" };
const GOOD = { date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } };

type Reply = Readonly<{ kind: "tool"; id: string; args: unknown; raw?: string; truncated?: boolean } | { kind: "text"; text: string }>;
const wire = (format: ToolWireFormat, r: Reply): unknown => {
  if (r.kind === "text") {
    return format === "openai-chat"
      ? { model: "sim", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: r.text } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }
      : { type: "message", role: "assistant", model: "sim", stop_reason: "end_turn", content: [{ type: "text", text: r.text }], usage: { input_tokens: 500, output_tokens: 60 } };
  }
  return format === "openai-chat"
    ? { model: "sim", choices: [{ index: 0, finish_reason: r.truncated ? "length" : "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: r.id, type: "function", function: { name: "court_fee", arguments: r.raw ?? JSON.stringify(r.args) } }] } }], usage: { prompt_tokens: 300, completion_tokens: 40 } }
    : { type: "message", role: "assistant", model: "sim", stop_reason: r.truncated ? "max_tokens" : "tool_use", content: [{ type: "tool_use", id: r.id, name: "court_fee", input: r.args }], usage: { input_tokens: 300, output_tokens: 40 } };
};

function rig(format: ToolWireFormat, replies: readonly Reply[], loopOver: Partial<ToolLoopConfig> = {}) {
  const calls: ToolProviderCall[] = [];
  let i = 0;
  const provider: ToolModelProvider = {
    completeWithTools: (c) => {
      calls.push(c);
      const r = replies[i++];
      return Promise.resolve(r === undefined ? wire(format, { kind: "text", text: "پایان" }) : wire(format, r));
    },
  };
  const events: UsageEvent[] = [];
  const g = createToolGateway(
    {
      providers: { p: { complete: () => Promise.reject(new Error("unused")) } },
      models: { legal: { provider: "p", providerModel: "pm", maxInputChars: 20_000, maxOutputTokens: 2048, price: PRICE } },
      clock: { nowMs: () => 1_700_000_000_000 },
      usageSink: { record: (e: UsageEvent) => void events.push(e) },
    },
    { models: { legal: { format, provider } } },
  );
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  const l = createToolLoop({ maxSteps: 5, maxToolCalls: 6, maxIdenticalCalls: 2, truncationRetries: 1, budget: { kind: "none" }, ...loopOver });
  if (!l.ok) throw new Error(JSON.stringify(l.error));
  return { gw: g.value, loop: l.value, calls, events };
}

const REQ = { model: "legal", messages: [{ role: "user", content: "هزینهٔ دادرسی دعوای ۱۰۰ میلیون ریالی؟" }], tools: SPECS };

/** مجریِ آزمون: هر کنش را اجرا می‌کند؛ calc-tools واقعی. */
async function run(gw: ToolGateway, loop: ToolLoop, format: ToolWireFormat, maxOutputTokens = 500): Promise<Readonly<{ outcome: LoopOutcome; asked: number[] }>> {
  const limits = gw.limits("legal");
  if (limits === null || gw.toolFormat("legal") !== format) throw new Error("پیکربندیِ آزمون");
  const started = loop.start({ format, maxOutputTokens, modelMaxOutputTokens: limits.maxOutputTokens });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  let t = started.value;
  const asked: number[] = [];
  for (let guard = 0; guard < 50; guard++) {
    const a = t.action;
    if (a.kind === "done") return { outcome: a.outcome, asked };
    let next;
    if (a.kind === "call-model") {
      asked.push(a.maxOutputTokens);
      const step = await gw.completeStep({ ...REQ, maxOutputTokens: a.maxOutputTokens, continuation: a.continuation });
      next = loop.onStep(t.state, step);
    } else {
      const results = a.calls.map((c) => {
        const r = executeCalcToolJson(c.name, c.argumentsJson);
        return r.ok
          ? { id: c.id, content: JSON.stringify({ result: r.value.result, review: r.value.review, reviewPending: r.value.reviewPending, notes: r.value.notes }), reviewPending: r.value.reviewPending }
          : { id: c.id, content: JSON.stringify({ error: r.error }), isError: true };
      });
      next = loop.onToolResults(t.state, results);
    }
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    t = next.value;
  }
  throw new Error("حلقه پایان نیافت");
}

describe("tool-loop ⇄ ai-gateway ⇄ calc-tools: حلقهٔ کاملِ مدل ← ابزار ← پاسخ", () => {
  it.each(FORMATS)("%s: دو گام؛ هزینهٔ حلقه = جمعِ رویدادهای مصرف؛ reviewPending از خروجیِ واقعیِ calc-tools می‌آید", async (format) => {
    const { gw, loop, calls, events } = rig(format, [{ kind: "tool", id: "call_1", args: GOOD }, { kind: "text", text: "هزینهٔ دادرسی محاسبه شد." }]);
    const { outcome } = await run(gw, loop, format);
    expect(outcome.status).toBe("answered");
    if (outcome.status !== "answered") return;
    expect(outcome.text).toBe("هزینهٔ دادرسی محاسبه شد.");
    expect(outcome).toMatchObject({ steps: 2, toolCalls: 1 });
    // جدول‌های legal-calc هنوز تأییدِ حقوقدان ندارند؛ کنترل‌گر باید این را به مصرف‌کننده برساند.
    const real = executeCalcToolJson("court_fee", JSON.stringify(GOOD));
    expect(real.ok && real.value.reviewPending).toBe(true);
    expect(outcome.reviewPending).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.continuation).toHaveLength(format === "openai-chat" ? 2 : 2);
    // ⌈(300×3e6+40×15e6)/1e6⌉ = 1500 ؛ ⌈(500×3e6+60×15e6)/1e6⌉ = 2400
    expect(outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "test-prices-v1", micros: 3900 }]);
    expect(outcome.spend).toEqual(sumStepSpend(events));
    expect(outcome.spend.complete).toBe(true);
  });

  it.each(FORMATS)("%s: آرگومانِ نادرستِ مدل خطای ابزار می‌شود، reviewPending نمی‌دهد و حلقه ادامه می‌یابد", async (format) => {
    const bad = { ...GOOD, claim: { kind: "known", amountRials: "صد" } };
    const { gw, loop } = rig(format, [{ kind: "tool", id: "call_9", args: bad }, { kind: "text", text: "اصلاح شد." }]);
    const { outcome } = await run(gw, loop, format);
    expect(outcome).toMatchObject({ status: "answered", toolCalls: 1, reviewPending: false });
  });

  it.each(FORMATS)("%s: فراخوانیِ بریده ⇒ یک تلاش با سقفِ خروجیِ دوبرابر؛ هزینهٔ پاسخِ بریده هم شمرده می‌شود", async (format) => {
    const { gw, loop, events } = rig(format, [{ kind: "tool", id: "t1", args: GOOD, truncated: true }, { kind: "tool", id: "t2", args: GOOD }, { kind: "text", text: "تمام." }]);
    const { outcome, asked } = await run(gw, loop, format);
    expect(asked).toEqual([500, 1000, 1000]);
    expect(outcome).toMatchObject({ status: "answered", steps: 3, toolCalls: 1 });
    expect(events).toHaveLength(3);
    expect(outcome.spend).toEqual(sumStepSpend(events));
  });

  it.each(FORMATS)("%s: مدلی که همان فراخوانی را مدام تکرار می‌کند با REPEATED_CALL می‌ایستد (پیش از اجرای سوم)", async (format) => {
    const { gw, loop, calls } = rig(format, Array.from({ length: 6 }, (_v, n): Reply => ({ kind: "tool", id: `call_${n}`, args: n % 2 === 0 ? GOOD : JSON.parse(JSON.stringify(GOOD)) })));
    const { outcome } = await run(gw, loop, format);
    expect(outcome).toMatchObject({ status: "stopped", reason: "REPEATED_CALL", steps: 3, toolCalls: 2 });
    expect(calls).toHaveLength(3);
    expect(outcome.spend.steps).toBe(3);
  });

  it.each(FORMATS)("%s: سقفِ هزینه با برآوردگرِ تزریقی؛ حلقه پیش از گامِ دوم می‌ایستد و هزینهٔ خرج‌شده گزارش می‌شود", async (format) => {
    // گام ۱ ۱۵۰۰ هزینه دارد؛ برآوردِ بدترین گام ۲۰۰۰ ⇒ ۳۵۰۰ > ۳۰۰۰.
    const { gw, loop, calls } = rig(format, [{ kind: "tool", id: "c1", args: GOOD }, { kind: "text", text: "هرگز" }], {
      budget: { kind: "cap", currency: "IRR", maxMicros: 3000, estimateStepMicros: () => 2000 },
    });
    // بیش از نیمِ سقف پیش از شروع برآورد می‌شود (۲۰۰۰ ≤ ۳۰۰۰ مجاز است)؛ بعد از گام ۱ مجاز نیست.
    const { outcome } = await run(gw, loop, format);
    expect(outcome).toMatchObject({ status: "stopped", reason: "BUDGET_EXCEEDED", steps: 1, toolCalls: 0 });
    expect(outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "test-prices-v1", micros: 1500 }]);
    expect(calls).toHaveLength(1);
  });

  it.each(FORMATS)("%s: سقفِ گام ۱ ⇒ ابزار اجرا نمی‌شود و پاسخی داده نمی‌شود", async (format) => {
    const { gw, loop } = rig(format, [{ kind: "tool", id: "c1", args: GOOD }], { maxSteps: 1 });
    const { outcome } = await run(gw, loop, format);
    expect(outcome).toMatchObject({ status: "stopped", reason: "MAX_STEPS", toolCalls: 0 });
    expect("text" in outcome).toBe(false);
  });
});
