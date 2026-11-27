/**
 * انواع tool-policy-migrate (CT‑5c‑2c‑3، ADR-0080). هیچ نوعی مقدارِ محیط، رشتهٔ اتصال یا متنِ خطای پایگاه را حمل نمی‌کند:
 * گزارش فقط نامِ متغیر، نامِ مهاجرت، کدِ بسته، شمارش‌ها و (در صورتِ وجود) SQLSTATE پنج‌نویسه دارد.
 */
import type { PgPolicyMigrationReport, PgPolicyResult, PgPolicyStoreStatus } from "@/modules/tool-policy-store-pg";

/**
 * جدولِ کدهای خروجِ بسته (قراردادِ استقرار؛ هر مقدار با آزمون قفل است). ۰ تا ۷ هم‌معنای settlement-migrate است؛ ۸ مخصوصِ این ابزار:
 * - `OK` ۰: status: آماده (همهٔ مهاجرت‌ها اعمال، بی‌مشکل، نسخه‌ها بی‌شکاف) · up: موفق (یا کاری نبود).
 * - `INTERNAL` ۱: خطای برنامه‌نویسی/پورتِ خراب؛ هرگز در مسیرِ عادی نیست.
 * - `USAGE` ۲: آرگومان یا محیط نامعتبر؛ هیچ اتصالی ساخته نشد.
 * - `PENDING` ۳: فقط `status`: شِما/جدول نیست یا مهاجرتِ معلق دارد (دروازهٔ استقرار: «پیش از start باید ۰ باشد»).
 * - `UNAVAILABLE` ۴: پایگاه در دسترس نیست (اتصال/اجرا)؛ هیچ تغییری اعمال نشد.
 * - `SCHEMA_MISMATCH` ۵: دفترِ مهاجرت با کد نمی‌خواند (دست‌کاری، حفره، پایگاهِ «از آینده»)، قید/تریگرِ فقط‌افزودنی نیست/خاموش است، یا نسخه‌ها شکاف دارند؛ **هیچ تغییری اعمال نشد**.
 * - `MIGRATION_FAILED` ۶: `up` در مرحلهٔ ساختنِ شِما، اعمال یا راستی‌آزماییِ پس از آن شکست خورد (تکرار امن است).
 * - `TIMEOUT` ۷: مهلتِ کل گذشت؛ تراکنشِ نیمه‌کاره با بسته‌شدنِ اتصال برمی‌گردد (DDL پستگرس تراکنشی است).
 * - `SCHEMA_MISSING` ۸: فقط `up`: شِما وجود ندارد و `--create-schema` داده نشده؛ **هیچ تغییری اعمال نشد** (ساختنِ شِما کارِ آگاهانهٔ مدیر است).
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
  SCHEMA_MISSING: 8,
} as const);

export type MigrateCode = keyof typeof MIGRATE_EXIT;
export type MigrateExitCode = (typeof MIGRATE_EXIT)[MigrateCode];

export type MigrateCommandName = "status" | "up";
/** `check`: خواندنِ فقط‌خواندنیِ وضعیت · `schema`: ساختنِ شِما · `apply`: اعمال · `verify`: خواندنِ دوباره پس از اعمال. */
export type MigratePhase = "check" | "schema" | "apply" | "verify";

export type MigrateSettings = Readonly<{
  command: MigrateCommandName;
  timeoutMs: number;
  /** `null` = پیش‌فرضِ ماژولِ پایین‌دست (همان معنای نبودنِ متغیر در tool-policy-bootstrap). */
  schema: string | null;
  /** فقط با `up`؛ پیش‌فرض `false`. */
  createSchema: boolean;
}>;

export type ParsedArgs = MigrateSettings | Readonly<{ command: "help" }>;

export type ArgsResult =
  | Readonly<{ ok: true; value: ParsedArgs }>
  | Readonly<{ ok: false; command: MigrateCommandName | null; issues: readonly string[] }>;

/** وضعیتِ فروشگاه؛ `appliedNow` فقط مهاجرت‌هایی که همین اجرا اعمال کرد (در `status` همیشه خالی). `problemCount` فقط شمارش است، نه متن. */
export type PolicyState = Readonly<{
  schemaExists: boolean;
  applied: readonly string[];
  pending: readonly string[];
  appliedNow: readonly string[];
  rows: number;
  latestVersion: number | null;
  contiguous: boolean;
  problemCount: number;
  ready: boolean;
}>;

