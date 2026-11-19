/**
 * settlement-backlog — نوع‌ها (ADR-0039، م۳‑ه‑۴‑الف‑۱).
 *
 * این ماژول **پسماندِ زنگِ ماندگار** را می‌سنجد: مرده‌هایی (`dead`) که هنوز تأیید رسیدگی نشده‌اند. `SweepLoopStatus` فقط شمارنده دارد و
 * «چند مرده مانده و قدیمی‌ترینشان چند وقت است منتظر است» را نمی‌گوید (محدودیتِ ADR-0030). هیچ‌یک از قراردادهای `settlement` عوض نمی‌شود.
 * هیچ نتیجه‌ای متنِ خام، شناسه یا مبلغ ندارد؛ فقط عدد و کدِ شمارشی.
 */
import type { DeadReason, HealthStatus, LoopTimer, OutboxEntry, OutboxResult } from "@/modules/settlement";

/** ساعتِ تزریقی؛ ماژول هرگز `Date` را مستقیم نمی‌خواند. */
export type BacklogClock = Readonly<{ nowMs(): number }>;

/** کوچک‌ترین بخشی از outbox که پایش لازم دارد (فقط‌خواندنی؛ پایش هرگز چیزی را تأیید یا ثبت نمی‌کند). */
export type BacklogOutbox = Readonly<{
  listUnacknowledgedDead(query: Readonly<{ limit: number }>): Promise<OutboxResult<readonly OutboxEntry[]>>;
}>;

/**
 * همهٔ آستانه‌ها **الزامی‌اند** (قاعدهٔ ۹ AGENTS.md: حدس نزنید): سیاستِ «چند مرده/چه مدت قابل‌تحمل است» تصمیمِ عملیاتیِ مالک است نه پیش‌فرضِ کد.
 * - `degradedCount ≤ downCount ≤ sampleLimit` (شمار؛ ≥ ۱): شمارِ مرده‌های تأییدنشده. آستانه‌ها با `≥` سنجیده می‌شوند.
 * - `degradedAfterMs ≤ downAfterMs` (≥ ۱): سنِ قدیمی‌ترین مرده. آستانه‌ها با `>` (اکیداً بیشتر) سنجیده می‌شوند، مثلِ `health.ts`.
 * - `sampleMaxAgeMs`: نمونه‌ای که قدیمی‌تر از این باشد دیگر به آن اعتماد نمی‌شود (`SAMPLE_STALE`).
 * - `sampleLimit` (۱…۱۰۰۰، پیش‌فرض ۱۰۰۰): سقفِ خواندن؛ چون `downCount ≤ sampleLimit`، بریدنِ فهرست هرگز آستانه‌ای را پنهان نمی‌کند.
 * - `timer` و `timeoutMs` (۱…۳٬۶۰۰٬۰۰۰؛ پیش‌فرض ۵۰۰۰ فقط با `timer`): مهلتِ خواندن؛ بی‌`timer` مهلتی نیست و `timeoutMs` رد می‌شود.
 */
export type BacklogMonitorConfig = Readonly<{
  outbox: BacklogOutbox;
  clock: BacklogClock;
  degradedCount: number;
  downCount: number;
  degradedAfterMs: number;
  downAfterMs: number;
  sampleMaxAgeMs: number;
  sampleLimit?: number;
  timer?: LoopTimer;
  timeoutMs?: number;
}>;

/**
 * چرایی ناموفق‌بودنِ نمونه‌گیری (کدِ بسته؛ هرگز پیامِ پورت):
 * - `CLOCK_INVALID`: ساعت پرتاب کرد یا مقدارِ نامعتبر داد. `LIST_FAILED`: outbox خطا داد، پرتاب یا رد کرد.
 * - `BAD_LIST`: پاسخ شکلِ قرارداد را نداشت (غیرِ آرایه، بیش از سقف، رکوردِ غیرِ‌مرده/تکراری/ناقص).
 * - `TIMEOUT`: مهلتِ خواندن تمام شد.
 */
export type BacklogSampleFailure = "CLOCK_INVALID" | "LIST_FAILED" | "BAD_LIST" | "TIMEOUT";

export type BacklogByReason = Readonly<Record<DeadReason, number>>;

