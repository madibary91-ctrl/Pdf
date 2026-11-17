/**
 * shared-types (لایهٔ ۰) — قرارداد مشترک بین ماژول‌ها.
 * فقط نوع و توابع کوچکِ خالص. هیچ وابستگی‌ای ندارد.
 * تغییر این فایل = «تغییر قرارداد» و نیازمند تأیید مالک معماری است.
 */

/** تاریخ جلالی (شمسی). month از ۱ تا ۱۲ و day از ۱ تا ۳۱. */
export type JalaliDate = Readonly<{ year: number; month: number; day: number }>;

/** تاریخ میلادی. month از ۱ تا ۱۲. */
export type GregorianDate = Readonly<{ year: number; month: number; day: number }>;

/** کدهای خطای دامنه؛ فهرست بسته تا مصرف‌کننده‌ها بتوانند روی آن switch کنند. */
export type DomainErrorCode =
  | "INVALID_INPUT"
  | "OUT_OF_RANGE"
  | "INVALID_DATE"
  | "PARSE_ERROR";

export type DomainError = Readonly<{
  code: DomainErrorCode;
  /** پیام فارسی و قابل‌نمایش به کاربر */
  message: string;
}>;

/** نتیجهٔ عملیاتی که می‌تواند شکست بخورد؛ به‌جای throw در مرز ماژول‌ها. */
export type Result<T, E = DomainError> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err(code: DomainErrorCode, message: string): Result<never, DomainError> {
  return { ok: false, error: { code, message } };
}
