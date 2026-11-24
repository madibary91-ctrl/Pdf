/** ابزار آزمونِ tool-runner (از index صادر نمی‌شود). همهٔ مقدارها ساختگیِ آزمون‌اند؛ هیچ قیمت/ارائه‌دهندهٔ واقعی نیست. */
import type { ModelLimits, Timers, ToolCall, ToolGateway, ToolWireFormat } from "@/modules/ai-gateway";
import { createToolLoop, type ToolLoop, type ToolLoopConfig } from "@/modules/tool-loop";
import { createToolRunner } from "./runner";
import type { ToolExecutor, ToolRunInput, ToolRunner, ToolRunnerOptions } from "./types";

export const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });
export const cost = (micros: number) => ({ micros, currency: "IRR", priceVersion: "v1" });
export const call = (id: string, args: unknown = { a: 1 }, name = "court_fee"): ToolCall => ({ id, name, argumentsJson: typeof args === "string" ? args : JSON.stringify(args) });

export function assistantFor(format: ToolWireFormat, calls: readonly ToolCall[]): Record<string, unknown> {
  return format === "openai-chat"
    ? { role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argumentsJson } })) }
    : { role: "assistant", content: calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: {} })) };
}

export function stepOk(over: Partial<{ text: string; finish: string; calls: readonly ToolCall[]; usage: unknown; cost: unknown; format: ToolWireFormat }> = {}): unknown {
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

export const stepErr = (code: string, over: Partial<{ usage: unknown; cost: unknown }> = {}): unknown => ({
  ok: false,
  error: { code, message: "x", retryable: false, warnings: [], usage: "usage" in over ? over.usage : null, cost: "cost" in over ? over.cost : null },
});

/** تایمرِ دستی: هیچ‌چیز خودکار اجرا نمی‌شود. */
export function fakeTimers() {
  let n = 0;
  const q = new Map<number, { fn: () => void; ms: number }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = ++n;
      q.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (h) => void q.delete(h as number),
  };
  return {
    timers,
    pending: () => q.size,
    pendingMs: () => [...q.values()].map((e) => e.ms),
    /** تایمرهایی با همین `ms` را (به ترتیبِ ثبت) اجرا می‌کند. */
    fire(ms: number): number {
      const hits = [...q.entries()].filter(([, e]) => e.ms === ms);
      for (const [id, e] of hits) {
        q.delete(id);
        e.fn();
      }
      return hits.length;
    },
  };
}

export const tick = (n = 5): Promise<void> => (n <= 0 ? Promise.resolve() : Promise.resolve().then(() => tick(n - 1)));

type GatewayStep = (input: Record<string, unknown>, signal: AbortSignal | undefined, index: number) => Promise<unknown> | unknown;

export function stubGateway(step: GatewayStep, over: Partial<{ format: ToolWireFormat | null; limits: ModelLimits | null }> = {}) {
  const inputs: Record<string, unknown>[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const gateway: ToolGateway = {
    completeStep: async (input, options) => {
      inputs.push(input as Record<string, unknown>);
      signals.push(options?.signal);
      return (await step(input as Record<string, unknown>, options?.signal, inputs.length - 1)) as never;
    },
    toolFormat: () => ("format" in over ? (over.format as ToolWireFormat | null) : "openai-chat"),
    limits: () => ("limits" in over ? (over.limits as ModelLimits | null) : { maxInputChars: 20_000, maxOutputTokens: 2000, priced: true }),
  };
  return { gateway, inputs, signals };
}

/** گامِ از پیش‌نوشته: i-امین پاسخ؛ پس از پایانِ فهرست پاسخِ متنیِ عادی. */
export const scripted = (replies: readonly unknown[]): GatewayStep => (_i, _s, idx) => replies[idx] ?? stepOk({ text: "پایان" });

export const LOOP_CFG: ToolLoopConfig = { maxSteps: 5, maxToolCalls: 8, maxIdenticalCalls: 2, truncationRetries: 1, budget: { kind: "none" } };
export function makeLoop(over: Partial<ToolLoopConfig> = {}): ToolLoop {
  const l = createToolLoop({ ...LOOP_CFG, ...over });
  if (!l.ok) throw new Error(JSON.stringify(l.error));
  return l.value;
}

export const okExec = (content = '{"v":1}', reviewPending = false): ToolExecutor => () => ({ ok: true, content, reviewPending });

export const TOOLS = [
  { name: "court_fee", description: "d", parameters: { type: "object" } },
  { name: "late_payment", description: "d", parameters: { type: "object" } },
] as const;
export const RUN_INPUT: ToolRunInput = { model: "legal", messages: [{ role: "user", content: "سلام" }], maxOutputTokens: 500, tools: TOOLS };

export function makeRunner(over: Partial<ToolRunnerOptions> & { gateway: ToolGateway }): ToolRunner {
  const r = createToolRunner({ loop: makeLoop(), executeTool: okExec(), totalTimeoutMs: 10_000, toolTimeoutMs: 1_000, maxResultChars: 4_000, ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}
