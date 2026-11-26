/**
 * نوع‌های «ریشهٔ I/Oِ سیاستِ ابزار» (ADR-0073، برش CT‑5c‑2c‑2b‑1).
 * این ماژول زنجیرهٔ ذخیره‌ساز ← مدیر ← منبع ← حلقه را روی یک `db` و یک `tuning` واحد می‌سازد؛ هیچ قیمت، ارز، حساب یا کلیدی ندارد.
 */
import type { PolicyClock } from "@/modules/tool-policy-admin";
import type { RefresherStatus, RefreshTimer } from "@/modules/tool-policy-refresher";
import type { SnapshotResult, SourceHealth } from "@/modules/tool-policy-source";
import type { PolicyPgDatabase } from "@/modules/tool-policy-store-pg";

/** یک عددِ واحد برای هر دو سمت: منبع `maxStaleMs`/`refreshTimeoutMs` را و حلقه همهٔ پنج را می‌گیرد (دو عددِ ناهمخوان ممکن نیست). */
export type PolicyTuning = Readonly<{
  intervalMs: number;
  retryMs: number;
  attemptDeadlineMs: number;
  refreshTimeoutMs: number;
  maxStaleMs: number;
}>;

export type PgToolPolicyRuntimeConfig = Readonly<{
  /** پایگاهِ drizzle برنامه؛ مالکِ استخر برنامه است (این ماژول اتصال نمی‌سازد و نمی‌بندد). */
  db: PolicyPgDatabase;
  /** پیش‌فرض `tool_policy`؛ باید از پیش و با نقشِ مهاجرتِ جدا ساخته و مهاجرت‌شده باشد. */
  schema?: string;
  /** پیش‌فرض `min(۵۰۰۰, refreshTimeoutMs)`؛ صریح باشد باید `≤ refreshTimeoutMs` باشد. */
  statementTimeoutMs?: number;
  tuning: PolicyTuning;
  /** ساعتِ **یکنوا** برای سنِ تأیید (پیش‌فرض: `createMonotonicClock()`). */
  clock?: PolicyClock;
  /** ساعتِ دیواری فقط برای مهرِ زمانیِ نوشتنِ مدیر (این ریشه نمی‌نویسد؛ پیش‌فرض ساعتِ سیستم). */
  wallClock?: PolicyClock;
  /** پیش‌فرض `createNodeTimer()` (unref). */
  timer?: RefreshTimer;
}>;

export type RuntimeConfigError = Readonly<{ code: "INVALID_CONFIG"; message: string; issues: readonly string[] }>;
export type RuntimeResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: RuntimeConfigError }>;

export type PreflightCode = "NOT_MIGRATED" | "SCHEMA_MISMATCH" | "UNAVAILABLE";
export type PreflightResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: PreflightCode }>;

/** پورت‌های ریشهٔ عمومی (برای آزمون با ساختگی و برای ترکیبِ غیرِ PG). همه ورودیِ ناشناخته‌اند و پیش از ساخت سنجیده می‌شوند. */
export type ToolPolicyRuntimePorts = Readonly<{
  /** فقط‌خواندنی؛ هرگز مهاجرت نمی‌کند (ADR-0022/ADR-0071 «الف»). */
  preflight: () => Promise<PreflightResult>;
  source: Readonly<{ snapshot(): SnapshotResult; health(): SourceHealth }>;
  refresher: Readonly<{ start(): unknown; stop(): Promise<unknown>; status(): RefresherStatus }>;
  timer: RefreshTimer;
  /** سقفِ انتظار برای پیش‌بازرسی (همان `attemptDeadlineMs`). */
  preflightDeadlineMs: number;
}>;

export type RuntimeState = "IDLE" | "STARTING" | "RUNNING" | "STOPPING" | "STOPPED";

export type StartFailureReason = "ALREADY_STARTED" | "STOPPING" | "STOPPED_DURING_START" | PreflightCode | "SCHEDULE_FAILED";
export type RuntimeStartResult = Readonly<{ started: true }> | Readonly<{ started: false; reason: StartFailureReason }>;
export type RuntimeStopResult = Readonly<{ stopped: true; abandonedInFlight: boolean }>;

/** دلیلِ «آماده نیست»؛ `null` فقط وقتی همه‌چیز سالم است. */
export type NotReadyReason = "NOT_STARTED" | "STARTING" | "STOPPING" | "NOT_LOADED" | "STALE" | "CLOCK_INVALID" | "REFRESHER_HALTED" | "HEALTH_UNAVAILABLE";

/** فقط کدهای ثابت و عدد؛ هرگز متنِ خطا، رشتهٔ اتصال یا محتوای سیاست. */
export type RuntimeHealth = Readonly<{
  state: RuntimeState;
  ready: boolean;
  reason: NotReadyReason | null;
  source: SourceHealth | null;
  refresher: RefresherStatus | null;
}>;

export interface ToolPolicyRuntime {
  /** پیش‌بازرسیِ فقط‌خواندنی، سپس آغازِ حلقه. نخستین تازه‌سازی را منتظر نمی‌ماند (آمادگی از `health().ready`). هرگز نمی‌پرتابد. */
  start(): Promise<RuntimeStartResult>;
  /** حلقه را مرتب و محدود به مهلت می‌بندد؛ هم‌زمان‌ها یک وعده را شریک‌اند؛ idempotent. هرگز نمی‌پرتابد. */
  stop(): Promise<RuntimeStopResult>;
  /** مسیرِ داغِ همگام: همان `source.snapshot()`؛ نسخهٔ کهنه‌تر از `maxStaleMs` هرگز داده نمی‌شود (پس از `stop` هم خودبه‌خود بسته می‌شود). هرگز نمی‌پرتابد. */
  snapshot(): SnapshotResult;
  /** همگام و بی‌I/O؛ برای پروبِ آمادگی. هرگز نمی‌پرتابد. */
  health(): RuntimeHealth;
}

export type PgToolPolicyRuntime = ToolPolicyRuntime;
