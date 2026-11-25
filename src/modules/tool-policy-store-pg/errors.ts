/**
 * نگاشتِ خطا (داخلی). اصل: پیام به فراخواننده/لاگ **هرگز** متنِ رکورد، رشتهٔ اتصال یا SQL را نمی‌آورد؛ فقط SQLSTATE و نامِ قید.
 * (خطای خامِ drizzle متنِ کامل کوئری و پارامترها را دارد؛ پس هیچ‌وقت از این ماژول بیرون نمی‌رود.)
 */
import type { StoreErrorCode } from "@/modules/tool-policy-admin";
import type { PgPolicyError } from "./types";

/** درون یک تراکنش پرتاب می‌شود تا برگردد؛ مرزِ عمومی همیشه آن را `Result` می‌کند. */
export class PolicyPgError extends Error {
  readonly error: PgPolicyError;
  constructor(error: PgPolicyError) {
    super(error.code);
    this.name = "PolicyPgError";
    this.error = error;
  }
}

type PgLike = Readonly<{ code: string; constraint?: string }>;

/** خطای pg را می‌یابد؛ drizzle آن را در `cause` می‌پیچد. */
export function findPgError(e: unknown): PgLike | null {
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

const DB_ERROR_MESSAGE = "خطای پایگاه داده (اتصال یا اجرا)؛ جزئیات عمداً در پیام نمی‌آید.";

export function mapDbError(e: unknown): PgPolicyError {
  if (e instanceof PolicyPgError) return e.error;
  const pg = findPgError(e);
  if (!pg) return { code: "DB_ERROR", message: DB_ERROR_MESSAGE };
  const base = { pgCode: pg.code, ...(pg.constraint ? { constraint: pg.constraint } : {}) };
  // 42P01 جدول نیست · 3F000 شِما نیست
  if (pg.code === "42P01" || pg.code === "3F000") return { code: "NOT_MIGRATED", message: "جدول‌های ذخیره‌سازِ نسخه‌های سیاست وجود ندارند؛ ابتدا migrate() را اجرا کنید.", ...base };
  return { code: "DB_ERROR", message: DB_ERROR_MESSAGE, ...base };
}

/**
 * نگاشتِ هر پرتاب به کدِ پورتِ `PolicyVersionStore`:
 *  - `23000` (تریگرِ زنجیرهٔ ما: شکاف/تکرارِ نسخه) و `23505` (کلیدِ یکتا؛ بازندهٔ مسابقه) ⇒ `CONFLICT`؛
 *  - ردیفِ خراب (`CORRUPT_DATA`)، نقضِ قیدِ دیگر (کلاس ۲۳) و دادهٔ نامعتبر (کلاس ۲۲، مثل `\u0000` در jsonb) ⇒ `INVALID`؛
 *  - هر چیزِ دیگر (اتصال، مهلت، مهاجرتِ ناقص، نگهبانِ خاموش) ⇒ `UNAVAILABLE` (بسته‌شدنِ شکست).
 */
export function toStoreCode(e: unknown): StoreErrorCode {
  if (e instanceof PolicyPgError) return e.error.code === "CORRUPT_DATA" ? "INVALID" : "UNAVAILABLE";
  const pg = findPgError(e);
  if (pg === null) return "UNAVAILABLE";
  if (pg.code === "23000" || pg.code === "23505") return "CONFLICT";
  if (pg.code.startsWith("23") || pg.code.startsWith("22")) return "INVALID";
  return "UNAVAILABLE";
}

export const toPolicyError = (e: unknown): PolicyPgError => (e instanceof PolicyPgError ? e : new PolicyPgError(mapDbError(e)));
export const corrupt = (message: string): PolicyPgError => new PolicyPgError({ code: "CORRUPT_DATA", message });

/** پاسخِ غیرمنتظره از کاتالوگ/دفتر (نه ردیفِ دادهٔ کاربر): شکستِ زیرساخت است و به `UNAVAILABLE` می‌رود، نه `INVALID`. */
export const unexpectedDb = (message: string): PolicyPgError => new PolicyPgError({ code: "DB_ERROR", message });
