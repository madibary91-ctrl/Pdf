/**
 * نگاشت خطا (داخلی). اصل: پیام به کاربر/لاگ **هرگز** متنِ رکورد، رشتهٔ اتصال یا SQL را نمی‌آورد؛ فقط کدِ SQLSTATE و نامِ قید.
 * (خطای خامِ drizzle متنِ کاملِ پرسش و پارامترها را دارد؛ پس هیچ‌وقت بیرون از این ماژول نمی‌رود.)
 */
import type { PgStoreError } from "@/modules/ledger";

/** درون یک تراکنش پرتاب می‌شود تا تراکنش برگردد؛ فقط لایهٔ مرزی آن را به `PgStoreError` تبدیل می‌کند. */
export class PendingStoreError extends Error {
  readonly error: PgStoreError;
  constructor(error: PgStoreError) {
    super(error.code);
    this.name = "PendingStoreError";
    this.error = error;
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

const DB_ERROR_MESSAGE = "خطای پایگاه داده (اتصال یا اجرا)؛ جزئیات عمداً در پیام نمی‌آید.";

export function mapDbError(e: unknown): PgStoreError {
  if (e instanceof PendingStoreError) return e.error;
  const pg = findPgError(e);
  if (!pg) return { code: "DB_ERROR", message: DB_ERROR_MESSAGE };
  const base = { pgCode: pg.code, ...(pg.constraint ? { constraint: pg.constraint } : {}) };
  // 42P01 جدول نیست · 3F000 شِما نیست
  if (pg.code === "42P01" || pg.code === "3F000") {
    return { code: "NOT_MIGRATED", message: "جدول‌های نمایهٔ «مرده‌های در انتظارِ تأیید» وجود ندارند؛ ابتدا مهاجرتِ settlement و سپس migrate() همین ماژول را اجرا کنید.", ...base };
  }
  // کلاس ۲۳: نقض قید (TRIGGERهای ما با ERRCODE integrity_constraint_violation)
  if (pg.code.startsWith("23")) {
    return { code: "COMMIT_REJECTED", message: "پایگاه نوشتن را به‌خاطر نقض یک قید (ناورداهای نمایه) رد کرد؛ هیچ‌چیز نوشته نشد.", ...base };
  }
  return { code: "DB_ERROR", message: DB_ERROR_MESSAGE, ...base };
}

export function toStoreError(e: unknown): PendingStoreError {
  return e instanceof PendingStoreError ? e : new PendingStoreError(mapDbError(e));
}

export const corrupt = (message: string): PendingStoreError => new PendingStoreError({ code: "CORRUPT_DATA", message });
