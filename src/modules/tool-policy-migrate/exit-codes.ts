/** نگاشتِ خطای فروشگاه به کدِ بستهٔ CLI (خالص، داخلی). پیام/متنِ خطا هرگز عبور نمی‌کند؛ فقط `code` و SQLSTATE. */
import type { MigrateCode } from "./types";

export type Classified = Readonly<{ code: MigrateCode; pgCode?: string }>;

const SQLSTATE = /^[0-9A-Z]{5}$/;
const INTERNAL: Classified = { code: "INTERNAL" };

function withPg(code: MigrateCode, error: { pgCode?: unknown }): Classified {
  const pg = error.pgCode;
  return typeof pg === "string" && SQLSTATE.test(pg) ? { code, pgCode: pg } : { code };
}

const asError = (e: unknown): { code?: unknown; pgCode?: unknown } => (typeof e === "object" && e !== null ? (e as { code?: unknown; pgCode?: unknown }) : {});

/**
 * مرحلهٔ `check`/`verify` (فقط‌خواندنی): `DB_ERROR` = پایگاه در دسترس نیست؛ ناهمخوانی (دفتر دست‌کاری/از آینده، دادهٔ خراب، نگهبانِ فقط‌افزودنیِ خاموش) = `SCHEMA_MISMATCH`.
 * `NOT_MIGRATED` (شِما/جدولِ ناموجود) یعنی معلق، نه خطا. کدِ ناشناخته ⇒ `INTERNAL` (بسته: هرگز بی‌صدا «خوب» نمی‌شود).
 */
export function classifyRead(e: unknown): Classified {
  const error = asError(e);
  switch (error.code) {
    case "DB_ERROR":
      return withPg("UNAVAILABLE", error);
    case "MIGRATION_TAMPERED":
    case "MIGRATION_UNKNOWN":
    case "CORRUPT_DATA":
    case "UNSAFE_SESSION":
      return withPg("SCHEMA_MISMATCH", error);
    case "NOT_MIGRATED":
      return withPg("PENDING", error);
    default:
      return INTERNAL;
  }
}

/** مرحلهٔ `schema`/`apply`: پایگاه پیش‌تر در دسترس دیده شده؛ هر شکستِ اجرا یعنی «مهاجرت ناموفق»، مگر ناهمخوانیِ دفتر. */
export function classifyApply(e: unknown): Classified {
  const error = asError(e);
  switch (error.code) {
    case "MIGRATION_TAMPERED":
    case "MIGRATION_UNKNOWN":
    case "CORRUPT_DATA":
      return withPg("SCHEMA_MISMATCH", error);
    case "DB_ERROR":
    case "NOT_MIGRATED":
    case "UNSAFE_SESSION":
      return withPg("MIGRATION_FAILED", error);
    default:
      return INTERNAL;
  }
}
