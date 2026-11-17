/**
 * legal-kb-store — نوع‌های رابط (داخلی به‌جز آنچه index.ts صادر می‌کند).
 *
 * چرا `StoreResult` و نه `Result` از shared-types؟ registry این ماژول را فقط به `legal-kb-schema` وابسته کرده
 * و شکل ساختاری هر دو یکی است (`{ok:true,value}` | `{ok:false,error}`)؛ پس بعداً با افزودن وابستگی، جایگزینی بی‌دردسر است
 * (درخواست معماری در یادداشت تحویل ۰۰۰۶).
 */
import type { SQL } from "drizzle-orm";
import type { CorpusIssue, IsoDate, Review, Subpart } from "@/modules/legal-kb-schema";

/**
 * فقط `execute` (برای تابع‌هایی که داخل تراکنش یا بیرون آن اجرا می‌شوند).
 * عمداً رابط ساختاریِ کوچک است، نه `NodePgDatabase<…>`: پارامتر ژنریکِ شِمای drizzle در `drizzle(pool)` و `db` برنامه
 * متفاوت استنتاج می‌شود و نوع نام‌دار با آن‌ها ناسازگار می‌شد (تست‌نویسی همین را گرفت). متدها عمداً با نحو متد
 * نوشته شده‌اند (دوسویه‌پذیری پارامتر) تا هر دو شکل بپذیرند.
 */
export interface KbExecutor {
  execute(query: SQL): PromiseLike<{ rows: Record<string, unknown>[] }>;
}

export type KbTransactionConfig = Readonly<{
  isolationLevel?: "read committed" | "read uncommitted" | "repeatable read" | "serializable";
  accessMode?: "read only" | "read write";
}>;

/** این ماژول هیچ‌وقت خودش اتصال نمی‌سازد: `drizzle(pool)` یا `db` برنامه را از بیرون می‌گیرد. */
export interface KbDatabase extends KbExecutor {
  transaction<T>(run: (tx: KbExecutor) => Promise<T>, config?: KbTransactionConfig): Promise<T>;
}

export type StoreErrorCode =
  | "INVALID_INPUT" // ورودی بد (تاریخ، ارجاع، نام شِما)
  | "INVALID_CORPUS" // Corpus از `loadCorpus` رد شد؛ `issues` پر است
  | "ALREADY_EXISTS" // درج فقط‌افزودنی است؛ `conflicts` شناسه‌های موجود
  | "NOT_MIGRATED" // شِما/جدول نیست یا مهاجرت معلق دارد
  | "MIGRATION_TAMPERED" // مهاجرتِ اعمال‌شده با کد فعلی نمی‌خواند (checksum) یا حفره دارد
  | "MIGRATION_UNKNOWN" // پایگاه مهاجرتی دارد که این نسخهٔ کد نمی‌شناسد (پایگاه از آینده)
  | "CONSTRAINT_VIOLATION" // قید پایگاه (CHECK/FK/EXCLUDE/دادهٔ نامعتبر) رد کرد
  | "NOT_FOUND" // نسخه‌ای که می‌خواهید تغییر دهید در پایگاه نیست
  | "CONFLICT" // محتوا/وضعیت نسخه با آنچه بازبین دیده یا انتظار می‌رفت نمی‌خواند (هش، یا وضعیت نادرست برای این کنش)
  | "CORRUPT_DATA" // دادهٔ ذخیره‌شده با قواعد مدل نمی‌خواند؛ هرگز «حدس» نمی‌زنیم
  | "DB_ERROR"; // هر خطای دیگر پایگاه (اتصال، زمان‌سنج، …)

export type StoreError = Readonly<{
  code: StoreErrorCode;
  /** پیام فارسی؛ هرگز متن رکوردها، رشتهٔ اتصال یا SQL خام را نمی‌آورد. */
  message: string;
  issues?: readonly CorpusIssue[];
  conflicts?: readonly string[];
  /** نام قید پایگاه (مثل `article_version_no_overlap`)؛ نام ثابت و بی‌خطر. */
  constraint?: string;
  /** کد SQLSTATE پستگرس (مثل `23P01`). */
  pgCode?: string;
}>;

export type StoreResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: StoreError }>;

export type StoreOptions = Readonly<{
  /** نام شِمای پستگرس؛ پیش‌فرض `legal_kb`. فقط `[a-z][a-z0-9_]{0,39}` و نه `public`/`pg_*`. */
  schema?: string;
}>;

export type MigrationReport = Readonly<{
  /** مهاجرت‌هایی که همین بار اعمال شدند. */
  applied: readonly string[];
  /** مهاجرت‌هایی که از قبل اعمال شده بودند (و checksum‌شان با کد می‌خواند). */
  alreadyApplied: readonly string[];
}>;

export type MigrationStatus = Readonly<{
  applied: readonly string[];
  pending: readonly string[];
}>;

export type InsertReport = Readonly<{
  documents: number;
  articles: number;
  versions: number;
  subparts: number;
  relations: number;
  rulings: number;
  citations: number;
}>;

export type StoreStats = Readonly<{
  documents: number;
  articles: number;
  versions: number;
  subparts: number;
  relations: number;
  rulings: number;
  citations: number;
  /** نسخه‌هایی که حقوقدان تأیید کرده است. */
  verifiedVersions: number;
  migrations: readonly string[];
}>;

// ───────── بخش ۴ب‑۲: مسیر اعتماد (تأیید، پس‌گرفتن، اصلاح) و ممیزی ─────────

/** شناسهٔ یک نسخهٔ ماده: همان کلید طبیعی (سند، ماده، شروع اعتبار). */
export type VersionRef = Readonly<{ documentId: string; article: string; validFrom: IsoDate }>;

/** آنچه حقوقدان «می‌بیند و تأیید می‌کند»: متن + تبصره/بندها + وضعیت بازبینی؛ `contentHash` هش متن و تبصره‌هاست. */
export type VersionSnapshot = Readonly<{ text: string; subparts: readonly Subpart[]; review: Review; contentHash: string }>;

export type AuditAction = "verify" | "revoke" | "correct";

export type VersionChange = Readonly<{
  action: AuditAction;
  ref: VersionRef;
  /** شمارهٔ رکورد ممیزی (فقط‌افزودنی، صعودی). */
  auditSeq: number;
  before: VersionSnapshot;
  after: VersionSnapshot;
}>;

export type AuditEntry = Readonly<{
  seq: number;
  /** لحظهٔ ثبت (ساعت پایگاه، UTC، ISO-8601). */
  at: string;
  action: AuditAction;
  ref: VersionRef;
  actor: string;
  actedOn: IsoDate;
  reason: string | null;
  before: VersionSnapshot;
  after: VersionSnapshot;
}>;

/** `expectedHash` = `versionContentHash` همان متنی که بازبین دیده؛ اگر متن در این فاصله عوض شده باشد، تأیید رد می‌شود. */
export type VerifyInput = Readonly<{ expectedHash: string; reviewedBy: string; reviewedOn: IsoDate }>;
export type RevokeInput = Readonly<{ expectedHash: string; revokedBy: string; revokedOn: IsoDate; reason: string }>;
export type CorrectInput = Readonly<{
  expectedHash: string;
  text: string;
  subparts: readonly Subpart[];
  correctedBy: string;
  correctedOn: IsoDate;
  reason: string;
}>;

export type AuditQueryOptions = Readonly<{ limit?: number }>;
