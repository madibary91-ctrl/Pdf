/**
 * انواع settlement-pending-migrate (م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۱، ADR-0047). هیچ نوعی مقدارِ محیط، رشتهٔ اتصال یا متنِ خطای پایگاه را حمل نمی‌کند:
 * گزارش فقط نامِ متغیر، نامِ مهاجرت، کدِ بسته، شمارش‌های `verify` و (در صورتِ وجود) SQLSTATE پنج‌نویسه دارد.
 */
import type { LedgerDatabase, PgMigrationReport, PgMigrationStatus, PgStoreResult } from "@/modules/ledger";
import type { LoopTimer } from "@/modules/settlement";
import type { PendingDownReport, PendingVerifyReport } from "@/modules/settlement-pending";

/**
 * جدولِ کدهای خروجِ بسته (قراردادِ استقرار؛ هر مقدار با آزمون قفل است). ۰ تا ۷ هم‌معنا با `settlement-migrate` (ADR-0034) و سه کدِ تازه:
 * - `OK` ۰: status: نمایه نصب‌شده و به‌روز · up: موفق (یا کاری نبود) · verify: نمایه با حقیقت می‌خواند.
 * - `INTERNAL` ۱: خطای برنامه‌نویسی/پورتِ خراب/شکلِ ناشناختهٔ پاسخ؛ هرگز «خوب» نمی‌شود.
 * - `USAGE` ۲: آرگومان یا محیط نامعتبر؛ هیچ اتصالی ساخته نشد.
 * - `PENDING` ۳: status/verify: مهاجرتِ نمایه معلق است (نصب نشده/ناقص) · دروازهٔ استقرار.
 * - `UNAVAILABLE` ۴: پایگاه در دسترس نیست؛ هیچ تغییری اعمال نشد.
 * - `SCHEMA_MISMATCH` ۵: دفترِ مهاجرتِ نمایه با کد نمی‌خواند (دست‌کاری، حفره، پایگاهِ «از آینده»)؛ هیچ تغییری اعمال نشد.
 * - `MIGRATION_FAILED` ۶: up در apply یا راستی‌آزماییِ وضعیتِ پس از آن شکست خورد (تراکنشِ apply یکپارچه برگشته؛ تکرار امن است).
 * - `TIMEOUT` ۷: مهلتِ کل یا سقفِ زمانِ سمتِ پایگاه (57014) گذشت؛ تراکنشِ نیمه‌کار با بسته‌شدنِ اتصال برمی‌گردد.
 * - `PREREQUISITE` ۸: جدول‌های outbox/تأییدِ settlement نیستند؛ ابتدا `settlement:migrate up`. هیچ تغییری اعمال نشد.
 * - `INCONSISTENT` ۹: verify (یا راستی‌آزماییِ پس از up) نمایه را با حقیقت ناهمخوان یافت (`missing`/`stale` > ۰). **پس از up یعنی نصب پذیرفته نیست.**
 * - `LOCK_BUSY` ۱۰: backfill در ۱۵ثانیه قفلِ نویسنده‌ها را نگرفت (`lock_timeout`، 55P03)؛ مهاجرت برگشت و چیزی عوض نشد؛ در پنجرهٔ کم‌ترافیک دوباره بزنید (خودکار تکرار نمی‌شود: هر تلاش نویسنده‌ها را در صف می‌گذارد).
 */
export const PENDING_MIGRATE_EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  PENDING: 3,
  UNAVAILABLE: 4,
  SCHEMA_MISMATCH: 5,
  MIGRATION_FAILED: 6,
  TIMEOUT: 7,
  PREREQUISITE: 8,
  INCONSISTENT: 9,
  LOCK_BUSY: 10,
} as const);

export type PendingMigrateCode = keyof typeof PENDING_MIGRATE_EXIT;
export type PendingMigrateExitCode = (typeof PENDING_MIGRATE_EXIT)[PendingMigrateCode];

/** `down` (ADR-0049) مخرب است و فقط با `--yes` اجرا می‌شود؛ هیچ داده‌ای از حقیقتِ مالی (outbox/تأیید) را نمی‌برد، فقط نمایهٔ مشتق را برمی‌دارد. */
export type PendingCommandName = "status" | "up" | "verify" | "down";
/** `check`: خواندنِ فقط‌خواندنیِ وضعیت · `apply`: اعمال · `verify`: خواندنِ دوبارهٔ وضعیت و راستی‌آزماییِ نمایه در برابر حقیقت. */
export type PendingPhase = "check" | "apply" | "verify";

