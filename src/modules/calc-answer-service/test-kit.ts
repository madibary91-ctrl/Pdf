/** ابزار آزمونِ calc-answer-service (از index صادر نمی‌شود). همهٔ مقدارها ساختگیِ آزمون‌اند، نه مرجعِ حقوقی/قیمتِ واقعی. */
import type { ModelLimits, ToolCall, ToolGateway } from "@/modules/ai-gateway";
import { createToolLoop, type ToolLoop, type ToolLoopConfig } from "@/modules/tool-loop";
import { createCalcAnswerService } from "./service";
import type { CalcAnswerService, CalcAnswerServiceOptions } from "./types";

export const GOOD = { date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } };
export const call = (id: string, args: unknown = GOOD, name = "court_fee"): ToolCall => ({ id, name, argumentsJson: JSON.stringify(args) });
export const USER = (content = "هزینهٔ دادرسی؟") => ({ messages: [{ role: "user", content }] });

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o });
const assistantFor = (calls: readonly ToolCall[]) => ({ role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argumentsJson } })) });

export function stepOk(over: Partial<{ text: string; calls: readonly ToolCall[] }> = {}): unknown {
  const calls = over.calls ?? [];
  return {
    ok: true,
    value: {
      text: over.text ?? (calls.length > 0 ? "" : "پاسخِ مدل"),
      toolCalls: calls,
      finish: calls.length > 0 ? "tool_calls" : "stop",
      assistantMessage: assistantFor(calls),
      format: "openai-chat",
      model: "legal",
      provider: "p",
      servedModel: null,
      requestId: null,
      usage: usage(100, 20),
      cost: { micros: 50, currency: "IRR", priceVersion: "v1" },
      latencyMs: 1,
      warnings: [],
    },
  };
}
export const stepErr = (code: string): unknown => ({ ok: false, error: { code, message: "x", retryable: false, warnings: [], usage: null, cost: null } });

type Step = (input: Record<string, unknown>, index: number) => Promise<unknown> | unknown;

export function stubGateway(step: Step, over: Partial<{ format: "openai-chat" | null; limits: ModelLimits | null; throwOnLimits: boolean }> = {}) {
  const inputs: Record<string, unknown>[] = [];
  const state = { format: ("format" in over ? over.format ?? null : "openai-chat") as "openai-chat" | null };
  const gateway: ToolGateway = {
    completeStep: async (input) => {
      inputs.push(input as Record<string, unknown>);
      return (await step(input as Record<string, unknown>, inputs.length - 1)) as never;
    },
    toolFormat: () => state.format,
    limits: (): ModelLimits | null => {
      if (over.throwOnLimits) throw new Error("sk-SECRET-limits");
      return "limits" in over ? over.limits ?? null : { maxInputChars: 20_000, maxOutputTokens: 2000, priced: true };
    },
  };
  return { gateway, inputs, state };
}
export const scripted = (replies: readonly unknown[]): Step => (_input, idx) => replies[idx] ?? stepOk({ text: "پایان" });

export const LOOP_CFG: ToolLoopConfig = { maxSteps: 5, maxToolCalls: 6, maxIdenticalCalls: 2, truncationRetries: 1, budget: { kind: "none" } };
export function makeLoop(over: Partial<ToolLoopConfig> = {}): ToolLoop {
  const l = createToolLoop({ ...LOOP_CFG, ...over });
  if (!l.ok) throw new Error(JSON.stringify(l.error));
  return l.value;
}

export function baseOptions(gateway: ToolGateway, over: Record<string, unknown> = {}): CalcAnswerServiceOptions {
  return { gateway, loop: makeLoop(), model: "legal", maxOutputTokens: 500, maxCards: 6, totalTimeoutMs: 10_000, toolTimeoutMs: 2_000, maxResultChars: 20_000, ...over } as CalcAnswerServiceOptions;
}
export function makeService(step: Step, over: Record<string, unknown> = {}): { service: CalcAnswerService; inputs: Record<string, unknown>[]; gateway: ToolGateway } {
  const { gateway, inputs } = stubGateway(step);
  const s = createCalcAnswerService(baseOptions(gateway, over));
  if (!s.ok) throw new Error(JSON.stringify(s.error));
  return { service: s.value, inputs, gateway };
}
