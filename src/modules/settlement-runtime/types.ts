/**
 * settlement-runtime — نوع‌های عمومی (ADR-0031، م۳‑ه‑۲). این ماژول فقط **ترکیب** می‌کند: سیاست‌ها (حلقه، رفتگر، ارزیاب) در `settlement` هستند.
 * هیچ نوعِ `settlement`/`ledger` اینجا بازتعریف نمی‌شود؛ فقط ارجاع.
 */
import type { Clock, Ledger, LedgerDatabase, PgStoreErrorCode } from "@/modules/ledger";
import type {
  DeadLetter,
  DueClaimer,
  LoopStopResult,
  LoopTimer,
  SettlementConfigError,
  SettlementOutbox,
  SettlementResult,
  SweepHealth,
  SweepLoopStatus,
  SweepObserver,
} from "@/modules/settlement";

/** نتیجهٔ ساختن: همان شکلِ `SettlementResult` (کدِ `INVALID_CONFIG`؛ پیام‌ها فقط نامِ فیلد، هرگز مقدار). */
export type RuntimeResult<T> = SettlementResult<T>;
export type RuntimeConfigError = SettlementConfigError;

/**
 * - `idle`: کار نمی‌کند (هرگز شروع نشده یا `stop` شده).
 * - `starting`: پیش‌بازرسی در جریان است (هنوز حلقه شروع نشده).
 * - `running`: حلقه فعال است.
 * - `stopping`: `stop()` منتظر پایانِ گذرِ جاری است.
 */
export type RuntimeState = "idle" | "starting" | "running" | "stopping";

/**
 * کدِ بستهٔ شکستِ پیش‌بازرسی (هرگز پیام/رشتهٔ اتصال):
 * - `NOT_MIGRATED`: مهاجرتِ معلق یا شِما/جدول نیست (راه‌حل: `migrate()` صریح؛ `start` هرگز خودش مهاجرت نمی‌کند).
 * - `SCHEMA_MISMATCH`: مهاجرتِ اعمال‌شده با کد نمی‌خواند، پایگاه جدیدتر است یا دادهٔ خراب.
 * - `UNAVAILABLE`: پایگاه در دسترس نیست، پیش‌بازرسی پرتاب کرد، شکلِ نتیجه نامعتبر بود یا مهلت گذشت.
 */
export type PreflightCode = "NOT_MIGRATED" | "SCHEMA_MISMATCH" | "UNAVAILABLE";
export type PreflightResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: PreflightCode }>;

export type StartFailureReason =
  | "ALREADY_RUNNING"
  | "STARTING"
  | "STOPPING"
  | "PREFLIGHT_FAILED"
  | "CLOCK_INVALID"
  | "STOPPED_DURING_START"
  | "PREVIOUS_RUN_ACTIVE"
  | "SCHEDULE_FAILED";

/** `atMs` = ساعتِ آغاز (مرجعِ `sinceMs` ارزیاب). `code` فقط برای `PREFLIGHT_FAILED` غیرتهی است. */
export type RuntimeStartResult = Readonly<{ started: true; atMs: number }> | Readonly<{ started: false; reason: StartFailureReason; code: PreflightCode | null }>;

export type RuntimeHealth = Readonly<{
  health: SweepHealth;
  /** `down` ⇒ ۵۰۳؛ `ok`/`degraded` ⇒ ۲۰۰ (ADR-0030 تصمیم ۳). */
  httpStatus: 200 | 503;
}>;

export type RuntimeStatus = Readonly<{
  state: RuntimeState;
  /** ساعتِ آخرین `start` موفق؛ پیش از آن `null`. */
  startedAtMs: number | null;
  loop: SweepLoopStatus;
}>;

export type RuntimePorts = Readonly<{ ledger: Ledger; outbox: SettlementOutbox & DueClaimer }>;

/**
 * همه‌چیز را یک‌جا می‌بندد؛ هیچ متدی نمی‌پرتابد.
 * `ports`: دفتر و outboxِ **همین** اجرا؛ مسیرِ درخواست (`createDurableLedger`) باید با همین‌ها ساخته شود تا outbox یکی باشد.
 */
