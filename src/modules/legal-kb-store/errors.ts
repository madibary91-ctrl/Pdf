/**
 * نگاشت خطا (داخلی). اصل: پیام به کاربر/لاگ **هرگز** متن رکورد، رشتهٔ اتصال یا SQL را نمی‌آورد؛
 * فقط کد SQLSTATE و نام قید (ثابت و بی‌خطر) می‌آید.
 */
import type { StoreError } from "./types";

/** درون یک تراکنش پرتاب می‌شود تا تراکنش برگردد؛ بیرون از ماژول هرگز دیده نمی‌شود. */
export class StoreAbort extends Error {
  readonly error: StoreError;
  constructor(error: StoreError) {
    super(error.code);
    this.name = "StoreAbort";
    this.error = error;
  }
}

/** ردیفی که شکلش با مدل نمی‌خواند (ستون نادرست). */
export class CorruptRowError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "CorruptRowError";
  }
}

type PgLike = Readonly<{ code: string; constraint?: string }>;

/** خطای pg را می‌یابد؛ drizzle آن را در `cause` می‌پیچد. */
function findPgError(e: unknown): PgLike | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && typeof cur === "object" && cur !== null; depth++) {
    const rec = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && /^[0-9A-Z]{5}$/.test(rec.code)) {
      return { code: rec.code, ...(typeof rec.constraint === "string" ? { constraint: rec.constraint } : {}) };
    }
    cur = rec.cause;
  }
  return null;
}

export function mapDbError(e: unknown): StoreError {
  const pg = findPgError(e);
  if (!pg) return { code: "DB_ERROR", message: "خطای پایگاه داده (اتصال یا اجرا)؛ جزئیات عمداً در پیام نمی‌آید." };
  const base = { pgCode: pg.code, ...(pg.constraint ? { constraint: pg.constraint } : {}) };
  // 42P01 جدول نیست · 3F000 شِما نیست
  if (pg.code === "42P01" || pg.code === "3F000") {
    return { code: "NOT_MIGRATED", message: "جدول‌های پایگاه دانش وجود ندارند؛ ابتدا مهاجرت را اجرا کنید.", ...base };
  }
  if (pg.code === "23505") {
    return { code: "ALREADY_EXISTS", message: "رکوردی با همین کلید یکتا از قبل در پایگاه هست (درج فقط‌افزودنی است).", ...base };
  }
  if (pg.code === "23P01") {
    return { code: "CONSTRAINT_VIOLATION", message: "هم‌پوشانی بازهٔ اعتبار نسخه‌های یک ماده (قید EXCLUDE پایگاه).", ...base };
  }
  // کلاس ۲۳ (قیدها) و ۲۲ (دادهٔ نامعتبر؛ مثل نویسهٔ غیرقابل‌ذخیره در UTF-8)
  if (pg.code.startsWith("23") || pg.code.startsWith("22")) {
    return { code: "CONSTRAINT_VIOLATION", message: "پایگاه داده، رکورد را به‌خاطر یک قید یا دادهٔ نامعتبر رد کرد.", ...base };
  }
  return { code: "DB_ERROR", message: "خطای پایگاه داده.", ...base };
}

export function toStoreError(e: unknown): StoreError {
  if (e instanceof StoreAbort) return e.error;
  if (e instanceof CorruptRowError) {
    return { code: "CORRUPT_DATA", message: `دادهٔ ذخیره‌شده با مدل نمی‌خواند (${e.message}).` };
  }
  return mapDbError(e);
}
