import { err, ok, type JalaliDate, type Result } from "@/modules/shared-types";
import { validateJalaliDate, weekdayIndex } from "./calendar";

export const JALALI_MONTH_NAMES = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
] as const;

/** ترتیب هفتهٔ ایرانی: شنبه تا جمعه. */
export const JALALI_WEEKDAY_NAMES = [
  "شنبه",
  "یکشنبه",
  "دوشنبه",
  "سه‌شنبه",
  "چهارشنبه",
  "پنجشنبه",
  "جمعه",
] as const;

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function toPersianDigits(s: string): string {
  return s.replace(/\d/g, (c) => PERSIAN_DIGITS[Number(c)] ?? c);
}

/** تبدیل ارقام فارسی (۰-۹) و عربی (٠-٩) به لاتین؛ مستقل از persian-text عمداً. */
function toLatinDigits(s: string): string {
  return s
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660));
}

export type JalaliFormatOptions = Readonly<{
  /** numeric: ۱۴۰۴/۰۱/۰۵ — long: ۵ فروردین ۱۴۰۴ — full: شنبه ۵ فروردین ۱۴۰۴ */
  style?: "numeric" | "long" | "full";
  /** پیش‌فرض: persian */
  digits?: "persian" | "latin";
  /** فقط برای style=numeric؛ پیش‌فرض «/» */
  separator?: "/" | "-" | ".";
}>;

export function formatJalaliDate(d: JalaliDate, options: JalaliFormatOptions = {}): Result<string> {
  const v = validateJalaliDate(d);
  if (!v.ok) return v;
  const { style = "numeric", digits = "persian", separator = "/" } = options;
  const { year, month, day } = v.value;
  let text: string;
  if (style === "numeric") {
    const pad = (n: number): string => String(n).padStart(2, "0");
    text = [String(year).padStart(4, "0"), pad(month), pad(day)].join(separator);
  } else {
    text = `${day} ${JALALI_MONTH_NAMES[month - 1]} ${year}`;
    if (style === "full") {
      const w = weekdayIndex(v.value);
      if (!w.ok) return w;
      text = `${JALALI_WEEKDAY_NAMES[w.value]} ${text}`;
    }
  }
  return ok(digits === "persian" ? toPersianDigits(text) : text);
}

// نشانه‌های جهت‌دهی و فاصله‌های نامرئی که هنگام کپی از Word/وب همراه تاریخ می‌آیند.
const INVISIBLES = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00A0\s]+/g;

/**
 * تبدیل متن به تاریخ جلالی. پذیرفته‌ها:
 *  «۱۴۰۴/۰۱/۰۵»، «1404-1-5»، «1404.01.05»، «14040105» و ارقام فارسی/عربی.
 * سال دورقمی عمداً پذیرفته نمی‌شود (ابهام قرن؛ خطای تاریخ در امور حقوقی پرهزینه است).
 */
export function parseJalaliDate(input: string): Result<JalaliDate> {
  if (typeof input !== "string") return err("INVALID_INPUT", "ورودی باید متن باشد.");
  const s = toLatinDigits(input).replace(INVISIBLES, "");
  if (s === "") return err("PARSE_ERROR", "تاریخ خالی است.");
  const match = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!match) {
    return err("PARSE_ERROR", "قالب تاریخ نامعتبر است؛ نمونهٔ درست: ۱۴۰۴/۰۱/۰۵ (سال چهاررقمی).");
  }
  return validateJalaliDate({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });
}
