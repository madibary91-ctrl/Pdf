/**
 * تبدیلِ سخت‌گیرانهٔ خروجیِ legal-calc به JSON امن.
 * `JSON.stringify` مقدارِ NaN/Infinity را بی‌صدا `null` می‌کند و `undefined` را حذف؛ در پول این «بی‌صدا» پذیرفتنی نیست.
 * اینجا هر چیزِ غیرِ JSON (NaN، بی‌نهایت، bigint، تابع، symbol، شیء غیرساده، چرخه/عمق زیاد) کدِ خطا می‌دهد.
 */
import { err, ok, type DomainError, type Result } from "@/modules/shared-types";
import type { JsonValue } from "./types";

const MAX_JSON_DEPTH = 32;

function convert(v: unknown, depth: number): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new RangeError("depth");
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("number");
    return v;
  }
  if (Array.isArray(v)) {
    return v.map((x) => {
      if (x === undefined) throw new RangeError("undefined-in-array");
      return convert(x, depth + 1);
    });
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v) as unknown;
    if (proto !== Object.prototype && proto !== null) throw new RangeError("non-plain");
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(v)) {
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined) continue; // کلیدِ اختیاریِ غایب
      out[key] = convert(child, depth + 1);
    }
    return out;
  }
  throw new RangeError(typeof v);
}

export function toJsonValue(v: unknown): Result<JsonValue, DomainError> {
  try {
    return ok(convert(v, 0));
  } catch {
    return err("OUT_OF_RANGE", "خروجیِ محاسبه قابل‌سریال‌شدن به JSON نیست؛ نتیجه نمایش داده نمی‌شود.");
  }
}
