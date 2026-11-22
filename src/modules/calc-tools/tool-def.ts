/** قراردادِ داخلیِ یک ابزار: توصیف (برای مدل) + اجرا (پس از اعتبارسنجیِ شما). داخلی؛ از index صادر نمی‌شود. */
import type { ReviewInfo } from "@/modules/legal-calc";
import type { DomainError, Result } from "@/modules/shared-types";
import type { CalcToolDeps, CalcToolDescriptor } from "./types";

export type ToolRun = Readonly<{ result: unknown; review: ReviewInfo; notes: readonly string[] }>;

export type ToolDef = Readonly<{
  descriptor: CalcToolDescriptor;
  /** `args` پیش‌تر با `descriptor.parameters` سنجیده شده؛ اینجا فقط قاعده‌های میان‌فیلدی و فراخوانیِ legal-calc است. */
  run: (args: Record<string, unknown>, deps: CalcToolDeps) => Result<ToolRun, DomainError>;
}>;

/** خروجیِ هر محاسبهٔ legal-calc دارای `review` و `notes` است؛ آن‌ها را بالا می‌آوریم تا ارکستراتور از دستشان ندهد. */
export function lift<T extends Readonly<{ review: ReviewInfo; notes: readonly string[] }>>(
  r: Result<T, DomainError>,
): Result<ToolRun, DomainError> {
  return r.ok ? { ok: true, value: { result: r.value, review: r.value.review, notes: r.value.notes } } : r;
}
