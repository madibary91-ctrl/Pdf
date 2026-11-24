/** ابزار آزمونِ calc-tool-executor (از index صادر نمی‌شود). همهٔ مقدارها ساختگیِ آزمون‌اند. */
import type { ToolExecution, ToolExecutor } from "@/modules/tool-runner";
import { createCalcToolExecutor } from "./executor";
import type { CalcToolExecutorOptions } from "./types";

export const COURT_ARGS = { date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } };
export const LATE_ARGS = { principalRials: 1_000_000, index: { mode: "manual", baseIndex: "100", paymentIndex: "150.5" } };

type ToolCall = Parameters<ToolExecutor>[0];

export const callOf = (name: string, args: unknown, id = "call_1"): ToolCall => ({ id, name, argumentsJson: typeof args === "string" ? args : JSON.stringify(args) });

export function makeExecutor(options?: CalcToolExecutorOptions): ToolExecutor {
  const r = createCalcToolExecutor(options);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** اجرای همگام؛ پورت می‌تواند Promise هم برگرداند، ولی این پیاده‌سازی همگام است (آزمون آن را هم قفل می‌کند). */
export function runSync(exec: ToolExecutor, call: ToolCall, signal: AbortSignal = new AbortController().signal): ToolExecution {
  const out = exec(call, { signal, callId: call.id });
  if (out instanceof Promise) throw new Error("پورتِ calc-tools باید همگام باشد");
  return out;
}

export const parse = (e: ToolExecution): Record<string, unknown> => JSON.parse(e.content) as Record<string, unknown>;
