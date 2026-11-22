/**
 * دروازهٔ هزینه (ADR-0056 §۳). خالص و بی‌پرتاب. اصلِ «شکست‌بسته»: اگر نتوانیم ثابت کنیم گامِ بعد در سقف می‌ماند، **نمی‌رود**.
 * نامعلوم صفر نیست؛ ارزِ دیگر قابل‌مقایسه نیست؛ برآوردگرِ خراب = نامعلوم.
 */
import { sumStepSpend } from "@/modules/ai-gateway";
import type { BudgetPolicy, StepEstimateInput, StopReason } from "./types";

export type BudgetVerdict = Extract<StopReason, "BUDGET_EXCEEDED" | "SPEND_UNKNOWN"> | null;

/** `null` = گامِ بعد مجاز است. */
export function budgetVerdict(budget: BudgetPolicy, entries: readonly unknown[], next: StepEstimateInput): BudgetVerdict {
  if (budget.kind === "none") return null;
  const spend = sumStepSpend(entries);
  if (spend.unknownCostSteps > 0) return "SPEND_UNKNOWN";
  if (spend.cost.some((c) => c.currency !== budget.currency)) return "SPEND_UNKNOWN";

  let known = 0;
  for (const c of spend.cost) {
    // `micros: null` = جمعِ ایمن سرریز شد؛ قطعاً بیش از هر سقفِ مجاز است.
    if (c.micros === null) return "BUDGET_EXCEEDED";
    known += c.micros;
    if (!Number.isSafeInteger(known)) return "BUDGET_EXCEEDED";
  }

  let worst: unknown;
  try {
    worst = budget.estimateStepMicros(Object.freeze({ ...next }));
  } catch {
    return "SPEND_UNKNOWN";
  }
  if (typeof worst !== "number" || !Number.isSafeInteger(worst) || worst < 0) return "SPEND_UNKNOWN";
  const total = known + worst;
  if (!Number.isSafeInteger(total) || total > budget.maxMicros) return "BUDGET_EXCEEDED";
  return null;
}
