import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TRUNCATED_TOOL_CALL_ISSUE,
  createToolGateway,
  encodeToolResults,
  sumStepSpend,
  type ToolModelProvider,
  type ToolProviderCall,
  type ToolSpec,
  type ToolWireFormat,
  type UsageEvent,
} from "@/modules/ai-gateway";
import { CALC_TOOLS, executeCalcToolJson } from "@/modules/calc-tools";

/**
 * حلقهٔ دو‌گامیِ «مدل ← دروازهٔ ابزار ← calc-tools ← دروازهٔ ابزار» (ADR-0055). ai-gateway و calc-tools عمداً از هم بی‌خبرند؛
 * فقط این‌جا می‌شود با هم دید. پاسخ‌های مدل **شبیه‌سازی‌اند** و قیمت‌ها ساختگی؛ هیچ تماسِ زنده‌ای نیست.
 */
const SPECS: readonly ToolSpec[] = CALC_TOOLS;
const FORMATS: readonly ToolWireFormat[] = ["openai-chat", "anthropic-messages"];
const PRICE = { currency: "IRR", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, version: "test-prices-v1" };
const GOOD_ARGS = { date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } };

const toolReply = (format: ToolWireFormat, id: string, args: unknown, rawArgs?: string, truncated = false): unknown =>
  format === "openai-chat"
    ? { model: "sim", choices: [{ index: 0, finish_reason: truncated ? "length" : "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "court_fee", arguments: rawArgs ?? JSON.stringify(args) } }] } }], usage: { prompt_tokens: 300, completion_tokens: 40 } }
    : { type: "message", role: "assistant", model: "sim", stop_reason: truncated ? "max_tokens" : "tool_use", content: [{ type: "tool_use", id, name: "court_fee", input: args }], usage: { input_tokens: 300, output_tokens: 40 } };
const textReply = (format: ToolWireFormat, text: string): unknown =>
  format === "openai-chat"
    ? { model: "sim", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }
    : { type: "message", role: "assistant", model: "sim", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 500, output_tokens: 60 } };

function build(format: ToolWireFormat, replies: readonly unknown[]) {
  const calls: ToolProviderCall[] = [];
  let i = 0;
  const provider: ToolModelProvider = {
    completeWithTools: (c) => {
      calls.push(c);
      return Promise.resolve(replies[i++]);
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
  return { gw: g.value, calls, events };
}
const BASE = { model: "legal", messages: [{ role: "user", content: "هزینهٔ دادرسی دعوای ۱۰۰ میلیون ریالی؟" }], maxOutputTokens: 500, tools: SPECS };

describe("ai-gateway ⇄ calc-tools: حلقهٔ دو‌گامی با دروازهٔ ابزار", () => {
  it.each(FORMATS)("%s: توصیفِ calc-tools کامل به ارائه‌دهنده می‌رسد؛ ابزار اجرا، نتیجه برگشت، پاسخِ نهایی؛ هزینهٔ دو گام جمع می‌شود", async (format) => {
    const { gw, calls, events } = build(format, [toolReply(format, "call_1", GOOD_ARGS), textReply(format, "هزینهٔ دادرسی محاسبه شد.")]);
    const s1 = await gw.completeStep(BASE);
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    expect(calls[0]!.tools["tools"]).toHaveLength(CALC_TOOLS.length);
    expect(s1.value.finish).toBe("tool_calls");

    const results = s1.value.toolCalls.map((c) => {
      const r = executeCalcToolJson(c.name, c.argumentsJson);
      expect(r.ok).toBe(true);
      return { id: c.id, content: JSON.stringify(r.ok ? { result: r.value.result, review: r.value.review, reviewPending: r.value.reviewPending, notes: r.value.notes } : r), isError: !r.ok };
    });
    const format1 = gw.toolFormat("legal");
    expect(format1).toBe(format);
    const enc = encodeToolResults(format1, s1.value.toolCalls, results);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const s2 = await gw.completeStep({ ...BASE, continuation: [s1.value.assistantMessage, ...enc.value] });
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    expect(s2.value.finish).toBe("stop");
    expect(calls[1]!.continuation).toHaveLength(1 + enc.value.length);
    expect(JSON.stringify(calls[1]!.continuation)).toContain("reviewPending");

    const spend = sumStepSpend([s1.value, s2.value]);
    expect(spend.complete).toBe(true);
    expect(spend.usage).toEqual({ inputTokens: 800, outputTokens: 100, totalTokens: 900 });
    // ⌈(300×3e6+40×15e6)/1e6⌉ = 1500 ؛ ⌈(500×3e6+60×15e6)/1e6⌉ = 2400
    expect(spend.cost).toEqual([{ currency: "IRR", priceVersion: "test-prices-v1", micros: 3900 }]);
    expect(events.map((e) => e.outcome)).toEqual(["ok", "ok"]);
    expect(sumStepSpend(events).usage.totalTokens).toBe(900);
  });
  it.each(FORMATS)("%s: آرگومانِ نادرستِ مدل در مرزِ اجرا خطای قابل‌بازگشت می‌شود و گامِ بعد همچنان معتبر است", async (format) => {
    const bad = { ...GOOD_ARGS, claim: { kind: "known", amountRials: "صد" } };
    const { gw } = build(format, [toolReply(format, "call_9", bad), textReply(format, "اصلاح شد.")]);
    const s1 = await gw.completeStep(BASE);
    if (!s1.ok) throw new Error("انتظار موفقیت");
    const out = s1.value.toolCalls.map((c) => {
      const r = executeCalcToolJson(c.name, c.argumentsJson);
      return { id: c.id, content: JSON.stringify(r.ok ? r.value : { error: r.error }), isError: !r.ok };
    });
    expect(out[0]?.isError).toBe(true);
    const enc = encodeToolResults(format, s1.value.toolCalls, out);
    if (!enc.ok) throw new Error("انتظار موفقیت");
    expect((await gw.completeStep({ ...BASE, continuation: [s1.value.assistantMessage, ...enc.value] })).ok).toBe(true);
  });
  it.each(FORMATS)("%s: فراخوانیِ بریده هرگز به اجرا نمی‌رسد؛ خطا نشانهٔ ثابت و مصرفِ هزینه‌شده دارد", async (format) => {
    const { gw, events } = build(format, [toolReply(format, "call_t", { date: { year: 14 } }, '{"date":{"year":14', true)]);
    const r = await gw.completeStep(BASE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.issues?.[0]).toBe(TRUNCATED_TOOL_CALL_ISSUE);
    expect(r.error.usage?.totalTokens).toBe(340);
    expect(sumStepSpend([r.error]).cost).toEqual([{ currency: "IRR", priceVersion: "test-prices-v1", micros: 1500 }]);
    expect(events[0]?.outcome).toBe("PROVIDER_BAD_RESPONSE");
  });
  it("منبعِ تازهٔ ai-gateway بی‌وابستگی به calc-tools است (ساختاری: ToolSpec)", () => {
    const dir = join(__dirname, "..", "src", "modules", "ai-gateway");
    const files = readdirSync(dir).filter((f) => /^tool-step.*\.ts$/.test(f) && !f.endsWith(".test.ts"));
    expect(files.sort()).toEqual(["tool-step-config.ts", "tool-step-request.ts", "tool-step-spend.ts", "tool-step-types.ts", "tool-step.ts"]);
    for (const f of files) expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/calc-tools/);
  });
});
