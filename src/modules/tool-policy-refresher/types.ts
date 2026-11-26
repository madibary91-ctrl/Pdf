/**
 * نوع‌های «حلقهٔ تازه‌سازیِ دوره‌ایِ سیاستِ ابزار» (ADR-0072، برش CT‑5c‑2c‑2a).
 * زمان‌سنج پورتِ تزریقی است؛ این ماژول `setTimeout` را نمی‌شناسد و هیچ قیمت، ارز، حساب یا کلیدی ندارد.
 */
import type { RefreshErrorCode } from "@/modules/tool-policy-source";

/** هم‌شکلِ `LoopTimer`ِ settlement و خروجیِ `createNodeTimer`ِ ریشه؛ `after` باید با ورودیِ نامعتبر بپرتابد (شکستِ بسته). */
export interface RefreshTimer {
  after(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** کوچک‌ترین بخشِ `PolicySource` که حلقه لازم دارد؛ نتیجه ورودیِ ناشناخته است و بازبینی می‌شود. */
export interface RefreshableSource {
  refresh(): Promise<unknown>;
}

export type RefresherOptions = Readonly<{
  source: RefreshableSource;
  timer: RefreshTimer;
  /** فاصلهٔ پس از یک تلاشِ موفق تا تلاشِ بعد. */
  intervalMs: number;
  /** فاصلهٔ پس از تلاشِ ناموفق/بی‌پاسخ/رهاشده؛ `≤ intervalMs`. */
  retryMs: number;
  /** سقفِ انتظارِ حلقه برای یک تلاش؛ پس از آن تلاش «بی‌پاسخ» حساب می‌شود و حلقه ادامه می‌دهد (قفل نمی‌شود). `≥ refreshTimeoutMs`. */
  attemptDeadlineMs: number;
  /** همان `refreshTimeoutMsِ` منبع (برای سنجشِ رابطه؛ منبع آن را از این‌جا نمی‌گیرد). */
  refreshTimeoutMs: number;
  /** همان `maxStaleMsِ` منبع (برای سنجشِ رابطهٔ تحملِ یک چرخهٔ ازدست‌رفته). */
  maxStaleMs: number;
}>;

export type RefresherConfigError = Readonly<{ code: "INVALID_CONFIG"; message: string; issues: readonly string[] }>;
export type RefresherResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: RefresherConfigError }>;

/** `superseded`: تلاش را تلاشِ دیگری (مثلاً دستی) کنار زد؛ شکستِ منبع نیست و شمارندهٔ شکست را تغییر نمی‌دهد. */
export type AttemptOutcome = "ok" | "failed" | "timed_out" | "superseded";

/** کدِ شکستِ حلقه: کدهای منبع (جز SUPERSEDED) + سه کدِ خودِ حلقه. هرگز متنِ خطا. */
export type RefresherFailureCode = Exclude<RefreshErrorCode, "SUPERSEDED"> | "TIMED_OUT" | "REFRESH_THREW" | "INVALID_RESULT";

/**
 * - `idle`: کار نمی‌کند (هرگز شروع نشده یا `stop` شده).
 * - `running`: حلقه فعال است.
 * - `stopping`: `stop()` منتظرِ پایانِ تلاشِ در جریان است (حداکثر تا سقفِ `attemptDeadlineMs`).
 * - `halted`: زمان‌بندی شکست خورد (`SCHEDULE_FAILED`)؛ حلقه خاموش است و منبع به‌زودی `STALE` می‌شود (بسته). با `start()` دوباره آغاز می‌شود.
 */
export type RefresherState = "idle" | "running" | "stopping" | "halted";

export type RefresherStatus = Readonly<{
  state: RefresherState;
  haltReason: "SCHEDULE_FAILED" | null;
  inFlight: boolean;
  attempts: number;
  consecutiveFailures: number;
  lastOutcome: AttemptOutcome | null;
  lastFailure: RefresherFailureCode | null;
}>;

export type StartFailureReason = "ALREADY_RUNNING" | "STOPPING" | "SCHEDULE_FAILED";
export type RefresherStartResult = Readonly<{ started: true }> | Readonly<{ started: false; reason: StartFailureReason }>;
/** `abandonedInFlight`: تلاشِ در جریان تا سقفِ مهلت پاسخ نداد و رها شد (نتیجه‌اش اگر برسد دورریخته می‌شود). */
export type RefresherStopResult = Readonly<{ stopped: true; abandonedInFlight: boolean }>;

export interface PolicyRefresher {
  /** همگام: نخستین تلاش را بی‌درنگ آغاز می‌کند و منتظرش نمی‌ماند. هرگز نمی‌پرتابد. */
  start(): RefresherStartResult;
  /** تایمرِ بعدی را لغو می‌کند و برای تلاشِ در جریان حداکثر تا `attemptDeadlineMs` صبر می‌کند. هم‌زمان‌ها یک وعده را شریک‌اند. هرگز نمی‌پرتابد. */
  stop(): Promise<RefresherStopResult>;
  /** همگام و بی‌I/O. */
  status(): RefresherStatus;
}