/**
 * عکسِ پسماند در یک لحظه (منجمد و JSON‌پذیر؛ ریشهٔ ترکیب می‌تواند آن را نگه دارد و بعداً `evaluate` کند).
 * - `count`: شمارِ مرده‌های تأییدنشده در فهرستِ خوانده‌شده؛ اگر `truncated` باشد **حداقل** این‌قدر (فهرست به سقف رسید).
 * - `oldestDeadAtMs`: قدیمی‌ترین زمانِ مرگ (کمینهٔ `settledAtMs`)؛ `null` اگر هیچ رکوردِ تاریخ‌دار نیست. به ترتیبِ فهرست تکیه نمی‌شود (کمینه می‌گیرد).
 * - `undated`: رکوردهای مرده‌ای که outbox زمانِ مرگ نداده (سنشان قابل‌سنجش نیست).
 */
export type BacklogSample =
  | Readonly<{
      ok: true;
      atMs: number;
      count: number;
      truncated: boolean;
      oldestDeadAtMs: number | null;
      undated: number;
      byReason: BacklogByReason;
    }>
  | Readonly<{ ok: false; atMs: number | null; code: BacklogSampleFailure }>;

/**
 * کدهای دلیل (فقط شمارشی):
 * - `INPUT_INVALID` (down): ورودیِ `evaluate` یا نمونه شکلِ معتبر ندارد/ناسازگار است، یا `nowMs` نامعتبر است (شکستِ بسته).
 * - `SAMPLE_UNREADABLE` (degraded): پسماند خوانده نشد؛ دلیل در `failure`. «نمی‌دانم» هرگز `ok` نیست، ولی ۵۰۳ هم نمی‌سازد (ریستارت خواندنِ outbox را درست نمی‌کند).
 * - `SAMPLE_STALE` (degraded): نمونه از `sampleMaxAgeMs` قدیمی‌تر است. `CLOCK_BEHIND` (degraded): ساعتِ سنجش پیش از نمونه/مرگ است (سن منفی).
 * - `COUNT_HIGH` (degraded) / `COUNT_CRITICAL` (down): شمارِ تأییدنشده‌ها به آستانه رسید.
 * - `OLDEST_AGED` (degraded) / `OLDEST_STUCK` (down): قدیمی‌ترین مرده از آستانهٔ سن گذشت.
 * - `AGE_UNKNOWN` (degraded): دست‌کم یک مردهٔ بی‌زمانِ مرگ هست.
 */
export type BacklogReasonCode =
  | "INPUT_INVALID"
  | "SAMPLE_UNREADABLE"
  | "SAMPLE_STALE"
  | "CLOCK_BEHIND"
  | "COUNT_HIGH"
  | "COUNT_CRITICAL"
  | "OLDEST_AGED"
  | "OLDEST_STUCK"
  | "AGE_UNKNOWN";

export type BacklogReason = Readonly<{ code: BacklogReasonCode; severity: "degraded" | "down" }>;

export type BacklogThresholds = Readonly<{
  degradedCount: number;
  downCount: number;
  degradedAfterMs: number;
  downAfterMs: number;
  sampleMaxAgeMs: number;
}>;

/** نتیجهٔ ارزیابی. وضعیت از همان واژگانِ `HealthStatus` ی settlement است تا ترکیب با `SweepHealth` سرراست باشد (برش بعد). */
export type BacklogHealth = Readonly<{
  status: HealthStatus;
  /** خطرناک‌ترین‌ها اول؛ ترتیبِ قاعده‌ها در هر سطح پایدار. */
  reasons: readonly BacklogReason[];
  count: number | null;
  truncated: boolean | null;
  /** سنِ قدیمی‌ترین مرده در لحظهٔ `nowMs`؛ `null` اگر نمونه ناخوانا/ناسازگار، بی‌رکوردِ تاریخ‌دار یا ساعت عقب است. */
  oldestAgeMs: number | null;
  /** سنِ خودِ نمونه در لحظهٔ `nowMs`؛ `null` اگر ناخوانا/ناسازگار یا ساعت عقب است. */
  sampleAgeMs: number | null;
  byReason: BacklogByReason | null;
  /** فقط وقتی نمونه ناموفق بود. */
  failure: BacklogSampleFailure | null;
  thresholds: BacklogThresholds;
}>;

/** `sample` هرگز نمی‌پرتابد و هیچ‌چیز را تأیید/ثبت نمی‌کند؛ `evaluate` خالص و بی‌پرتاب است؛ `check` = `sample` سپس `evaluate` با ساعتِ همان لحظه. */
export type BacklogMonitor = Readonly<{
  sample(): Promise<BacklogSample>;
  evaluate(input: unknown): BacklogHealth;
  check(): Promise<BacklogHealth>;
}>;

export type BacklogConfigError = Readonly<{ code: "INVALID_CONFIG"; message: string; issues: readonly string[] }>;
export type BacklogResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: BacklogConfigError }>;