export type PendingMigrateSettings = Readonly<{
  command: PendingCommandName;
  timeoutMs: number;
  /** `null` = شِمای پیش‌فرضِ settlement (همان معنای نبودنِ متغیر در settlement-bootstrap). */
  schema: string | null;
}>;

export type ParsedArgs = PendingMigrateSettings | Readonly<{ command: "help" }>;

export type ArgsResult =
  | Readonly<{ ok: true; value: ParsedArgs }>
  | Readonly<{ ok: false; command: PendingCommandName | null; issues: readonly string[] }>;

/**
 * وضعیتِ دفترِ مهاجرتِ نمایه: `appliedNow` فقط مهاجرت‌هایی که همین اجرا اعمال کرد (در status/verify/down همیشه خالی).
 * `revertedNow` فقط در `down` می‌آید: مهاجرت‌هایی که همین اجرا برگرداند (به ترتیبِ برگشت؛ نصب‌نشده/برگشتِ هم‌زمانِ دیگری = خالی).
 */
export type MigrationState = Readonly<{ applied: readonly string[]; pending: readonly string[]; appliedNow: readonly string[]; revertedNow?: readonly string[] }>;

export type PendingMigrateReport = Readonly<{
  tool: "settlement-pending-migrate";
  command: PendingCommandName | "help" | "unknown";
  ok: boolean;
  code: PendingMigrateCode;
  exitCode: PendingMigrateExitCode;
  phase?: PendingPhase;
  /** فقط SQLSTATEِ پنج‌نویسه (ثابت و بی‌خطر)؛ هرگز متنِ خطا. */
  pgCode?: string;
  migrations?: MigrationState;
  /** فقط شمارش‌ها (بی‌شناسه و مبلغ)؛ در verify و راستی‌آزماییِ پس از up. */
  verify?: PendingVerifyReport;
  /** فقط نامِ متغیر/آرگومان، هرگز مقدار. */
  issues?: readonly string[];
  usage?: readonly string[];
  /** شمارِ بازتلاش‌های apply به‌خاطر بن‌بست/ناسازگاریِ سریال‌سازی (فقط اگر > ۰). */
  retries?: number;
  /** `false` یعنی بستنِ اتصال شکست خورد یا به مهلت خورد (فرایند باید سخت بمیرد). نبودنِ اتصال = `true`. */
  closed?: boolean;
}>;

export type PendingMigrateOutcome = Readonly<{ exitCode: PendingMigrateExitCode; report: PendingMigrateReport }>;

/** رابطِ کمینهٔ نمایه (همان `PendingDeadIndex` بی‌خواندنِ لیست). */
export type PendingMigratable = Readonly<{
  status(): Promise<PgStoreResult<PgMigrationStatus>>;
  migrate(): Promise<PgStoreResult<PgMigrationReport>>;
  verify(): Promise<PgStoreResult<PendingVerifyReport>>;
  /**
   * برگشتِ رسمی (ADR-0048). **اختیاری در نوع** تا فروشگاه‌های ساختگیِ آزمون‌های ۰۰۴۷ (که فقط status/migrate/verify دارند) بی‌تغییر تایپ شوند؛
   * ولی فرمانِ `down` نبودنش را `INTERNAL` (بسته) می‌شمارد و هرگز حدس نمی‌زند. نمایهٔ واقعی همیشه دارد.
   */
  down?(): Promise<PgStoreResult<PendingDownReport>>;
}>;

export type IndexResult = Readonly<{ ok: true; index: PendingMigratable }> | Readonly<{ ok: false; issues: readonly string[] }>;

/** پایگاهِ بازشده: `db` همان drizzle (execute/transaction)؛ `close` همیشه یک بار و کران‌دار صدا زده می‌شود. */
export type OpenedPendingDatabase = Readonly<{ db: unknown; close: () => unknown }>;

export type PendingMigratePorts = Readonly<{
  /** فقط پس از معتبر بودنِ آرگومان/محیط و ساختنِ نمایه و در نخستین استفاده صدا زده می‌شود (تنبل). */
  open: () => OpenedPendingDatabase | Promise<OpenedPendingDatabase>;
  timer: LoopTimer;
  /** یک خط (JSON + `\n`) برای stdout. پرتابش بی‌اثر است. */
  write: (line: string) => unknown;
  /** فقط برای آزمون: پیش‌فرض نمایهٔ واقعیِ settlement-pending روی `db`. */
  createIndex?: (db: LedgerDatabase, options: Readonly<{ schema: string | null; readStatementTimeoutMs: number }>) => IndexResult;
}>;

export type PendingMigrateInput = Readonly<{ argv: unknown; env: unknown; ports: PendingMigratePorts }>;