export type MigrateReport = Readonly<{
  tool: "tool-policy-migrate";
  command: MigrateCommandName | "help" | "unknown";
  ok: boolean;
  code: MigrateCode;
  exitCode: MigrateExitCode;
  phase?: MigratePhase;
  /** فقط SQLSTATEِ پنج‌نویسه (ثابت و بی‌خطر)؛ هرگز متنِ خطا. */
  pgCode?: string;
  state?: PolicyState;
  /** `true` اگر همین اجرا شِما را ساخت (فقط با `up --create-schema`). */
  schemaCreated?: boolean;
  /** فقط نامِ متغیر/آرگومان، هرگز مقدار. */
  issues?: readonly string[];
  usage?: readonly string[];
  /** شمارِ بازتلاش‌های schema/apply به‌خاطر مسابقهٔ هم‌زمانی (فقط اگر > ۰). */
  retries?: number;
  /** `false` یعنی بستنِ اتصال شکست خورد یا به مهلت خورد (فرایند باید سخت بمیرد). نبودنِ اتصال = `true`. */
  closed?: boolean;
}>;

export type MigrateOutcome = Readonly<{ exitCode: MigrateExitCode; report: MigrateReport }>;

/** نتیجهٔ پورتِ فروشگاه؛ سازگار با `PgPolicyResult` (فقط `code`/`pgCode` خوانده می‌شود). */
export type MigrateStoreResult<T> = PgPolicyResult<T>;

/**
 * پورتِ ساختنِ شِما (تزریقیِ گلو): `CREATE SCHEMA IF NOT EXISTS` را روی `db` برای شِمای **اعتبارسنجی‌شده** اجرا می‌کند و در شکست می‌پرتابد/رد می‌شود
 * (فقط SQLSTATE از زنجیرهٔ `cause` خوانده می‌شود). ماژول خودش هیچ SQLای ندارد (ADR-0080 تصمیم ۳).
 */
export type CreateSchemaPort = (db: unknown, schema: string) => unknown;

/** رابطِ کمینهٔ فروشگاهِ مهاجرت‌پذیرِ سیاست؛ `createSchema` تنها عملیاتِ خارج از `PgPolicyVersionStore` است (ADR-0080 تصمیم ۳). */
export type MigratableStore = Readonly<{
  status(): Promise<PgPolicyResult<PgPolicyStoreStatus>>;
  migrate(): Promise<PgPolicyResult<PgPolicyMigrationReport>>;
  /** ساختنِ همان شِمای اعتبارسنجی‌شده با پورتِ گلو؛ idempotent. */
  createSchema(): Promise<PgPolicyResult<null>>;
}>;

export type StoreResult = Readonly<{ ok: true; store: MigratableStore }> | Readonly<{ ok: false; issues: readonly string[] }>;

/** زمان‌سنجِ تزریقی (هم‌شکل با `LoopTimer` تسویه؛ این ماژول به آن وابسته نیست). */
export type MigrateTimer = Readonly<{ after(fn: () => void, ms: number): unknown; cancel(handle: unknown): void }>;

/** پایگاهِ بازشده: `db` همان drizzle (execute/transaction)؛ `close` همیشه یک بار و کران‌دار صدا زده می‌شود. */
export type OpenedMigrateDatabase = Readonly<{ db: unknown; close: () => unknown }>;

export type MigratePorts = Readonly<{
  /** فقط پس از معتبر بودنِ آرگومان/محیط و ساختنِ فروشگاه و در نخستین استفاده صدا زده می‌شود (تنبل). */
  open: () => OpenedMigrateDatabase | Promise<OpenedMigrateDatabase>;
  timer: MigrateTimer;
  /** یک خط (JSON + `\n`) برای stdout؛ پرتابش بی‌اثر است. */
  write: (line: string) => unknown;
  /** گلو: DDLِ `CREATE SCHEMA IF NOT EXISTS`؛ بدونِ `createStore` الزامی است. */
  createSchema?: CreateSchemaPort;
  /** فقط برای آزمون: پیش‌فرض فروشگاهِ واقعی روی `db`. */
  createStore?: (db: unknown, schema: string | null) => StoreResult;
}>;

export type MigrateInput = Readonly<{ argv: unknown; env: unknown; ports: MigratePorts }>;
