import { err, ok, type Result } from "@/modules/shared-types";

const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;

/** ارقام لاتین و عربی-هندی → فارسی. بقیهٔ نویسه‌ها دست‌نخورده. */
export function toPersianDigits(text: string): string {
  return text
    .replace(/[0-9]/g, (c) => String.fromCharCode(PERSIAN_ZERO + Number(c)))
    .replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(PERSIAN_ZERO + c.charCodeAt(0) - ARABIC_ZERO));
}

/**
 * ارقام فارسی و عربی-هندی → لاتین.
 * جداکنندهٔ هزارگان «٬» و اعشار «٫» فقط وقتی بین دو رقم باشند به «,» و «.» تبدیل می‌شوند.
 */
export function toLatinDigits(text: string): string {
  return text
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - PERSIAN_ZERO))
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - ARABIC_ZERO))
    .replace(/(\d)\u066C(?=\d)/g, "$1,")
    .replace(/(\d)\u066B(?=\d)/g, "$1.");
}

export type FormatIntegerOptions = Readonly<{
  /** پیش‌فرض: persian */
  digits?: "persian" | "latin";
  /** جداکنندهٔ هزارگان؛ پیش‌فرض: true */
  grouping?: boolean;
}>;

/**
 * قالب‌دهی عدد صحیح (مثلاً مبلغ ریال). فقط عدد صحیحِ امن؛ پول هرگز اعشاری نیست.
 * ۱۲۳۴۵۶۷ → «۱٬۲۳۴٬۵۶۷»
 */
export function formatInteger(value: number | bigint, options: FormatIntegerOptions = {}): Result<string> {
  const { digits = "persian", grouping = true } = options;
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    return err("INVALID_INPUT", "مقدار باید عدد صحیحِ امن باشد.");
  }
  const negative = value < 0;
  const abs = (negative ? -value : value).toString();
  const sep = digits === "persian" ? "\u066C" : ",";
  const body = grouping ? abs.replace(/\B(?=(\d{3})+(?!\d))/g, sep) : abs;
  const text = (negative ? "-" : "") + body;
  return ok(digits === "persian" ? toPersianDigits(text) : text);
}

/**
 * خواندن عدد صحیح از متنی که کاربر نوشته: ارقام فارسی/عربی/لاتین،
 * جداکننده‌های «, ٬ ،» و فاصله، و علامت منفی «- −».
 * اعشار و حروف رد می‌شوند.
 */
export function parseInteger(text: string): Result<number> {
  if (typeof text !== "string") return err("INVALID_INPUT", "ورودی باید متن باشد.");
  const s = toLatinDigits(text)
    .replace(/[\u200C\u200E\u200F\s]/g, "")
    .replace(/\u2212/g, "-");
  if (!/^-?\d{1,3}([,\u060C\u066C]\d{3})+$|^-?\d+$/.test(s)) {
    return err("PARSE_ERROR", "عدد صحیح معتبر نیست.");
  }
  const n = Number(s.replace(/[,\u060C\u066C]/g, ""));
  if (!Number.isSafeInteger(n)) return err("OUT_OF_RANGE", "عدد بیش از حد بزرگ است.");
  return ok(n);
}
