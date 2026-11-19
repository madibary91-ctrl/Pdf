/**
 * انواع settlement-migrate (م۳‑ه‑۳‑ج، ADR-0034). هیچ نوعی مقدارِ محیط، رشتهٔ اتصال یا متنِ خطای پایگاه را حمل نمی‌کند:
 * گزارش فقط نامِ متغیر، نامِ مهاجرت، کدِ بسته و (در صورتِ وجود) SQLSTATE پنج‌نویسه دارد.
 */
import type { LoopTimer } from "@/modules/settlement";
import type { LedgerDatabase, PgMigrationReport, PgMigrationStatus, PgStoreResult } from "@/modules/ledger";

/**
 * جدولِ کدهای خروجِ بسته (قراردادِ استقرار؛ هر مقدار با آزمون قفل است):
 * - `OK` ۰: وضعیت: همهٔ مهاجرت‌ها اعمال‌اند · up: موفق (یا کاری نبود).
 * - `INTERNAL` ۱: خطای برنامه‌نویسی/پورتِ خراب؛ هرگز در مسیرِ عادی نیست.
 * - `USAGE` ۲: آرگومان یا محیط نامعتبر؛ هیچ اتصالی ساخته نشد.
 * - `PENDING` ۳: فقط `status`: دست‌کم یک مهاجرت معلق است (دروازهٔ استقرار: «پیش از start باید ۰ باشد»).
 * - `UNAVAILABLE` ۴: پایگاه در دسترس نیست (اتصال/اجرا)؛ هیچ تغییری اعمال نشد.
 * - `SCHEMA_MISMATCH` ۵: دفترِ مهاجرت با کد نمی‌خواند (دست‌کاری، حفره، پایگاهِ «از آینده»، دادهٔ خراب)؛ **هیچ تغییری اعمال نشد**.
 * - `MIGRATION_FAILED` ۶: `up` در مرحلهٔ اعمال یا راستی‌آزماییِ پس از آن شکست خورد (ممکن است مرحلهٔ پیشین اعمال شده باشد؛ تکرار امن است).
 * - `TIMEOUT` ۷: مهلتِ کل گذشت؛ تراکنشِ نیمه‌کاره با بسته‌شدنِ اتصال برمی‌گردد (DDL پستگرس تراکنشی است).
 */
export const MIGRATE_EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  PENDING: 3,
  UNAVAILABLE: 4,
  SCHEMA_MISMATCH: 5,
  MIGRATION_FAILED: 6,
  TIMEOUT: 7,
} as const);

export type MigrateCode = keyof typeof MIGRATE_EXIT;
export type MigrateExitCode = (typeof MIGRATE_EXIT)[MigrateCode];

export type MigrateCommandName = "status" | "up";
/** `check`: خواندنِ فقط‌خواندنیِ وضعیت · `apply`: اعمال · `verify`: خواندنِ دوباره پس از اعمال. */
export type MigratePhase = "check" | "apply" | "verify";
export type MigrateStage = "ledger" | "settlement";

export type MigrateSettings = Readonly<{
  command: MigrateCommandName;
  timeoutMs: number;
  /** `null` = پیش‌فرضِ ماژولِ پایین‌دست (همان معنای نبودنِ متغیر در settlement-bootstrap). */
  ledgerSchema: string | null;
  settlementSchema: string | null;
}>;

export type ParsedArgs = MigrateSettings | Readonly<{ command: "help" }>;

export type ArgsResult =
  | Readonly<{ ok: true; value: ParsedArgs }>
  | Readonly<{ ok: false; command: MigrateCommandName | null; issues: readonly string[] }>;

/** وضعیتِ یک فروشگاه: `appliedNow` فقط مهاجرت‌هایی که همین اجرا اعمال کرد (در `status` همیشه خالی). */
export type StoreState = Readonly<{ applied: readonly string[]; pending: readonly string[]; appliedNow: readonly string[] }>;

export type MigrateReport = Readonly<{
  tool: "settlement-migrate";
  command: MigrateCommandName | "help" | "unknown";
  ok: boolean;
  code: MigrateCode;
  exitCode: MigrateExitCode;
  phase?: MigratePhase;
  stage?: MigrateStage;
  /** فقط SQLSTATEِ پنج‌نویسه (ثابت و بی‌خطر)؛ هرگز متنِ خطا. */
  pgCode?: string;
  ledger?: StoreState;
  settlement?: StoreState;
  /** فقط نامِ متغیر/آرگومان، هرگز مقدار. */
  issues?: readonly string[];
  usage?: readonly string[];
  /** شمارِ بازتلاش‌های apply به‌خاطر مسابقهٔ هم‌زمانی (فقط اگر > ۰). */
  retries?: number;
  /** `false` یعنی بستنِ اتصال شکست خورد یا به مهلت خورد (فرایند باید سخت بمیرد). نبودنِ اتصال = `true`. */
  closed?: boolean;
}>;

export type MigrateOutcome = Readonly<{ exitCode: MigrateExitCode; report: MigrateReport }>;

/** رابطِ کمینهٔ یک فروشگاهِ مهاجرت‌پذیر (هم `PgAccountStore` و هم `PgSettlementOutbox` آن را دارند). */
export type MigratableStore = Readonly<{
  status(): Promise<PgStoreResult<PgMigrationStatus>>;
  migrate(): Promise<PgStoreResult<PgMigrationReport>>;
}>;

export type StoresResult =
  | Readonly<{ ok: true; ledger: MigratableStore; settlement: MigratableStore }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

/** پایگاهِ بازشده: `db` همان drizzle (execute/transaction)؛ `close` همیشه یک بار و کران‌دار صدا زده می‌شود. */
export type OpenedMigrateDatabase = Readonly<{ db: unknown; close: () => unknown }>;

export type MigratePorts = Readonly<{
  /** فقط پس از معتبر بودنِ آرگومان/محیط و ساختنِ فروشگاه‌ها و در نخستین استفاده صدا زده می‌شود (تنبل). */
  open: () => OpenedMigrateDatabase | Promise<OpenedMigrateDatabase>;
  timer: LoopTimer;
  /** یک خط (JSON + `\n`) برای stdout. نپرتاب‌پذیرتر از نیاز نیست؛ پرتابش بی‌اثر است. */
  write: (line: string) => unknown;
  /** فقط برای آزمون: پیش‌فرض فروشگاه‌های واقعیِ ledger/settlement روی `db`. */
  createStores?: (db: LedgerDatabase, schemas: Readonly<{ ledger: string | null; settlement: string | null }>) => StoresResult;
}>;

export type MigrateInput = Readonly<{ argv: unknown; env: unknown; ports: MigratePorts }>;
