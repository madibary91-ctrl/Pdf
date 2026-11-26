/**
 * tool-policy-host — نوع‌های عمومی (ADR-0075، برش CT‑5c‑2c‑2b‑3). این ماژول فقط **چرخهٔ عمرِ فرایندیِ** یک `ToolPolicyRuntime` را می‌گرداند؛
 * سیاستِ پول/تازه‌سازی در `tool-policy-*` و ترکیبشان در `tool-policy-runtime` است و این‌جا بازتعریف نمی‌شود.
 * نوع‌های خنثای فرایندی (سیگنال، زمان‌سنج، دلیل/وضعیتِ خاموشی) از رابط عمومیِ `settlement-host` گرفته می‌شود (ADR-0075 بند ۲).
 */
import type { ClosedState, HostSignal, HostTimer, ShutdownReason, SignalSource } from "@/modules/settlement-host";
import type { NotReadyReason } from "@/modules/tool-policy-runtime";

export type { ClosedState, HostSignal, HostTimer, ShutdownReason, SignalSource, NotReadyReason };

/** پیام‌ها فقط نامِ فیلد/کدِ بسته‌اند، هرگز مقدار (حتی اگر رشتهٔ اتصال/کلید در فیلدِ اشتباه باشد). */
export type HostErrorCode = "INVALID_CONFIG" | "INVALID_STORE" | "CREATE_FAILED";
export type HostError = Readonly<{ code: HostErrorCode; message: string; issues: readonly string[] }>;
export type HostResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: HostError }>;

/**
 * - `idle`: هرگز بوت نشده.
 * - `booting`: `runtime.start()` یا انتظارِ بازتلاش در جریان است.
 * - `running`: `runtime.start()` موفق بود (حلقه روشن است؛ **آماده‌بودن** جداست و فقط از پروبِ `ready` خوانده می‌شود).
 * - `failed`: بوتِ نهایی شکست خورد (سیگنال‌ها می‌مانند؛ `boot()` دوباره ممکن است).
 * - `stopping`: خاموشی آغاز شده (ready ⇒ ۵۰۳).
 * - `stopped`: پایانیِ همیشگی؛ این میزبان دیگر بوت نمی‌شود.
 */
export type HostState = "idle" | "booting" | "running" | "failed" | "stopping" | "stopped";

/** کدهای شکستِ `runtime.start()` (همان `StartFailureReason` ریشه) که میزبان از ریشه عیناً می‌گیرد. */
export type RuntimeFailureReason = "ALREADY_STARTED" | "STOPPING" | "STOPPED_DURING_START" | "NOT_MIGRATED" | "SCHEMA_MISMATCH" | "UNAVAILABLE" | "SCHEDULE_FAILED";
export type BootFailureReason = RuntimeFailureReason | "RUNTIME_INVALID" | "SIGNALS_UNAVAILABLE" | "SHUTTING_DOWN";

/** پورتِ حداقلیِ ریشه (`ToolPolicyRuntime` همین را برآورده می‌کند). خروجی‌هایش ناقابل‌اعتماد فرض می‌شوند. */
export type RuntimePort = Readonly<{
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  health(): unknown;
}>;

export type HostBootResult = Readonly<{ booted: true; attempts: number }> | Readonly<{ booted: false; reason: BootFailureReason; attempts: number }>;

export type ShutdownResult = Readonly<{
  /** `clean ∧ ¬timedOut ∧ closed∈{none,ok}` */
  ok: boolean;
  /** توقفِ ریشه تمیز بود: `stopped === true` و تلاشِ در جریانی رها (abandon) نشد. */
  clean: boolean;
  timedOut: boolean;
  closed: ClosedState;
  reason: ShutdownReason;
}>;

