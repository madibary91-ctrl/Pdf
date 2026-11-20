/**
 * settlement-backlog-watch — نوع‌های عمومی (ADR-0042، م۳‑ه‑۴‑الف‑۲‑۱).
 *
 * این ماژول **پایشِ پسماندِ زنگ را زنده نگه می‌دارد**: یک حلقهٔ پس‌زمینه نمونه می‌گیرد، آخرین نمونه را کش می‌کند و `view()` همگام و بی‌I/O
 * آن را ارزیابی می‌کند تا پروب‌ها (که همگام‌اند) بتوانند آن را گزارش کنند. هیچ قراردادی از `settlement`، `settlement-backlog`،
 * `settlement-runtime` یا `settlement-host` عوض نمی‌شود. هیچ نتیجه‌ای شناسه، مبلغ یا متنِ خام ندارد؛ فقط عدد و کدِ شمارشی.
 */
import type { LoopTimer } from "@/modules/settlement";
import type { BacklogByReason, BacklogClock, BacklogOutbox, BacklogReason, BacklogReasonCode, BacklogSampleFailure } from "@/modules/settlement-backlog";

/**
 * سیاستِ اثرِ پسماند بر `ready` (تصمیمِ مالک: «پسماند هرگز liveness را ۵۰۳ نکند و فقط در ready و startup گزارش شود»):
 * - `report` (**پیش‌فرض**): فقط گزارش؛ هیچ‌وقت کدِ HTTP را عوض نمی‌کند.
 * - `gate_down`: وضعیتِ `down`ِ پسماند، فقط `ready` را ۵۰۳ می‌کند (ترافیک را برمی‌دارد؛ فرایند ریستارت نمی‌شود).
 * `live` و `startup` در **هر دو** حالت هرگز مسدود نمی‌شوند (قفل‌شده در `projectBacklogForProbe`).
 */
export type BacklogReadyPolicy = "report" | "gate_down";

/**
 * - `idle`: هرگز `start` نشده. `running`: حلقه فعال است.
 * - `stalled`: زمان‌سنج نتوانست گذرِ بعد را بسازد؛ حلقه از کار افتاد (نمونه کهنه می‌شود و `SAMPLE_STALE` می‌دهد) و باید دوباره `start` شود.
 * - `stopped`: `stop` شده (آخرین نمونه می‌ماند و به‌مرور کهنه می‌شود).
 */
export type BacklogWatchPhase = "idle" | "running" | "stalled" | "stopped";

/** همان واژگانِ `HealthStatus` + `unknown` (هنوز هیچ نمونه‌ای نیامده). «نمی‌دانم» هرگز `ok` نیست، ولی هیچ‌چیز را هم مسدود نمی‌کند. */
export type BacklogViewStatus = "ok" | "degraded" | "down" | "unknown";

/**
 * نمای همگامِ پسماند (منجمد و JSON‌پذیر).
 * - `reasons`: خطرناک‌ترین‌ها اول؛ کدهای `BacklogReasonCode` (ADR-0039).
 * - `failure`: فقط وقتی **آخرین تلاشِ** نمونه‌گیری شکست خورد؛ دلیلش `SAMPLE_UNREADABLE` است. شکستِ گذرا آخرین نمونهٔ سالم را پاک نمی‌کند
 *   (وگرنه یک خطای لحظه‌ایِ پایگاه، یک `down` را به `degraded` تنزل می‌داد).
 */
export type BacklogView = Readonly<{
  phase: BacklogWatchPhase;
  status: BacklogViewStatus;
  reasons: readonly BacklogReason[];
  count: number | null;
  truncated: boolean | null;
  oldestAgeMs: number | null;
  sampleAgeMs: number | null;
  byReason: BacklogByReason | null;
  failure: BacklogSampleFailure | null;
  readyPolicy: BacklogReadyPolicy;
}>;

export type WatchStartResult = Readonly<{ started: true }> | Readonly<{ started: false; reason: "ALREADY_RUNNING" }>;

/** `abandonedRead`: خواندنِ در جریان رها شد (نتیجه‌اش نادیده است؛ `stop` هرگز منتظرِ پایگاه نمی‌ماند و آویزان نمی‌شود). */
export type WatchStopResult = Readonly<{ stopped: true; abandonedRead: boolean }>;

/** هیچ متدی نمی‌پرتابد. `start` همگام است و نمونهٔ اول را بی‌انتظار آغاز می‌کند. */
export type BacklogWatch = Readonly<{
  start(): WatchStartResult;
  stop(): WatchStopResult;
  /** همگام و بی‌I/O: آخرین نمونه را با ساعتِ همین لحظه ارزیابی می‌کند. */
  view(): BacklogView;
}>;

/**
 * همهٔ آستانه‌ها پیش‌فرضِ امن دارند (`SETTLEMENT_BACKLOG_WATCH_DEFAULTS`) و قابل‌تنظیم‌اند. ورودی `unknown` است و روی مرز اعتبارسنجی می‌شود؛ این نوع فقط مستند است.
 * - `sampleMaxAgeMs` پیش‌فرض: `2×intervalMs + 4×timeoutMs`؛ مقدارِ صریح باید ≥ `intervalMs + 2×timeoutMs` باشد (وگرنه پایشِ سالم هم «کهنه» گزارش می‌شود).
 */
export type BacklogWatchConfig = Readonly<{
  outbox: BacklogOutbox;
  clock: BacklogClock;
  timer: LoopTimer;
  intervalMs?: number;
  timeoutMs?: number;
  degradedCount?: number;
  downCount?: number;
  degradedAfterMs?: number;
  downAfterMs?: number;
  sampleMaxAgeMs?: number;
  sampleLimit?: number;
  readyPolicy?: BacklogReadyPolicy;
}>;

export type BacklogWatchConfigError = Readonly<{ code: "INVALID_CONFIG"; message: string; issues: readonly string[] }>;
export type WatchResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: BacklogWatchConfigError }>;

/** بخشِ گزارش‌شده در بدنهٔ پروب: فقط وضعیت، عدد و کد. */
export type BacklogProbeSection = Readonly<{
  status: BacklogViewStatus;
  count: number | null;
  truncated: boolean | null;
  oldestAgeMs: number | null;
  reasons: readonly BacklogReasonCode[];
  policy: BacklogReadyPolicy;
}>;

/**
 * `section`: چیزی که در بدنه می‌آید (`null` ⇒ اصلاً گزارش نمی‌شود). `blocks`: آیا پسماند کدِ HTTP را ۵۰۳ می‌کند.
 * ناوردا: `blocks` فقط برای `ready` با سیاستِ `gate_down` و وضعیتِ `down` درست است؛ برای `live` و `startup` همیشه `false`.
 */
export type BacklogProbeProjection = Readonly<{ section: BacklogProbeSection | null; blocks: boolean }>;

export type BacklogEnvError = Readonly<{ code: "INVALID_ENV"; message: string; issues: readonly string[] }>;
export type BacklogEnvOverrides = Readonly<Partial<Record<Exclude<keyof BacklogWatchConfig, "outbox" | "clock" | "timer">, number | BacklogReadyPolicy>>>;
export type BacklogEnvResult = Readonly<{ ok: true; value: BacklogEnvOverrides }> | Readonly<{ ok: false; error: BacklogEnvError }>;
