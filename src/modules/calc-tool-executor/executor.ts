/**
 * پورتِ `ToolExecutor` برای calc-tools. فقط نگاشت: `executeCalcToolJson` ← `ToolExecution`.
 * ناورداها (ADR-0059): نتیجه فقط از legal-calc؛ `reviewPending` شکست‌بسته؛ خطای محاسبه ⇒ نتیجهٔ خطا (به مدل برای اصلاح)؛
 * باگِ درونی/ناظرِ پرتاب‌کننده پنهان نمی‌شود (مجری آن را با متنِ ثابت `TOOL_FAILED` می‌کند)؛ لغوِ پیش‌ازاجرا محاسبه نمی‌کند.
 */
import { executeCalcToolJson, type CalcToolDeps } from "@/modules/calc-tools";
import type { ToolExecution, ToolExecutor } from "@/modules/tool-runner";
import type { CalcToolExecutorOptions, CalcToolExecutorResult } from "./types";

/** متنِ ثابتِ لغوِ پیش از اجرا (به مدل نمی‌رسد؛ مجری نتیجهٔ ابزارِ لغوشده را رها می‌کند، ولی شکلِ نتیجه معتبر می‌ماند). */
export const CALC_ABORTED_CONTENT = JSON.stringify({ error: { code: "ABORTED", message: "اجرای ابزار پیش از شروع لغو شد." } });

const OPTION_KEYS: ReadonlySet<string> = new Set(["deps", "onResult"]);
const DEPS_KEYS: ReadonlySet<string> = new Set(["courtFeeTariffs", "latePaymentSeries", "latePaymentRules"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keyName = (k: string): string => (k.length > 40 ? `${k.slice(0, 40)}…` : k);

function invalid(issues: readonly string[]): CalcToolExecutorResult {
  return { ok: false, error: { code: "INVALID_OPTIONS", message: "گزینه‌های پورتِ ابزارِ محاسبه نامعتبرند.", issues: issues.slice(0, 10) } };
}

/** اعتبارسنجیِ مرزی؛ هرگز پرتاب نمی‌کند و مقدار را بازتاب نمی‌دهد. */
export function createCalcToolExecutor(options: CalcToolExecutorOptions | undefined = {}): CalcToolExecutorResult {
  const issues: string[] = [];
  let deps: CalcToolDeps = {};
  let onResult: CalcToolExecutorOptions["onResult"];
  try {
    if (!isRecord(options)) return invalid(["options: باید شیء باشد"]);
    for (const k of Object.keys(options)) if (!OPTION_KEYS.has(k)) issues.push(`${keyName(k)}: کلید ناشناخته`);
    const d = options["deps"];
    if (d !== undefined) {
      if (!isRecord(d)) issues.push("deps: باید شیء باشد");
      else {
        for (const k of Object.keys(d)) if (!DEPS_KEYS.has(k)) issues.push(`deps.${keyName(k)}: کلید ناشناخته`);
        deps = d as CalcToolDeps;
      }
    }
    const cb = options["onResult"];
    if (cb !== undefined) {
      if (typeof cb !== "function") issues.push("onResult: باید تابع باشد");
      else onResult = cb as NonNullable<CalcToolExecutorOptions["onResult"]>;
    }
  } catch {
    return invalid(["options: خوانده نشد"]);
  }
  if (issues.length > 0) return invalid(issues);

  const executor: ToolExecutor = (call, context): ToolExecution => {
    // پیش از هر کار: ابزارِ لغوشده محاسبه نمی‌کند (محاسبه همگام است؛ پس از شروع نمی‌توان قطعش کرد).
    if (context.signal.aborted) return { ok: false, content: CALC_ABORTED_CONTENT };

    const r = executeCalcToolJson(call.name, call.argumentsJson, deps);
    if (!r.ok) {
      // پیامِ فارسیِ calc-tools (کران‌دار، فقط نامِ کلیدهای خودِ مدل) عمداً قابلِ نمایش به مدل است (README calc-tools).
      return { ok: false, content: JSON.stringify({ error: { code: r.error.code, message: r.error.message } }) };
    }
    const v = r.value;
    // شکست‌بسته: «تأییدشده» (false) فقط وقتی هر دو نشانه (پرچمِ calc-tools و وضعیتِ review) موافق باشند.
    const reviewPending = v.reviewPending || v.review.status !== "legally-verified";
    // ناظر پیش از بازگشت به مدل؛ پرتاب ⇒ نتیجه به مدل نمی‌رسد (مجری آن را TOOL_FAILED می‌کند).
    onResult?.(Object.freeze({ callId: context.callId, tool: v.tool, result: v.result, review: v.review, reviewPending, notes: v.notes }));
    const content = JSON.stringify({ tool: v.tool, result: v.result, review: v.review, reviewPending, notes: v.notes });
    return { ok: true, content, reviewPending };
  };
  return { ok: true, value: executor };
}
