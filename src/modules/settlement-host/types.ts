/**
 * settlement-host — نوع‌های عمومی (ADR-0032، م۳‑ه‑۳‑الف). این ماژول فقط **چرخهٔ عمرِ فرایندیِ** یک `SettlementRuntime` را می‌گرداند؛
 * سیاستِ پول/سلامت در `settlement` و ترکیبِ آن‌ها در `settlement-runtime` است و این‌جا بازتعریف نمی‌شود.
 */
import type { RuntimeHealth, RuntimeStartResult } from "@/modules/settlement-runtime";

/** پیام‌ها فقط نامِ فیلد/کدِ بسته‌اند، هرگز مقدار (حتی اگر رشتهٔ اتصال/کلید در فیلدِ اشتباه باشد). */
export type HostErrorCode = "INVALID_CONFIG" | "INVALID_STORE" | "CREATE_FAILED";
export type HostError = Readonly<{ code: HostErrorCode; message: string; issues: readonly string[] }>;
export type HostResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: HostError }>;

/**
 * - `idle`: هرگز بوت نشده.
 * - `booting`: `runtime.start()` یا انتظارِ بازتلاش در جریان است.
 * - `running`: رفتگر فعال است.
 * - `failed`: بوتِ نهایی شکست خورد (سیگنال‌ها می‌مانند؛ `boot()` دوباره ممکن است).
 * - `stopping`: خاموشی آغاز شده (ready ⇒ ۵۰۳).
 * - `stopped`: پایانیِ همیشگی؛ این میزبان دیگر بوت نمی‌شود.
 */
export type HostState = "idle" | "booting" | "running" | "failed" | "stopping" | "stopped";

export type HostSignal = "SIGTERM" | "SIGINT";
export type ShutdownReason = "MANUAL" | HostSignal;

/** پورتِ حداقلیِ ریشهٔ ترکیب (`SettlementRuntime` همین را برآورده می‌کند). خروجی‌هایش ناقابل‌اعتماد فرض می‌شوند. */
export type RuntimePort = Readonly<{
  start(): Promise<RuntimeStartResult>;
  stop(): Promise<Readonly<{ clean: boolean }>>;
  health(): RuntimeHealth;
}>;

/** همان شکلِ `LoopTimer` (ساختاری؛ وابستگیِ نوعیِ اضافه به `settlement` نمی‌سازد). */
export type HostTimer = Readonly<{ after(fn: () => void, ms: number): unknown; cancel(handle: unknown): void }>;

/** `process` در Node این را برآورده می‌کند؛ آزمون با `EventEmitter` ساختگی. */
export type SignalSource = Readonly<{
  on(signal: HostSignal, listener: () => void): unknown;
  off(signal: HostSignal, listener: () => void): unknown;
}>;

export type BootFailureReason = "ALREADY_RUNNING" | "STARTING" | "STOPPING" | "PREFLIGHT_FAILED" | "CLOCK_INVALID" | "STOPPED_DURING_START" | "PREVIOUS_RUN_ACTIVE" | "SCHEDULE_FAILED" | "SIGNALS_UNAVAILABLE" | "SHUTTING_DOWN" | "RUNTIME_INVALID";
export type BootFailureCode = "NOT_MIGRATED" | "SCHEMA_MISMATCH" | "UNAVAILABLE";

export type HostBootResult =
  | Readonly<{ booted: true; atMs: number; attempts: number }>
  | Readonly<{ booted: false; reason: BootFailureReason; code: BootFailureCode | null; attempts: number }>;

/** `none`: `closeResources` تنظیم نشده · `skipped`: توقف تمیز نبود پس صدا زده نشد · `failed`: پرتاب شد یا در مهلت تمام نشد. */
export type ClosedState = "none" | "ok" | "skipped" | "failed";

export type ShutdownResult = Readonly<{
  /** `clean ∧ ¬timedOut ∧ closed∈{none,ok}` */
  ok: boolean;
  /** توقفِ رفتگر تمیز بود (گذرِ آویزان نماند). */
  clean: boolean;
  timedOut: boolean;
  closed: ClosedState;
  reason: ShutdownReason;
}>;

