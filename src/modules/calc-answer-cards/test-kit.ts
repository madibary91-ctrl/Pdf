/** ابزار آزمونِ calc-answer-cards (از index صادر نمی‌شود). همهٔ مقدارها ساختگیِ آزمون‌اند، نه مرجعِ حقوقی. */
import type { CalcToolObservation } from "@/modules/calc-tool-executor";
import type { RunReport } from "@/modules/tool-runner";
import { createCardCollector } from "./collector";
import type { CardCollector } from "./types";

export const PENDING_REVIEW = { status: "pending-legal-review", reviewedBy: null, reviewedOn: null } as const;
export const VERIFIED_REVIEW = { status: "legally-verified", reviewedBy: "حقوقدانِ آزمون", reviewedOn: "1405-01-01" } as const;

export function obs(over: Partial<{ callId: string; tool: string; result: unknown; review: unknown; reviewPending: unknown; notes: unknown }> = {}): CalcToolObservation {
  return {
    callId: "call_1",
    tool: "court_fee",
    result: { total: 42, parts: [1, 2], nested: { a: null } },
    review: PENDING_REVIEW,
    reviewPending: true,
    notes: ["یادداشتِ آزمون"],
    ...over,
  } as unknown as CalcToolObservation;
}

type Outcome = RunReport["outcome"];
export function outcomeOf(kind: "answered" | "stopped", reviewPending: boolean, extra: Record<string, unknown> = {}): Outcome {
  const base = { steps: 2, toolCalls: 1, reviewPending, spend: { complete: true } };
  return (kind === "answered" ? { ...base, status: "answered", text: "متنِ مدل" } : { ...base, status: "stopped", reason: "MAX_STEPS", errorCode: null, ...extra }) as unknown as Outcome;
}

export function runOf(id: string, name: string, status: "ok" | "error", reviewPending: boolean): RunReport["toolRuns"][number] {
  return { id, name, status, code: status === "ok" ? null : "TOOL_REPORTED_ERROR", reviewPending };
}

export function reportOf(over: Partial<{ outcome: Outcome; abortedBy: RunReport["abortedBy"]; toolRuns: RunReport["toolRuns"] }> = {}): RunReport {
  return { outcome: outcomeOf("answered", true), abortedBy: null, toolRuns: [runOf("call_1", "court_fee", "ok", true)], ...over };
}

export function collector(maxCards = 5): CardCollector {
  const c = createCardCollector({ maxCards });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  return c.value;
}
