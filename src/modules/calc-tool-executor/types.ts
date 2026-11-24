/**
 * نوع‌های «پورتِ اجرای ابزارِ calc-tools» (ADR-0059، برش CT‑5a). این ماژول پلِ باریکِ
 * `calc-tools` (محاسبهٔ مرزیِ خالص) ⇄ `tool-runner` (پورتِ `ToolExecutor`) است و هیچ سیاست یا عددِ حقوقی ندارد.
 */
import type { CalcToolDeps, CalcToolName, JsonValue } from "@/modules/calc-tools";
import type { ToolExecutor } from "@/modules/tool-runner";

/**
 * آنچه خودِ legal-calc گفته است، **بی‌واسطهٔ مدل**. مدل ممکن است عدد را غلط نقل کند یا هشدار را جا بیندازد؛
 * نمایش به کاربر باید از همین رویداد باشد، نه از متنِ مدل.
 */
export type CalcToolObservation = Readonly<{
  /** همان `callId` ی که مجری به پورت داده (برای پیوند با `RunReport.toolRuns`). */
  callId: string;
  tool: CalcToolName;
  /** عیناً خروجیِ legal-calc (ژرف‌یخ‌زده). */
  result: JsonValue;
  review: Readonly<{ status: string; reviewedBy: string | null; reviewedOn: string | null }>;
  /** `true` مگر وقتی `review.status === "legally-verified"` (دو بار و مستقل سنجیده می‌شود؛ ناسازگاری ⇒ `true`). */
  reviewPending: boolean;
  /** هشدارها و یادداشت‌های فارسیِ legal-calc؛ باید کنار نتیجه به کاربر نشان داده شوند. */
  notes: readonly string[];
}>;

export type CalcToolExecutorOptions = Readonly<{
  /** جدول‌های تزریقی (پیش‌فرض: داده‌های legal-calc). مالک/آزمون می‌دهد؛ این ماژول عددی ندارد. */
  deps?: CalcToolDeps;
  /**
   * همگام. پیش از آنکه نتیجه به مدل برگردد صدا زده می‌شود. **اگر پرتاب کند، نتیجه به مدل نمی‌رسد** (مجری آن را `TOOL_FAILED` می‌کند):
   * نتیجه‌ای که ثبت/نمایش‌پذیر نشد (مثلاً هشدارش گم می‌شود) نباید مبنای پاسخ شود.
   */
  onResult?: (observation: CalcToolObservation) => void;
}>;

export type CalcToolExecutorErrorCode = "INVALID_OPTIONS";

export type CalcToolExecutorError = Readonly<{
  code: CalcToolExecutorErrorCode;
  /** پیامِ فارسیِ ثابت؛ مقدارِ ورودی را بازتاب نمی‌دهد. */
  message: string;
  /** فقط نامِ کلید (حداکثر ۱۰ مورد، هر کدام حداکثر ۴۰ نویسه). */
  issues: readonly string[];
}>;

export type CalcToolExecutorResult = Readonly<{ ok: true; value: ToolExecutor }> | Readonly<{ ok: false; error: CalcToolExecutorError }>;
