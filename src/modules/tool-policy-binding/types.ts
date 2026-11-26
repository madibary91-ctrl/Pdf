/**
 * نوع‌های «پیوندِ سیاست به دروازه» (ADR-0077، برش CT‑5c‑2c‑2b‑2a). این ماژول فقط **پین‌کردنِ یک سیاستِ معتبر به‌ازای هر درخواست** است:
 * `snapshot()` منبعِ سیاست را (ورودیِ ناقابل‌اعتماد) می‌خواند، `projection` را دوباره اعتبارسنجی می‌کند و برای هر نسخه دقیقاً یک نمونهٔ
 * پایین‌دست (مثلاً `CalcAnswerService`) می‌سازد. هیچ قیمت، ارز، حساب، کلید، سقفِ هزینه، ساعت یا I/O این‌جا نیست.
 */
import type { PolicyProjection } from "@/modules/tool-policy";

/** دلیل‌های بستهٔ «سیاستِ قابل‌اجرا نیست». سه کدِ نخست عیناً از `snapshot()` منبع می‌آیند؛ بقیه را همین ماژول می‌گوید. */
export type PolicyUnavailableReason =
  | "NOT_LOADED"
  | "STALE"
  | "CLOCK_INVALID"
  | "SOURCE_INVALID"
  | "PROJECTION_INVALID"
  | "VERSION_REGRESSED"
  | "VERSION_CONTENT_MISMATCH"
  | "BUILD_FAILED";

export type PolicyUnavailable = Readonly<{
  code: "POLICY_UNAVAILABLE";
  reason: PolicyUnavailableReason;
  /** متنِ ثابت به‌ازای هر دلیل؛ هرگز مقدار، متنِ خطای پایین‌دست یا محتوای سیاست. */
  message: string;
}>;

/**
 * اجارهٔ یک درخواست: همه‌چیزِ آن تا پایانِ درخواست ثابت است (حتی اگر نسخهٔ تازه‌ای فعال شود).
 * `projection` ژرف‌یخ‌زده و بازساخته از اعتبارسنجیِ مجدد است، نه شیءِ دریافتیِ منبع.
 */
export type PolicyLease<T> = Readonly<{
  version: number;
  source: "defaults" | "stored";
  drift: boolean;
  ageMs: number;
  projection: PolicyProjection;
  /** نمونه‌ای که `build` برای همین نسخه ساخته؛ مشترک میانِ درخواست‌های همین نسخه. */
  instance: T;
}>;

export type AcquireResult<T> = Readonly<{ ok: true; value: PolicyLease<T> }> | Readonly<{ ok: false; error: PolicyUnavailable }>;

/** رویدادهای بستهٔ مشاهده؛ فقط عدد و کدِ ثابت. `unavailable` و `recovered` فقط روی **تغییرِ حالت** می‌آیند (نه به‌ازای هر درخواست). */
export type BindingEvent =
  | Readonly<{ type: "policy.activated"; version: number; previousVersion: number | null }>
  | Readonly<{ type: "policy.unavailable"; reason: PolicyUnavailableReason }>
  | Readonly<{ type: "policy.recovered"; version: number }>;

export type BindingStatus = Readonly<{
  /** نسخهٔ فعالِ سالم؛ `null` وقتی نسخه‌ای هنوز فعال نشده یا ساختنِ آن شکست خورده. */
  activeVersion: number | null;
  /** بالاترین نسخه‌ای که projectionـش معتبر دیده شد (ترازوی ضدعقب‌گرد). */
  highestVersion: number | null;
  lastUnavailable: PolicyUnavailableReason | null;
  activations: number;
  buildFailures: number;
  acquired: number;
  rejected: number;
}>;

/** کوچک‌ترین بخشِ منبع که لازم است (`PolicySource`/`ToolPolicyRuntime` ساختاری با آن سازگارند). خروجی‌اش ناقابل‌اعتماد فرض می‌شود. */
export type SnapshotPort = Readonly<{ snapshot(): unknown }>;

export type PolicyBindingOptions = Readonly<{
  source: SnapshotPort;
  /**
   * برای هر نسخهٔ تازه **یک بار** صدا زده می‌شود (همگام، بی‌I/O). باید `{ ok: true, value: <شیء> }` بدهد
   * (`createCalcAnswerService` ساختاری با آن سازگار است)؛ هر چیزِ دیگر یا پرتاب ⇒ `BUILD_FAILED` (شکست‌بسته؛ به نسخهٔ قبلی برنمی‌گردد).
   */
  build: (projection: PolicyProjection) => unknown;
  observer?: (event: BindingEvent) => unknown;
}>;

export type BindingConfigError = Readonly<{ code: "INVALID_CONFIG"; message: string; issues: readonly string[] }>;
export type BindingCreateResult<T> = Readonly<{ ok: true; value: PolicyBinding<T> }> | Readonly<{ ok: false; error: BindingConfigError }>;

export type PolicyBinding<T> = Readonly<{
  /** همگام و بی‌I/O (مسیرِ داغ). هرگز نمی‌پرتابد. */
  acquire(): AcquireResult<T>;
  status(): BindingStatus;
}>;
