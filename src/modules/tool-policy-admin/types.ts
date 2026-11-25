/**
 * نوع‌های «مدیریتِ نسخه‌دارِ سیاستِ دروازهٔ ابزار» (ADR-0069، برش CT‑5c‑2b‑1).
 * هیچ قیمت، ارز، حساب، کلید یا I/O این‌جا نیست؛ ذخیره‌سازی پشتِ پورتِ `PolicyVersionStore` است (آداپتورِ PostgreSQL برشِ 2b‑2).
 */
import type { ToolPolicy, ToolPolicyOverrides } from "@/modules/tool-policy";

/** مقدارِ مؤثرِ یک فیلد پیش و پس از تغییر؛ `null` فقط وقتی فیلد در یکی از دو عکسِ سیاست نبوده است. */
export type PolicyChange = Readonly<{ path: string; from: string | number | null; to: string | number | null }>;

export type PolicyVersionSource = Readonly<{ kind: "set" }> | Readonly<{ kind: "rollback"; toVersion: number }>;

/** یک نسخهٔ ثبت‌شده؛ فقط افزوده می‌شود و هرگز ویرایش یا حذف نمی‌شود. نسخهٔ ۰ = پیش‌فرض‌های کد و رکوردی ندارد. */
export type PolicyVersionRecord = Readonly<{
  version: number;
  /** نیتِ ادمین (کانونی: کلیدها مرتب، بخشِ خالی حذف)؛ دوباره روی پیش‌فرض‌های **کدِ جاری** اعتبارسنجی می‌شود. */
  overrides: ToolPolicyOverrides;
  /** عکسِ سیاستِ مؤثر در لحظهٔ ثبت (برای ممیزی و آشکارکردنِ رانشِ پیش‌فرض‌های کد). */
  policy: ToolPolicy;
  /** تفاوتِ مقدارِ مؤثر با نسخهٔ پیشین (یا پیش‌فرض‌های کد برای نسخهٔ ۱). */
  changes: readonly PolicyChange[];
  source: PolicyVersionSource;
  actor: string;
  reason: string;
  createdAtMs: number;
}>;

/** `CONFLICT`: نسخهٔ پیشنهادی نسخهٔ بعدیِ دقیقِ آخرین نبود؛ `INVALID`: رکورد شکلِ مجاز را ندارد؛ `UNAVAILABLE`: ذخیره‌ساز در دسترس نیست. */
export type StoreErrorCode = "CONFLICT" | "INVALID" | "UNAVAILABLE";
export type StoreResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Readonly<{ code: StoreErrorCode }> }>;

/**
 * پورتِ ذخیره‌سازِ نسخه‌ها. قرارداد (آزمونِ مشترکِ `store-contract.ts` برای هر آداپتور):
 * - `append` اتمی و CAS است: فقط وقتی `record.version === آخرین+۱` (یا ۱ در ذخیره‌سازِ خالی) می‌نویسد، وگرنه `CONFLICT`؛ هیچ شکافی و هیچ بازنویسی.
 * - `latest`/`get`/`list` فقط می‌خوانند؛ `list` نزولی بر پایهٔ نسخه، `beforeVersion` انحصاری، `limit` ≥ ۱.
 * - هرگز نمی‌پرتابد؛ خطا همیشه `Result`. (مدیر با این حال پرتابِ آداپتور را هم می‌گیرد و متنِ آن را نمی‌خواند.)
 */
export interface PolicyVersionStore {
  latest(): Promise<StoreResult<PolicyVersionRecord | null>>;
  get(version: number): Promise<StoreResult<PolicyVersionRecord | null>>;
  append(record: PolicyVersionRecord): Promise<StoreResult<null>>;
  list(query: Readonly<{ beforeVersion: number | null; limit: number }>): Promise<StoreResult<readonly PolicyVersionRecord[]>>;
}

/** ساعت تزریقی (ماژول خالص است و ساعتِ سیستم را نمی‌خواند). */
export interface PolicyClock {
  nowMs(): number;
}

export type AdminErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_OVERRIDES"
  | "INVALID_CLOCK"
  | "VERSION_CONFLICT"
  | "NO_CHANGE"
  | "VERSION_NOT_FOUND"
  | "STORED_POLICY_INVALID"
  | "STORE_FAILURE";

/** `issues` فقط مسیرِ فیلد و کران را می‌گوید، هرگز مقدارِ ورودی یا متنِ استثنای آداپتور را. `currentVersion` وقتی معلوم باشد. */
export type AdminError = Readonly<{ code: AdminErrorCode; message: string; issues: readonly string[]; currentVersion: number | null }>;
export type AdminResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: AdminError }>;

export type CurrentPolicy = Readonly<{
  /** ۰ = پیش‌فرض‌های کد (هنوز نسخه‌ای ثبت نشده). */
  version: number;
  source: "defaults" | "stored";
  /** سیاستِ مؤثر، دوباره‌اعتبارسنجی‌شده با کدِ جاری. */
  policy: ToolPolicy;
  overrides: ToolPolicyOverrides;
  /** `true` یعنی با پیش‌فرض‌ها/کرانِ کدِ جاری، سیاستِ مؤثر با عکسِ لحظهٔ ثبت فرق دارد (کد عوض شده است؛ ادمین باید ببیند). */
  drift: boolean;
  updatedAtMs: number | null;
}>;

export type AppliedVersion = Readonly<{
  version: number;
  policy: ToolPolicy;
  overrides: ToolPolicyOverrides;
  changes: readonly PolicyChange[];
  createdAtMs: number;
}>;

export type HistoryPage = Readonly<{
  /** نزولی بر پایهٔ نسخه. */
  entries: readonly PolicyVersionRecord[];
  /** برای صفحهٔ بعد `beforeVersion` همین مقدار؛ `null` = پایان. */
  nextBefore: number | null;
}>;

export interface ToolPolicyAdmin {
  /** ورودی: `{ expectedVersion, overrides, actor, reason }` — جایگزینیِ **کاملِ** بازنویسی‌ها (`{}` = بازگشت به پیش‌فرض‌های کد). */
  set(input: unknown): Promise<AdminResult<AppliedVersion>>;
  /** ورودی: `{ expectedVersion, toVersion, actor, reason }` — نسخهٔ **تازه** با بازنویسی‌های نسخهٔ قدیمی؛ تاریخچه بازنویسی نمی‌شود. */
  rollbackTo(input: unknown): Promise<AdminResult<AppliedVersion>>;
  current(): Promise<AdminResult<CurrentPolicy>>;
  /** ورودی (اختیاری): `{ beforeVersion?, limit? }`. */
  history(input?: unknown): Promise<AdminResult<HistoryPage>>;
}