export type SettlementRuntime = Readonly<{
  start(): Promise<RuntimeStartResult>;
  stop(): Promise<LoopStopResult>;
  /** همگام و بدون I/O: از وضعیتِ حلقه و ساعت ارزیابی می‌کند (پروبِ سلامت را کُند نمی‌کند). پیش از `start` = `down` (پروبِ راه‌اندازی). */
  health(): RuntimeHealth;
  status(): RuntimeStatus;
  ports: RuntimePorts;
}>;

/** زنگِ ماندگار: صریحاً `false` (فقط درون‌حافظه‌ای؛ آگاهانه) یا تحویل‌دهنده؛ نبودنِ مقدار ⇒ `INVALID_CONFIG` (شکستِ بسته). */
export type RuntimeDeadLetters =
  | false
  | Readonly<{
      deliver(letter: DeadLetter): unknown;
      batchLimit?: number;
      maxBatchesPerRun?: number;
      deliverTimeoutMs?: number;
    }>;

/** تنظیماتِ مشترکِ هر دو سازنده. ورودی `unknown` است و روی مرز اعتبارسنجی می‌شود؛ این نوع فقط مستند است. */
export type RuntimeTuning = Readonly<{
  /** همان `graceMs` ی که به `createDurableLedger` می‌دهید (الزامی). */
  graceMs: number;
  /** پیش‌فرض `max(1, ⌊graceMs/4⌋)` (توصیهٔ ADR-0030: گذرِ کُند ارزیاب را `degraded` نکند). */
  intervalMs?: number;
  maxBackoffMs?: number;
  maxDrainRuns?: number;
  stopTimeoutMs?: number;
  /** اجارهٔ رفتگر؛ پیش‌فرض `min(graceMs, سقف)` (همیشه روشن: چندنمونه‌ایِ ایمن، ADR-0029). */
  leaseMs?: number;
  limit?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  deadLetters: RuntimeDeadLetters;
  observer?: SweepObserver;
  health?: Readonly<{ degradedAfterMs?: number; downAfterMs?: number }>;
  /** مهلتِ پیش‌بازرسیِ `start` (۱…۳۰۰٬۰۰۰). پیش‌فرض ۱۵٬۰۰۰؛ پایگاهِ آویزان `start` را برای همیشه معلق نمی‌گذارد. */
  startTimeoutMs?: number;
}>;

export type SettlementRuntimeConfig = RuntimeTuning &
  Readonly<{
    ledger: Ledger;
    outbox: SettlementOutbox & DueClaimer;
    clock: Clock;
    timer: LoopTimer;
    /** اختیاری؛ پیش از هر `start` اجرا می‌شود. `{ok:false}`، پرتاب، ردّ، شکلِ نامعتبر یا مهلت ⇒ حلقه شروع نمی‌شود. */
    preflight?: () => PreflightResult | Promise<PreflightResult>;
  }>;

export type PgSettlementRuntimeConfig = RuntimeTuning &
  Readonly<{
    /** پایگاه drizzle برنامه (ماژول هرگز اتصال نمی‌سازد و استخر را نمی‌بندد). */
    db: LedgerDatabase;
    ledgerSchema?: string;
    settlementSchema?: string;
    clock?: Clock;
    timer?: LoopTimer;
  }>;

export type RuntimeMigrateResult =
  | Readonly<{ ok: true; applied: Readonly<{ ledger: readonly string[]; settlement: readonly string[] }> }>
  | Readonly<{ ok: false; stage: "ledger" | "settlement"; code: PgStoreErrorCode }>;

export type PgSettlementRuntime = SettlementRuntime &
  Readonly<{
    /** مهاجرتِ صریح (دفتر، سپس outbox)؛ idempotent. `start` هرگز خودش مهاجرت نمی‌کند (ADR-0022). */
    migrate(): Promise<RuntimeMigrateResult>;
  }>;

export type NodeTimerOptions = Readonly<{
  /** پیش‌فرض `true`: رفتگرِ پس‌زمینه دلیلِ زنده‌ماندنِ فرایند نیست. کارگرِ مستقل که فقط همین را دارد `false` بدهد. */
  unref?: boolean;
}>;
