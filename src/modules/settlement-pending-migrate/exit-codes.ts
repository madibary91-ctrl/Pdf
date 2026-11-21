/** نگاشتِ خطای نمایه به کدِ بستهٔ CLI (خالص، داخلی). پیام/متنِ خطا هرگز عبور نمی‌کند؛ فقط `code` و SQLSTATE. */
import type { PgStoreError } from "@/modules/ledger";
import type { PendingMigrateCode } from "./types";

export type Classified = Readonly<{ code: PendingMigrateCode; pgCode?: string }>;

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** `query_canceled`: سقفِ زمانِ سمتِ پایگاهِ verify (یا لغوِ دستی). */
const QUERY_CANCELED = "57014";
/** `lock_not_available`: `lock_timeout` ی ۱۵ثانیه‌ایِ backfill. */
const LOCK_NOT_AVAILABLE = "55P03";

function withPg(code: PendingMigrateCode, error: PgStoreError): Classified {
  const pg = error.pgCode;
  return typeof pg === "string" && SQLSTATE.test(pg) ? { code, pgCode: pg } : { code };
}

/**
 * مرحلهٔ `check` (فقط‌خواندنی): `DB_ERROR` = پایگاه در دسترس نیست (مگر لغوِ زمان ⇒ `TIMEOUT`)؛ ناهمخوانیِ دفتر = `SCHEMA_MISMATCH`.
 * `NOT_MIGRATED` یعنی معلق، نه خطا. کدِ ناشناخته ⇒ `INTERNAL` (بسته: هرگز بی‌صدا «خوب» نمی‌شود).
 */
export function classifyRead(error: PgStoreError): Classified {
  switch (error.code) {
    case "DB_ERROR":
      return withPg(error.pgCode === QUERY_CANCELED ? "TIMEOUT" : "UNAVAILABLE", error);
    case "MIGRATION_TAMPERED":
    case "MIGRATION_UNKNOWN":
    case "CORRUPT_DATA":
      return withPg("SCHEMA_MISMATCH", error);
    case "NOT_MIGRATED":
      return withPg("PENDING", error);
    case "INVALID_INPUT":
    case "COMMIT_REJECTED":
      return withPg("INTERNAL", error);
    default:
      return { code: "INTERNAL" };
  }
}

/**
 * مرحلهٔ `apply`: `NOT_MIGRATED` (جدول/شِمای settlement نیست) = `PREREQUISITE`؛ `55P03` = `LOCK_BUSY`؛ ناهمخوانیِ دفتر = `SCHEMA_MISMATCH`؛
 * هر شکستِ دیگرِ اجرا (از جمله ردِ قید توسطِ TRIGGER/backfill) = `MIGRATION_FAILED`.
 */
export function classifyApply(error: PgStoreError): Classified {
  switch (error.code) {
    case "MIGRATION_TAMPERED":
    case "MIGRATION_UNKNOWN":
    case "CORRUPT_DATA":
      return withPg("SCHEMA_MISMATCH", error);
    case "NOT_MIGRATED":
      return withPg("PREREQUISITE", error);
    case "DB_ERROR":
      if (error.pgCode === LOCK_NOT_AVAILABLE) return withPg("LOCK_BUSY", error);
      return withPg(error.pgCode === QUERY_CANCELED ? "TIMEOUT" : "MIGRATION_FAILED", error);
    case "COMMIT_REJECTED":
      return withPg("MIGRATION_FAILED", error);
    case "INVALID_INPUT":
      return withPg("INTERNAL", error);
    default:
      return { code: "INTERNAL" };
  }
}

/**
 * مرحلهٔ `verify` پس از اعمال (یا فرمانِ verify): نمایه باید همین حالا هم خوانا باشد. `NOT_MIGRATED` پس از «اعمال‌شد» یعنی ادعا دروغ بوده ⇒ `MIGRATION_FAILED`.
 */
export function classifyVerify(error: PgStoreError): Classified {
  const c = classifyRead(error);
  return c.code === "PENDING" ? { code: "MIGRATION_FAILED", ...(c.pgCode === undefined ? {} : { pgCode: c.pgCode }) } : c;
}
