/**
 * انواع tool-policy-grants (CT‑5c‑2c‑4، ADR-0081). هیچ نوعی مقدارِ محیط، رشتهٔ اتصال یا متنِ خطای پایگاه را حمل نمی‌کند:
 * گزارش فقط نامِ نقش و شِمای **اعتبارسنجی‌شده**، یافته‌هایی از واژگانِ بسته، کدِ بسته و (در صورتِ وجود) SQLSTATE پنج‌نویسه دارد.
 */

/**
 * جدولِ کدهای خروجِ بسته (قراردادِ استقرار؛ هر مقدار با آزمون قفل است). ۰ تا ۷ هم‌معنای tool-policy-migrate است؛ ۵ و ۸ مخصوصِ این ابزارند:
 * - `OK` ۰: verify: حقوقِ مؤثرِ نقش **دقیقاً** قراردادِ زمانِ اجراست · apply: حقوق همین است (یا همین اجرا آن را همگرا کرد) · plan: چاپ شد.
 * - `INTERNAL` ۱: خطای برنامه‌نویسی/پورتِ خراب/پاسخِ بدشکلِ پایگاه؛ هرگز بی‌صدا «خوب» نمی‌شود.
 * - `USAGE` ۲: آرگومان یا محیط نامعتبر؛ هیچ اتصالی ساخته نشد.
 * - `PENDING` ۳: شِما یا جدولِ سیاست نیست (مهاجرت اجرا نشده: ابتدا `policy:migrate up`)؛ **هیچ تغییری اعمال نشد**.
 * - `UNAVAILABLE` ۴: پایگاه در دسترس نیست (اتصال/اجرا)؛ هیچ تغییری اعمال نشد.
 * - `DRIFT` ۵: فقط `verify`: حقوقِ مؤثرِ نقش با قرارداد نمی‌خواند (کم یا **زیاد**)؛ هیچ تغییری اعمال نشد.
 * - `APPLY_FAILED` ۶: `apply` شکست خورد یا پس از اعمال، خواندنِ دوباره هنوز ناهمخوانی نشان داد (مثلاً حقِ زیادی از راهِ PUBLIC یا عضویت)؛ تکرار امن است.
 * - `TIMEOUT` ۷: مهلتِ کل (یا `statement_timeout`/`lock_timeout`ِ سرور) گذشت؛ تراکنشِ نیمه‌کاره برمی‌گردد.
 * - `ROLE_UNUSABLE` ۸: نقش نیست، یا امتیازِ خطرناکِ نقش‌محور دارد (superuser/createrole/createdb/bypassrls/replication)، یا مالکِ (یا عضوِ مالکِ)
 *   شِما/جدول‌های سیاست است؛ **هیچ تغییری اعمال نشد** (با `GRANT` درست‌شدنی نیست و نقشِ زمانِ اجرا نمی‌تواند چنین نقشی باشد).
 */
export const GRANTS_EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  PENDING: 3,
  UNAVAILABLE: 4,
  DRIFT: 5,
  APPLY_FAILED: 6,
  TIMEOUT: 7,
  ROLE_UNUSABLE: 8,
} as const);

export type GrantsCode = keyof typeof GRANTS_EXIT;
export type GrantsExitCode = (typeof GRANTS_EXIT)[GrantsCode];

export type GrantsCommandName = "plan" | "verify" | "apply";
/** `check`: خواندنِ فقط‌خواندنیِ حقوقِ مؤثر · `apply`: REVOKE/GRANTِ همگراکننده · `verify`: خواندنِ دوباره پس از اعمال. */
export type GrantsPhase = "check" | "apply" | "verify";

export type GrantsSettings = Readonly<{
  command: GrantsCommandName;
  role: string;
  /** `null` = پیش‌فرضِ ذخیره‌ساز (`tool_policy`)؛ همان معنای نبودنِ متغیر در tool-policy-bootstrap. */
  schema: string | null;
  timeoutMs: number;
}>;

export type ParsedArgs = GrantsSettings | Readonly<{ command: "help" }>;

