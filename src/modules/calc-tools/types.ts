/** نوع‌های رابط عمومیِ calc-tools. */
import type { CourtFeeTariff, IndexSeries, LatePaymentRules, ReviewInfo } from "@/modules/legal-calc";
import type { Schema, SchemaObject } from "./schema";

export type CalcToolName = "court_fee" | "late_payment";

/** توصیفِ ابزار برای مدل (شکلِ مستقل از ارائه‌دهنده؛ آداپتورِ هر ارائه‌دهنده آن را به قالبِ خودش می‌برد). */
export type CalcToolDescriptor = Readonly<{
  name: CalcToolName;
  /** فارسی؛ مدل را به «فقط با آرگومان‌های صریح و بی‌حدس» هدایت می‌کند */
  description: string;
  parameters: SchemaObject;
}>;

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * خروجیِ موفقِ یک ابزار. `result` عیناً خروجیِ legal-calc است (قابل‌سریال‌شدن)؛ هیچ عددی از حافظهٔ مدل نیست.
 * `reviewPending` را ارکستراتور باید کنار پاسخ به کاربر نشان دهد (جدول‌ها هنوز تأییدِ حقوقدان ندارند).
 */
export type CalcToolOutput = Readonly<{
  tool: CalcToolName;
  result: JsonValue;
  review: ReviewInfo;
  /** `true` مگر وقتی `review.status === "legally-verified"` */
  reviewPending: boolean;
  /** هشدارها و یادداشت‌های فارسیِ خودِ legal-calc؛ باید کنار نتیجه نمایش داده شوند */
  notes: readonly string[];
}>;

/** داده‌های تزریقی (برای آزمون یا جدولِ سنجیده‌شدهٔ دیگر)؛ پیش‌فرض‌ها همان داده‌های legal-calc‌اند. */
export type CalcToolDeps = Readonly<{
  courtFeeTariffs?: readonly CourtFeeTariff[];
  latePaymentSeries?: readonly IndexSeries[];
  latePaymentRules?: LatePaymentRules;
}>;

export type { Schema };