export type HostEvent =
  | Readonly<{ type: "boot.attempt_failed"; attempt: number; reason: BootFailureReason; code: BootFailureCode | null; willRetry: boolean }>
  | Readonly<{ type: "booted"; attempts: number; atMs: number }>
  | Readonly<{ type: "boot.failed"; attempts: number; reason: BootFailureReason; code: BootFailureCode | null }>
  | Readonly<{ type: "shutdown.started"; reason: ShutdownReason }>
  | Readonly<{ type: "shutdown.finished"; reason: ShutdownReason; ok: boolean; clean: boolean; timedOut: boolean; closed: ClosedState }>;

export type HostStatus = Readonly<{
  state: HostState;
  /** تعدادِ تلاش‌های بوتِ آخرین دنباله. */
  bootAttempts: number;
  /** حداقل یک بارِ موفق (چسبنده). */
  hasBooted: boolean;
  lastBootFailure: Readonly<{ reason: BootFailureReason; code: BootFailureCode | null }> | null;
  shutdownReason: ShutdownReason | null;
}>;

export type ProbeKind = "live" | "startup" | "ready";
export type ProbeSweep = "ok" | "degraded" | "down";

/** بدنهٔ بسته: فقط وضعیت/کد؛ هرگز پیام خطا، مقدار یا شمارنده‌ای از دادهٔ کاربر. `absent`: میزبانی در این فرایند ساخته نشده. */
export type ProbeResult = Readonly<{
  httpStatus: 200 | 503;
  body: Readonly<{ probe: ProbeKind; ok: boolean; state: HostState | "absent"; sweep: ProbeSweep | null }>;
}>;

export type SettlementHost = Readonly<{
  /** idempotent و هم‌زمان‌ایمن؛ هرگز نمی‌پرتابد. */
  boot(): Promise<HostBootResult>;
  /** یک وعدهٔ مشترک؛ هرگز نمی‌پرتابد. */
  shutdown(): Promise<ShutdownResult>;
  status(): HostStatus;
  probes: Readonly<{ live(): ProbeResult; startup(): ProbeResult; ready(): ProbeResult }>;
}>;

export type HostBootRetry = Readonly<{
  /** ۱…۱۰؛ پیش‌فرض ۱ (بی‌بازتلاش). فقط `PREFLIGHT_FAILED/UNAVAILABLE` بازتلاش می‌شود. */
  maxAttempts?: number;
  /** ۱…۶۰٬۰۰۰؛ پیش‌فرض ۱۰۰۰. */
  delayMs?: number;
}>;

/** ورودی `unknown` است و روی مرز اعتبارسنجی می‌شود؛ این نوع فقط مستند است. */
export type SettlementHostConfig = Readonly<{
  runtime: RuntimePort;
  timer: HostTimer;
  /** الزامی: `false` (آگاهانه؛ مالک خودش `shutdown()` صدا می‌زند) یا منبعِ سیگنال. */
  signals: SignalSource | false;
  /** پس از خاموشیِ سیگنالی با `ok ? 0 : 1` صدا زده می‌شود (مثلاً `createNodeExit()`). */
  exit?: (code: number) => void;
  /** مثلاً بستنِ استخر؛ فقط پس از توقفِ تمیز و درونِ مهلت. */
  closeResources?: () => unknown;
  /** ۱…۳۰۰٬۰۰۰؛ پیش‌فرض ۱۵٬۰۰۰. سقفِ کلِ خاموشی. */
  shutdownTimeoutMs?: number;
  bootRetry?: HostBootRetry;
  observer?: (event: HostEvent) => unknown;
}>;

export type HostStore = Readonly<Record<symbol, unknown>>;

export type AcquireResult =
  | Readonly<{ ok: true; value: SettlementHost; created: boolean }>
  | Readonly<{ ok: false; error: HostError }>;

export type NodeProcessLike = Readonly<{
  on(signal: string, listener: () => void): unknown;
  off(signal: string, listener: () => void): unknown;
  exit(code?: number): unknown;
}>;
