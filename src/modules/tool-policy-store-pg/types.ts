/**
 * نوع‌های آداپتور PostgreSQL ذخیره‌سازِ نسخه‌های سیاستِ ابزار (ADR-0070، برش CT‑5c‑2b‑2).
 * این ماژول هرگز خودش اتصال نمی‌سازد و `process.env` نمی‌خواند: `drizzle(pool)` از بیرون می‌آید.
 */
import type { SQL } from "drizzle-orm";
import type { PolicyVersionStore } from "@/modules/tool-policy-admin";

/** زیرمجموعهٔ کوچکِ drizzle که لازم داریم (method-syntax تا `NodePgDatabase` و تراکنشش بی‌cast پذیرفته شوند). */
export interface PolicyPgExecutor {
  execute(query: SQL): PromiseLike<{ rows: Record<string, unknown>[] }>;
}

export type PolicyPgTransactionConfig = Readonly<{ accessMode?: "read only" | "read write" }>;

export interface PolicyPgDatabase extends PolicyPgExecutor {
  transaction<T>(run: (tx: PolicyPgExecutor) => Promise<T>, config?: PolicyPgTransactionConfig): Promise<T>;
}

export type PgPolicyErrorCode =
  | "INVALID_INPUT" // نام شِما/گزینه نامعتبر
  | "NOT_MIGRATED" // شِما/جدول نیست یا مهاجرت معلق دارد
  | "MIGRATION_TAMPERED" // مهاجرتِ اعمال‌شده با کد نمی‌خواند (checksum) یا حفره دارد
  | "MIGRATION_UNKNOWN" // پایگاه از نسخهٔ جدیدتری است
  | "UNSAFE_SESSION" // نگهبان‌های فقط‌افزودنی فعال نیستند (تریگر خاموش، session_replication_role)
  | "CORRUPT_DATA" // ردیف یا پاسخی که شکلش با مدل نمی‌خواند
  | "DB_ERROR"; // اتصال/اجرا (جزئیات عمداً نیامده)

/** `message` فارسی، ثابت و بی‌پژواکِ رشتهٔ اتصال، SQL و دادهٔ رکورد است. */
export type PgPolicyError = Readonly<{ code: PgPolicyErrorCode; message: string; pgCode?: string; constraint?: string }>;
export type PgPolicyResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: PgPolicyError }>;

export type PgPolicyMigrationReport = Readonly<{ applied: readonly string[]; alreadyApplied: readonly string[] }>;

/** گزارشِ فقط‌خواندنیِ سلامت؛ `problems` رشته‌های ثابتِ بی‌داده‌اند. */
export type PgPolicyStoreStatus = Readonly<{
  schemaExists: boolean;
  applied: readonly string[];
  pending: readonly string[];
  problems: readonly string[];
  rows: number;
  latestVersion: number | null;
  /** نسخه‌ها دقیقاً ۱..N بی‌شکاف‌اند. */
  contiguous: boolean;
  /** مهاجرت کامل، بی‌مشکل و بی‌شکاف. */
  ready: boolean;
}>;

export type PgPolicyStoreOptions = Readonly<{
  /** پیش‌فرض `tool_policy`. **باید از پیش وجود داشته باشد** (ADR-0070 بند ۳: این ماژول `CREATE SCHEMA` نمی‌زند). */
  schema?: string;
  /** سقفِ هر عملیات سمتِ پایگاه (`statement_timeout` و `lock_timeout`)، ۱۰۰ تا ۶۰٬۰۰۰ میلی‌ثانیه؛ پیش‌فرض ۵۰۰۰. */
  statementTimeoutMs?: number;
}>;

export type PgPolicyVersionStore = PolicyVersionStore &
  Readonly<{
    schema: string;
    /** مهاجرتِ زیرِ قفل و در یک تراکنش؛ شِما باید وجود داشته باشد. idempotent. */
    migrate(): Promise<PgPolicyResult<PgPolicyMigrationReport>>;
    /** فقط‌خواندنی: مهاجرت‌ها، وجودِ قیدها/تریگرها، شمارِ ردیف‌ها و بی‌شکافی. هرگز نمی‌نویسد. */
    status(): Promise<PgPolicyResult<PgPolicyStoreStatus>>;
  }>;
