import type { LoopOutcome } from "@/modules/tool-loop";
import type { RunnerError, RunnerErrorCode, RunnerResult, ToolFailureCode } from "./types";

export const RUNNER_MESSAGES: Readonly<Record<RunnerErrorCode, string>> = Object.freeze({
  INVALID_CONFIG: "پیکربندی مجریِ حلقهٔ ابزار نامعتبر است.",
  INVALID_INPUT: "ورودیِ مجریِ حلقهٔ ابزار نامعتبر است.",
  MODEL_UNSUPPORTED: "مدلِ درخواستی در دروازه تعریف نشده یا ابزار را پشتیبانی نمی‌کند.",
  CONTRACT_VIOLATION: "کنترل‌گرِ حلقه رویدادِ مجری را نپذیرفت (باگِ مجری یا ابزار).",
  INTERNAL_ERROR: "مجریِ حلقهٔ ابزار با خطای داخلی بسته شد.",
});

export const MAX_ISSUES = 10;

export function fail(code: RunnerErrorCode, issues: readonly string[] = [], partial: LoopOutcome | null = null): RunnerResult<never> {
  const e: RunnerError = Object.freeze({ code, message: RUNNER_MESSAGES[code], issues: Object.freeze(issues.slice(0, MAX_ISSUES)), partial });
  return Object.freeze({ ok: false as const, error: e });
}

/** متنِ ثابتِ خطای ابزار برای مدل: هرگز پیامِ استثنا/نتیجهٔ ابزار را بازتاب نمی‌دهد. */
export const FAILURE_CONTENT: Readonly<Record<Exclude<ToolFailureCode, "TOOL_REPORTED_ERROR" | "TOOL_ABORTED">, string>> = Object.freeze({
  UNKNOWN_TOOL: JSON.stringify({ error: "UNKNOWN_TOOL" }),
  TOOL_TIMEOUT: JSON.stringify({ error: "TOOL_TIMEOUT" }),
  TOOL_FAILED: JSON.stringify({ error: "TOOL_FAILED" }),
  TOOL_RESULT_INVALID: JSON.stringify({ error: "TOOL_RESULT_INVALID" }),
  TOOL_RESULT_TOO_LARGE: JSON.stringify({ error: "TOOL_RESULT_TOO_LARGE" }),
});
