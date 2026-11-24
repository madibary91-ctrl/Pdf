import { TOOL_LIMITS, type Timers, type ToolGateway } from "@/modules/ai-gateway";
import type { ToolLoop } from "@/modules/tool-loop";
import { fail } from "./errors";
import type { RunnerResult, ToolExecutor } from "./types";

export const RUNNER_LIMITS = Object.freeze({
  minTotalTimeoutMs: 1_000,
  maxTotalTimeoutMs: 600_000,
  minToolTimeoutMs: 50,
  maxToolTimeoutMs: 300_000,
  minResultChars: 64,
  maxResultChars: TOOL_LIMITS.maxResultChars,
});

export const DEFAULT_TIMERS: Timers = Object.freeze({
  setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
});

export type ResolvedRunner = Readonly<{
  gateway: ToolGateway;
  loop: ToolLoop;
  executeTool: ToolExecutor;
  totalTimeoutMs: number;
  toolTimeoutMs: number;
  maxResultChars: number;
  timers: Timers;
}>;

const KEYS: ReadonlySet<string> = new Set(["gateway", "loop", "executeTool", "totalTimeoutMs", "toolTimeoutMs", "maxResultChars", "timers"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasFns = (v: unknown, names: readonly string[]): boolean => isRecord(v) && names.every((n) => typeof v[n] === "function");

function intIn(o: Record<string, unknown>, key: string, min: number, max: number, issues: string[]): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    issues.push(`${key} الزامی است و باید عددِ صحیحِ ${min} تا ${max} باشد.`);
    return min;
  }
  return v;
}

/** هرگز پرتاب نمی‌کند و مقدارِ ورودی را بازتاب نمی‌دهد (فقط نامِ کلید). همهٔ آستانه‌ها بی‌پیش‌فرض‌اند. */
export function resolveRunnerOptions(options: unknown): RunnerResult<ResolvedRunner> {
  try {
    if (!isRecord(options)) return fail("INVALID_CONFIG", ["options باید شیء باشد."]);
    const issues: string[] = [];
    for (const k of Object.keys(options)) if (!KEYS.has(k)) issues.push(`کلیدِ ناشناخته (${k.slice(0, 40)}).`);
    if (!hasFns(options["gateway"], ["completeStep", "toolFormat", "limits"])) issues.push("gateway باید دروازهٔ ابزار (completeStep/toolFormat/limits) باشد.");
    if (!hasFns(options["loop"], ["start", "onStep", "onToolResults", "cancel"])) issues.push("loop باید کنترل‌گرِ حلقه (start/onStep/onToolResults/cancel) باشد.");
    if (typeof options["executeTool"] !== "function") issues.push("executeTool باید تابع باشد.");
    const total = intIn(options, "totalTimeoutMs", RUNNER_LIMITS.minTotalTimeoutMs, RUNNER_LIMITS.maxTotalTimeoutMs, issues);
    const tool = intIn(options, "toolTimeoutMs", RUNNER_LIMITS.minToolTimeoutMs, RUNNER_LIMITS.maxToolTimeoutMs, issues);
    const chars = intIn(options, "maxResultChars", RUNNER_LIMITS.minResultChars, RUNNER_LIMITS.maxResultChars, issues);
    const t = options["timers"];
    if (t !== undefined && !hasFns(t, ["setTimeout", "clearTimeout"])) issues.push("timers باید {setTimeout, clearTimeout} باشد.");
    if (issues.length > 0) return fail("INVALID_CONFIG", issues);
    return {
      ok: true,
      value: Object.freeze({
        gateway: options["gateway"] as ToolGateway,
        loop: options["loop"] as ToolLoop,
        executeTool: options["executeTool"] as ToolExecutor,
        totalTimeoutMs: total,
        toolTimeoutMs: tool,
        maxResultChars: chars,
        timers: (t as Timers | undefined) ?? DEFAULT_TIMERS,
      }),
    };
  } catch {
    return fail("INVALID_CONFIG", ["options قابل‌خواندن نیست."]);
  }
}
