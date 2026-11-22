/** قطعه‌های مشترکِ شمای ابزارها. فقط حدّهای ساختاری/فنی؛ هیچ عددِ حقوقی. */
import { deepFreeze, type SchemaObject } from "./schema";

/** بزرگ‌ترین ریالِ عدد صحیحِ امن؛ بالاتر از آن دقتِ عدد از دست می‌رود (حدّ فنی، نه حقوقی). */
export const MAX_RIALS = Number.MAX_SAFE_INTEGER;

export function dateSchema(description: string): SchemaObject {
  return deepFreeze({
    type: "object",
    description,
    properties: {
      year: { type: "integer", minimum: 1, maximum: 9999, description: "سال جلالی با رقم لاتین، مثلاً ۱۴۰۵ را 1405 بفرستید." },
      month: { type: "integer", minimum: 1, maximum: 12 },
      day: { type: "integer", minimum: 1, maximum: 31 },
    },
    required: ["year", "month", "day"],
    additionalProperties: false,
  });
}