export type HostEvent =
  | Readonly<{ type: "boot.attempt_failed"; attempt: number; reason: BootFailureReason; willRetry: boolean }>
  | Readonly<{ type: "booted"; attempts: number }>
  | Readonly<{ type: "boot.failed"; attempts: number; reason: BootFailureReason }>
  | Readonly<{ type: "ready.first" }>
  | Readonly<{ type: "shutdown.started"; reason: ShutdownReason }>
  | Readonly<{ type: "shutdown.finished"; reason: ShutdownReason; ok: boolean; clean: boolean; timedOut: boolean; closed: ClosedState }>;

export type HostStatus = Readonly<{
  state: HostState;
  /** تعدادِ تلاش‌های بوتِ آخرین دنباله. */
  bootAttempts: number;
  /** `runtime.start()` دست‌کم یک بار موفق بود (چسبنده). */
  hasBooted: boolean;
  /** پروبِ آمادگی دست‌کم یک بار «آماده» دیده است (چسبنده؛ مبنای پروبِ startup). */
  hasBeenReady: boolean;
  lastBootFailure: Readonly<{ reason: BootFailureReason }> | null;
  shutdownReason: ShutdownReason | null;
}>;

export type ProbeKind = "live" | "startup" | "ready";

/**
 * بدنهٔ بسته: فقط وضعیت/کدِ ثابت؛ هرگز پیام خطا، مقدار یا محتوای سیاست. `absent`: میزبانی در این فرایند ساخته نشده.
 * `reason` فقط برای `ready` در حالتِ `running` و فقط از مجموعهٔ بستهٔ `NotReadyReason` است (`null` وقتی آماده است یا میزبان `running` نیست).
 */
export type ProbeResult = Readonly<{
  httpStatus: 200 | 503;
  body: Readonly<{ probe: ProbeKind; ok: boolean; state: HostState | "absent"; reason: NotReadyReason | null }>;
}>;

export type ToolPolicyHost = Readonly<{
  /** idempotent و هم‌زمان‌ایمن؛ هرگز نمی‌پرتابد. */
  boot(): Promise<HostBootResult>;
  /** یک وعدهٔ مشترک؛ هرگز نمی‌پرتابد. */
  shutdown(): Promise<ShutdownResult>;
  status(): HostStatus;
  probes: Readonly<{ live(): ProbeResult; startup(): ProbeResult; ready(): ProbeResult }>;
}>;

export type HostBootRetry = Readonly<{
  /** ۱…۱۰؛ پیش‌فرض ۱ (بی‌بازتلاش). فقط `UNAVAILABLE` بازتلاش می‌شود. */
  maxAttempts?: number;
  /** ۱…۶۰٬۰۰۰؛ پیش‌فرض ۱۰۰۰. */
  delayMs?: number;
}>;

/** ورودی `unknown` است و روی مرز اعتبارسنجی می‌شود؛ این نوع فقط مستند است. */
export type ToolPolicyHostConfig = Readonly<{
  runtime: RuntimePort;
  timer: HostTimer;
  /** الزامی: `false` (آگاهانه؛ مالک خودش `shutdown()` صدا می‌زند) یا منبعِ سیگنال. */
  signals: SignalSource | false;
  /** پس از خاموشیِ سیگنالی با `ok ? 0 : 1` صدا زده می‌شود. */
  exit?: (code: number) => void;
  /** مثلاً بستنِ استخر؛ فقط پس از توقفِ تمیز و درونِ مهلت. */
  closeResources?: () => unknown;
  /** ۱…۳۰۰٬۰۰۰؛ پیش‌فرض ۱۵٬۰۰۰. سقفِ کلِ خاموشی. */
  shutdownTimeoutMs?: number;
  bootRetry?: HostBootRetry;
  observer?: (event: HostEvent) => unknown;
}>;

export type HostStore = Readonly<Record<symbol, unknown>>;

export type AcquireResult = Readonly<{ ok: true; value: ToolPolicyHost; created: boolean }> | Readonly<{ ok: false; error: HostError }>;
