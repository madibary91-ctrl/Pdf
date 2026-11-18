/**
 * ledger/pg — نوع‌های آداپتور PostgreSQL (ADR-0019).
 * این ماژول هیچ‌وقت خودش اتصال نمی‌سازد: `drizzle(pool)` یا `db` برنامه را از بیرون می‌گیرد.
 */
import type { SQL } from "drizzle-orm";
import type { AccountKey, AccountStore } from "../types";

/**
 * زیرمجموعهٔ کوچکی از drizzle که لازم داریم. با `method`-syntax نوشته شده‌اند (دوسویه‌پذیریِ پارامتر) تا
 * `NodePgDatabase` و تراکنش آن هر دو بدون cast پذیرفته شوند.
 */
export interface LedgerExecutor {
  execute(query: SQL): PromiseLike<{ rows: Record<string, unknown>[] }>;
}

export type LedgerTransactionConfig = Readonly<{
  isolationLevel?: "read committed" | "read uncommitted" | "repeatable read" | "serializable";
  accessMode?: "read only" | "read write";
}>;

export interface LedgerDatabase extends LedgerExecutor {
  transaction<T>(run: (tx: LedgerExecutor) => Promise<T>, config?: LedgerTransactionConfig): Promise<T>;
}

export type PgStoreErrorCode =
  | "INVALID_INPUT" // نام شِما/کلید/پیکربندی نامعتبر
  | "NOT_MIGRATED" // شِما/جدول نیست یا مهاجرت معلق دارد
  | "MIGRATION_TAMPERED" // مهاجرتِ اعمال‌شده با کد فعلی نمی‌خواند (checksum) یا حفره دارد
  | "MIGRATION_UNKNOWN" // پایگاه از نسخهٔ جدیدتری است
  | "CORRUPT_DATA" // ردیفی که شکلش با مدل نمی‌خواند یا ناوردا را می‌شکند
  | "COMMIT_REJECTED" // commit نامعتبر (کلید ناهمخوان، حذف/تغییر سابقه) یا قیدِ پایگاه آن را رد کرد
  | "DB_ERROR"; // اتصال/اجرا (جزئیات عمداً نیامده)

/** `message` فارسی، ثابت و بی‌پژواکِ رشتهٔ اتصال، SQL و دادهٔ رکورد است. */
export type PgStoreError = Readonly<{ code: PgStoreErrorCode; message: string; pgCode?: string; constraint?: string }>;

export type PgStoreResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: PgStoreError }>;

export type PgMigrationReport = Readonly<{ applied: readonly string[]; alreadyApplied: readonly string[] }>;
export type PgMigrationStatus = Readonly<{ applied: readonly string[]; pending: readonly string[] }>;

/** گزارش ممیزی؛ هیچ مبلغ یا شناسه‌ای نمی‌آورد، فقط شمارش و پیام‌های ثابت. */
export type AccountAudit = Readonly<{
  exists: boolean;
  ok: boolean;
  journalEntries: number;
  problems: readonly string[];
}>;

export type PgAccountStore = AccountStore &
  Readonly<{
    /** مهاجرت‌ها را اعمال می‌کند (idempotent و هم‌زمان‌امن). فروشگاه خودش هرگز مهاجرت نمی‌کند. */
    migrate(): Promise<PgStoreResult<PgMigrationReport>>;
    /** فقط‌خواندنی: چه چیزی اعمال شده و چه چیزی معلق است. */
    status(): Promise<PgStoreResult<PgMigrationStatus>>;
    /** ممیزی یک حساب در اسنپ‌شات یکپارچه: ناوردا + بازپخش ژورنال = حالت. */
    audit(key: AccountKey): Promise<PgStoreResult<AccountAudit>>;
  }>;

export type PgStoreOptions = Readonly<{ schema?: string }>;
