/** ابزار آزمونِ tool-loop (از index صادر نمی‌شود). همهٔ مقدارها ساختگیِ آزمون‌اند؛ هیچ قیمت/ارائه‌دهندهٔ واقعی نیست. */
import { TRUNCATED_TOOL_CALL_ISSUE } from "@/modules/ai-gateway";
import type { ToolCall, ToolWireFormat } from "@/modules/ai-gateway";
import { createToolLoop } from "./loop";
import type { LoopAction, LoopOutcome, LoopResult, LoopStartInput, LoopTransition, ToolLoop } from "./types";

export const START: LoopStartInput = { format: "openai-chat", maxOutputTokens: 500, modelMaxOutputTokens: 2000 };
export const BASE_CONFIG = { maxSteps: 5, maxToolCalls: 8, maxIdenticalCalls: 2, truncationRetries: 1, budget: { kind: "none" } } as const;

export const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });
export const cost = (micros: number, currency = "IRR", priceVersion = "v1") => ({ micros, currency, priceVersion });
export const call = (id: string, args: unknown = { a: 1 }, name = "court_fee"): ToolCall => ({ id, name, argumentsJson: typeof args === "string" ? args : JSON.stringify(args) });

export function assistantFor(format: ToolWireFormat, calls: readonly ToolCall[]): Record<string, unknown> {
  return format === "openai-chat"
    ? { role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argumentsJson } })) }
    : { role: "assistant", content: calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: {} })) };
}

type StepOver = Partial<{ text: string; finish: string; calls: readonly ToolCall[]; usage: unknown; cost: unknown; format: ToolWireFormat }>;

/** نتیجهٔ موفقِ `completeStep` (شکلِ `ToolStepResult`). پیش‌فرض: پاسخِ متنیِ عادی با مصرف/هزینهٔ معلوم. */
export function stepOk(over: StepOver = {}): unknown {
  const calls = over.calls ?? [];
  const format = over.format ?? "openai-chat";
  return {
    ok: true,
    value: {
      text: over.text ?? (calls.length > 0 ? "" : "پاسخ"),
      toolCalls: calls,
      finish: over.finish ?? (calls.length > 0 ? "tool_calls" : "stop"),
      assistantMessage: assistantFor(format, calls),
      format,
      model: "legal",
      provider: "p",
      servedModel: null,
      requestId: null,
      usage: "usage" in over ? over.usage : usage(100, 20),
      cost: "cost" in over ? over.cost : cost(50),
      latencyMs: 1,
      warnings: [],
    },
  };
}

export function stepErr(code: string, over: Partial<{ usage: unknown; cost: unknown; issues: readonly string[] }> = {}): unknown {
  return { ok: false, error: { code, message: "x", retryable: false, warnings: [], ...(over.issues ? { issues: over.issues } : {}), usage: "usage" in over ? over.usage : usage(100, 20), cost: "cost" in over ? over.cost : cost(50) } };
}

export const stepTruncated = (over: Parameters<typeof stepErr>[1] = {}): unknown => stepErr("PROVIDER_BAD_RESPONSE", { issues: [TRUNCATED_TOOL_CALL_ISSUE, "x"], ...over });

export const okResults = (calls: readonly ToolCall[], over: Partial<{ content: string; reviewPending: boolean; isError: boolean }> = {}) =>
  calls.map((c) => ({ id: c.id, content: over.content ?? `{"id":"${c.id}"}`, reviewPending: over.reviewPending ?? false, ...(over.isError === undefined ? {} : { isError: over.isError }) }));

export function must<T>(r: LoopResult<T>): T {
  if (!r.ok) throw new Error(`انتظارِ موفقیت: ${JSON.stringify(r.error)}`);
  return r.value;
}
export function mustFail<T>(r: LoopResult<T>) {
  if (r.ok) throw new Error("انتظارِ شکست");
  return r.error;
}

export function mkLoop(over: Record<string, unknown> = {}): ToolLoop {
  return must(createToolLoop({ ...BASE_CONFIG, ...over }));
}

export function outcomeOf(t: LoopTransition): LoopOutcome {
  if (t.action.kind !== "done") throw new Error(`انتظارِ done؛ دریافت شد ${t.action.kind}`);
  return t.action.outcome;
}

export type DriveResult = Readonly<{ actions: readonly LoopAction[]; outcome: LoopOutcome; last: LoopTransition }>;

/** حلقهٔ مجریِ آزمون: هر `call-model` یک نتیجهٔ بعدی از `steps` می‌گیرد و هر `run-tools` از `tools`. */
export function drive(loop: ToolLoop, start: LoopStartInput, steps: (action: Extract<LoopAction, { kind: "call-model" }>, n: number) => unknown, tools: (calls: readonly ToolCall[]) => unknown = (c) => okResults(c)): DriveResult {
  let t = must(loop.start(start));
  const actions: LoopAction[] = [t.action];
  let n = 0;
  for (let guard = 0; guard < 200 && t.action.kind !== "done"; guard++) {
    t = t.action.kind === "call-model" ? must(loop.onStep(t.state, steps(t.action, n++))) : must(loop.onToolResults(t.state, tools(t.action.calls)));
    actions.push(t.action);
  }
  return { actions, outcome: outcomeOf(t), last: t };
}