export type ArgsResult =
  | Readonly<{ ok: true; value: ParsedArgs }>
  | Readonly<{ ok: false; command: GrantsCommandName | null; issues: readonly string[] }>;

export type GrantsReport = Readonly<{
  tool: "tool-policy-grants";
  command: GrantsCommandName | "help" | "unknown";
  ok: boolean;
  code: GrantsCode;
  exitCode: GrantsExitCode;
  phase?: GrantsPhase;
  /** فقط SQLSTATEِ پنج‌نویسه (ثابت و بی‌خطر)؛ هرگز متنِ خطا. */
  pgCode?: string;
  /** نامِ نقش و شِما: هر دو پیش‌تر با فهرست‌سفیدِ سخت‌گیرانه (`[a-z0-9_]`) سنجیده شده‌اند. */
  role?: string;
  schema?: string;
  /** واژگانِ بسته: `role_*`، `schema_*`، `relation_missing:<جدول>`، `missing|excess:<شیء>:<حق>`، `owner:<شیء>`، `unexpected_relation_access`. */
  findings?: readonly string[];
  /** `true` اگر همین اجرا REVOKE/GRANT را در تراکنش اجرا کرد (apply بر نقشِ از پیش درست ⇒ نبودنِ کلید). */
  wrote?: boolean;
  /** فقط `plan`: دستورهای SQL (همه با شناسه‌های اعتبارسنجی‌شده؛ بی‌مقدارِ محیط). */
  statements?: readonly string[];
  /** فقط نامِ متغیر/آرگومان، هرگز مقدار. */
  issues?: readonly string[];
  usage?: readonly string[];
  /** `false` یعنی بستنِ اتصال شکست خورد یا به مهلت خورد (فرایند باید سخت بمیرد). نبودنِ اتصال = `true`. */
  closed?: boolean;
}>;

export type GrantsOutcome = Readonly<{ exitCode: GrantsExitCode; report: GrantsReport }>;

/** زمان‌سنجِ تزریقی (هم‌شکل با زمان‌سنجِ tool-policy-migrate؛ این ماژول به آن وابسته نیست). */
export type GrantsTimer = Readonly<{ after(fn: () => void, ms: number): unknown; cancel(handle: unknown): void }>;

/** پایگاهِ بازشده: `db` برای ماژول ناشفاف است و فقط به پورت‌های `query`/`transact` داده می‌شود؛ `close` همیشه یک بار و کران‌دار صدا زده می‌شود. */
export type OpenedGrantsDatabase = Readonly<{ db: unknown; close: () => unknown }>;

/**
 * پورتِ خواندن (گلو): `text` را با پارامترهای متنیِ `$1…` در یک تراکنشِ **فقط‌خواندنی** اجرا و `{ rows }` برمی‌گرداند.
 * پاسخ ورودیِ ناشناخته است و ماژول شکلش را می‌سنجد.
 */
export type QueryPort = (db: unknown, text: string, params: readonly string[]) => unknown;
/** پورتِ نوشتن (گلو): همهٔ دستورها را **در یک تراکنش** (همه یا هیچ) اجرا می‌کند؛ در شکست می‌پرتابد/رد می‌شود (فقط SQLSTATE از زنجیرهٔ `cause` خوانده می‌شود). */
export type TransactPort = (db: unknown, statements: readonly string[]) => unknown;

export type GrantsPorts = Readonly<{
  /** فقط پس از معتبر بودنِ آرگومان/محیط و در نخستین استفاده صدا زده می‌شود؛ `plan` هرگز اتصال نمی‌سازد. */
  open: () => OpenedGrantsDatabase | Promise<OpenedGrantsDatabase>;
  query: QueryPort;
  transact: TransactPort;
  timer: GrantsTimer;
  /** یک خط (JSON + `\n`) برای stdout؛ پرتابش بی‌اثر است. */
  write: (line: string) => unknown;
}>;

export type GrantsInput = Readonly<{ argv: unknown; env: unknown; ports: GrantsPorts }>;
