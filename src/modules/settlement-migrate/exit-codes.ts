/** نگاشتِ خطای فروشگاه به کدِ بستهٔ CLI (خالص، داخلی). پیام/متنِ خطا هرگز عبور نمی‌کند؛ فقط `code` و SQLSTATE. */
import type { PgStoreError } from "@/modules/ledger";
import type { MigrateCode } from "./types";

export type Classified = Readonly<{ code: MigrateCode; pgCode?: string }>;

const SQLSTATE = /^[0-9A-Z]{5}$/;

function withPg(code: MigrateCode, error: PgStoreError): Classified {
  const pg = error.pgCode;
  return typeof pg === "string" && SQLSTATE.test(pg) ? { code, pgCode: pg } : { code };
}

/**
 * مرحلهٔ `check`/`verify` (فقط‌خواندنی): `DB_ERROR` = پایگاه در دسترس نیست؛ ناهمخوانیِ دفتر = `SCHEMA_MISMATCH`.
 * `NOT_MIGRATED` (شِما/جدولِ ناموجود) یعنی معلق، نه خطا. کدِ ناشناخته ⇒ `INTERNAL` (بسته: هرگز بی‌صدا «خوب» نمی‌شود).
 */
export function classifyRead(error: PgStoreError): Classified {
  switch (error.code) {
    case "DB_ERROR":
      return withPg("UNAVAILABLE", error);
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

/** مرحلهٔ `apply`: پایگاه پیش‌تر در دسترس دیده شده؛ هر شکستِ اجرا یعنی «مهاجرت ناموفق»، مگر ناهمخوانیِ دفتر. */
export function classifyApply(error: PgStoreError): Classified {
  switch (error.code) {
    case "MIGRATION_TAMPERED":
    case "MIGRATION_UNKNOWN":
    case "CORRUPT_DATA":
      return withPg("SCHEMA_MISMATCH", error);
    case "DB_ERROR":
    case "COMMIT_REJECTED":
    case "NOT_MIGRATED":
      return withPg("MIGRATION_FAILED", error);
    case "INVALID_INPUT":
      return withPg("INTERNAL", error);
    default:
      return { code: "INTERNAL" };
  }
}
