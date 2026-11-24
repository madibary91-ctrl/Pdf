/** سنجشِ پیکربندیِ کنترل‌گر روی مرز. همهٔ آستانه‌ها الزامی و بی‌پیش‌فرض‌اند (تصمیمِ مالک). */
import { fail } from "./errors";
import type { BudgetPolicy, LoopResult, StepEstimateInput, ToolLoopConfig } from "./types";

export const LOOP_LIMITS = Object.freeze({
  maxSteps: 16,
  maxToolCalls: 64,
  maxIdenticalCalls: 16,
  maxTruncationRetries: 2,
});

const CURRENCY_RE = /^[A-Z]{3}$/;
const KEYS: ReadonlySet<string> = new Set(["maxSteps", "maxToolCalls", "maxIdenticalCalls", "truncationRetries", "budget"]);
const CAP_KEYS: ReadonlySet<string> = new Set(["kind", "currency", "maxMicros", "estimateStepMicros"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

function parseBudget(raw: unknown, issues: string[]): BudgetPolicy | null {
  if (!isRecord(raw)) {
    issues.push("budget الزامی است: {kind:\"none\"} یا {kind:\"cap\",…}.");
    return null;
  }
  if (raw["kind"] === "none") {
    for (const k of Object.keys(raw)) if (k !== "kind") issues.push(`budget: کلید ناشناخته (${k.slice(0, 40)}).`);
    return issues.length === 0 ? Object.freeze({ kind: "none" as const }) : null;
  }
  if (raw["kind"] !== "cap") {
    issues.push("budget.kind باید none یا cap باشد.");
    return null;
  }
  const before = issues.length;
  for (const k of Object.keys(raw)) if (!CAP_KEYS.has(k)) issues.push(`budget: کلید ناشناخته (${k.slice(0, 40)}).`);
  const currency = raw["currency"];
  const maxMicros = raw["maxMicros"];
  const estimate = raw["estimateStepMicros"];
  if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) issues.push("budget.currency باید کد سه‌حرفیِ بزرگ (مثل IRR) باشد.");
  if (!intIn(maxMicros, 1, Number.MAX_SAFE_INTEGER)) issues.push("budget.maxMicros باید صحیحِ مثبتِ امن باشد.");
  if (typeof estimate !== "function") issues.push("budget.estimateStepMicros باید تابع باشد.");
  if (issues.length > before) return null;
  return Object.freeze({
    kind: "cap" as const,
    currency: currency as string,
    maxMicros: maxMicros as number,
    estimateStepMicros: estimate as (input: StepEstimateInput) => number,
  });
}

/** `Result<ToolLoopConfig>` — خروجی یخ‌زده و کپی است (تغییرِ بعدیِ ورودی بی‌اثر). هرگز پرتاب نمی‌کند. */
export function resolveToolLoopConfig(raw: unknown): LoopResult<ToolLoopConfig> {
  try {
    if (!isRecord(raw)) return fail("INVALID_CONFIG", ["پیکربندی باید شیء باشد."]);
    const issues: string[] = [];
    for (const k of Object.keys(raw)) if (!KEYS.has(k)) issues.push(`کلید ناشناخته (${k.slice(0, 40)}).`);
    if (!intIn(raw["maxSteps"], 1, LOOP_LIMITS.maxSteps)) issues.push(`maxSteps باید صحیحِ ۱ تا ${LOOP_LIMITS.maxSteps} باشد.`);
    if (!intIn(raw["maxToolCalls"], 1, LOOP_LIMITS.maxToolCalls)) issues.push(`maxToolCalls باید صحیحِ ۱ تا ${LOOP_LIMITS.maxToolCalls} باشد.`);
    if (!intIn(raw["maxIdenticalCalls"], 1, LOOP_LIMITS.maxIdenticalCalls)) issues.push(`maxIdenticalCalls باید صحیحِ ۱ تا ${LOOP_LIMITS.maxIdenticalCalls} باشد.`);
    if (!intIn(raw["truncationRetries"], 0, LOOP_LIMITS.maxTruncationRetries)) issues.push(`truncationRetries باید صحیحِ ۰ تا ${LOOP_LIMITS.maxTruncationRetries} باشد.`);
    const budget = parseBudget(raw["budget"], issues);
    if (issues.length > 0 || budget === null) return fail("INVALID_CONFIG", issues);
    return {
      ok: true,
      value: Object.freeze({
        maxSteps: raw["maxSteps"] as number,
        maxToolCalls: raw["maxToolCalls"] as number,
        maxIdenticalCalls: raw["maxIdenticalCalls"] as number,
        truncationRetries: raw["truncationRetries"] as number,
        budget,
      }),
    };
  } catch {
    return fail("INVALID_CONFIG", ["پیکربندی قابل‌خواندن نیست."]);
  }
}
