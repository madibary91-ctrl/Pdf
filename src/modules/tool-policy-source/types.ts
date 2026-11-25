/**
 * نوع‌های «منبعِ تازه‌شوندهٔ سیاستِ ابزار» (ADR-0071، برش CT‑5c‑2c‑1).
 * هیچ I/O، تایمر، قیمت، ارز، حساب یا کلید این‌جا نیست؛ خواندن از پشتِ پورتِ `PolicyReader` است و ساعت تزریق می‌شود.
 */
import type { PolicyProjection } from "@/modules/tool-policy";
import type { AdminResult, CurrentPolicy, PolicyClock } from "@/modules/tool-policy-admin";

/** کوچک‌ترین بخشِ `ToolPolicyAdmin` که این ماژول لازم دارد (`ToolPolicyAdmin` ساختاری با آن سازگار است). */
export interface PolicyReader {
  current(): Promise<AdminResult<CurrentPolicy>>;
}

export type PolicySourceOptions = Readonly<{
  reader: PolicyReader;
  /** باید یکنوا (monotonic) باشد؛ پرشِ رو به عقبِ ساعت ⇒ `CLOCK_INVALID` تا تازه‌سازیِ بعدی (بسته‌شدنِ شکست). */
  clock: PolicyClock;
  /** بیشترین سنِ مجازِ آخرین تأییدِ موفق؛ فراتر ⇒ `STALE` (بی‌پیش‌فرض: عددِ ایمنی را مالکِ استقرار می‌گذارد). */
  maxStaleMs: number;
  /** پس از این مدت، تلاشِ در جریان رها می‌شود و تازه‌سازیِ بعدی تلاشِ نو می‌زند (ماژول تایمر ندارد). بی‌پیش‌فرض. */
  refreshTimeoutMs: number;
}>;

export type SourceConfigErrorCode = "INVALID_CONFIG";
export type SourceConfigError = Readonly<{ code: SourceConfigErrorCode; message: string; issues: readonly string[] }>;

/** `SUPERSEDED`: تلاشِ رهاشده بود و نتیجه‌اش دورریخته شد (حالتی تغییر نکرد). */
export type RefreshErrorCode =
  | "INVALID_CLOCK"
  | "READ_FAILED"
  | "STORED_POLICY_INVALID"
  | "INVALID_RESPONSE"
  | "PROJECTION_INVALID"
  | "VERSION_REGRESSED"
  | "VERSION_CONTENT_MISMATCH"
  | "SUPERSEDED";

export type RefreshOutcome = "loaded" | "updated" | "unchanged";

export type RefreshResult =
  | Readonly<{ ok: true; value: Readonly<{ outcome: RefreshOutcome; version: number }> }>
  | Readonly<{ ok: false; error: Readonly<{ code: RefreshErrorCode; message: string }> }>;

export type SnapshotErrorCode = "NOT_LOADED" | "STALE" | "CLOCK_INVALID";

export type PolicySnapshot = Readonly<{
  /** ۰ = پیش‌فرض‌های کد. */
  version: number;
  source: "defaults" | "stored";
  projection: PolicyProjection;
  drift: boolean;
  /** لحظهٔ شروعِ تازه‌سازیِ موفقی که این نسخه را برای اولین بار آورد. */
  loadedAtMs: number;
  /** لحظهٔ شروعِ آخرین تازه‌سازیِ موفقی که همین نسخه را تأیید کرد (محافظه‌کارانه: شروع، نه پایان). */
  confirmedAtMs: number;
  ageMs: number;
}>;

export type SnapshotResult =
  | Readonly<{ ok: true; value: PolicySnapshot }>
  | Readonly<{ ok: false; error: Readonly<{ code: SnapshotErrorCode; message: string }> }>;

export type SourceState = "NOT_LOADED" | "FRESH" | "STALE" | "CLOCK_INVALID";

/** فقط کدهای ثابت و عدد؛ هرگز متنِ خطا یا محتوای سیاست. */
export type SourceHealth = Readonly<{
  state: SourceState;
  version: number | null;
  ageMs: number | null;
  drift: boolean | null;
  consecutiveFailures: number;
  lastFailure: RefreshErrorCode | null;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
}>;

export interface PolicySource {
  /** هم‌زمان‌ها یک تلاش را شریک‌اند. هرگز نمی‌پرتابد. (اگر `reader` هرگز تمام نکند، این هم تمام نمی‌شود؛ سقفِ زمانی با ذخیره‌ساز است.) */
  refresh(): Promise<RefreshResult>;
  /** همگام و بی‌I/O (مسیرِ داغِ هر درخواست). هرگز نمی‌پرتابد. نسخهٔ کهنه‌تر از `maxStaleMs` هرگز داده نمی‌شود. */
  snapshot(): SnapshotResult;
  health(): SourceHealth;
}
