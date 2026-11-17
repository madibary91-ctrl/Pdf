/**
 * نوع‌های برش ۲ (تاب‌آوری: تلاش دوباره و جایگزین؛ ADR-0015). هرچه `index.ts` صادر نکند داخلی است.
 * نتیجه‌ها زیرنوعِ نتیجه‌های هسته‌اند؛ پس `ResilientGateway` هر جا که `Gateway` می‌خواهند به‌کار می‌رود.
 */
import type { Completion, Cost, GatewayError, GatewayErrorCode, ModelLimits, Usage } from "./types";

/** کدهایی که تلاش دوباره روی همان مدل برایشان ممکن است (زیرمجموعهٔ کدهای `retryable` هسته). */
export type RetryableCode = "TIMEOUT" | "PROVIDER_RATE_LIMITED" | "PROVIDER_UNAVAILABLE";

/** کدهایی که می‌توانند گذار به مدل جایگزین را راه بیندازند. */
export type FallbackEligibleCode = RetryableCode | "PROVIDER_AUTH" | "PROVIDER_REJECTED" | "PROVIDER_BAD_RESPONSE" | "PROVIDER_ERROR";

export type JitterMode = "none" | "full" | "equal";

/** منبع تصادف تزریقی؛ باید عددی در `[0, 1)` بدهد. هسته به `Math.random` دست نمی‌زند. */
export type RandomSource = Readonly<{ next(): number }>;

/**
 * سیاست تاب‌آوری. **هیچ پیش‌فرضی ندارد**؛ هر میدان الزامی و صریح است (جز `random` که فقط با jitter غیر از `none` لازم است).
 * کلید ناشناخته رد می‌شود.
 */
export type ResiliencePolicy = Readonly<{
  /** ۱…۱۰؛ `1` یعنی بدون تلاش دوباره. */
  maxAttemptsPerModel: number;
  /** ۱…۲۰؛ سقف کل فراخوانی‌های رسیده به ارائه‌دهنده در یک `complete` (همهٔ مدل‌ها). */
  maxTotalAttempts: number;
  /** ۱…۳٬۶۰۰٬۰۰۰؛ سقف کل زمان یک `complete` (با ساعت تزریقی)، شامل انتظارها. */
  totalTimeoutMs: number;
  backoff: Readonly<{
    /** ۰…۶۰٬۰۰۰؛ انتظار پیش از نخستین تلاش دوباره (پیش از jitter). */
    baseDelayMs: number;
    /** `baseDelayMs`…۶۰۰٬۰۰۰؛ سقف انتظار؛ `retryAfterMs` بزرگ‌تر از آن یعنی بر همان مدل تلاش نمی‌شود. */
    maxDelayMs: number;
    jitter: JitterMode;
  }>;
  /** زیرمجموعهٔ یکتای `RETRYABLE_CODES`. با `maxAttemptsPerModel > 1` نباید تهی باشد. */
  retryOn: readonly RetryableCode[];
  /** زیرمجموعهٔ یکتای `FALLBACK_ELIGIBLE_CODES`. با `fallbacks` غیرتهی نباید تهی باشد. */
  fallbackOn: readonly FallbackEligibleCode[];
  /** مدل اصلی ← فهرست مرتب جایگزین‌ها (≤۵، یکتا، بدون خودش، همه از `models`). غیرتراگذر. */
  fallbacks: Readonly<Record<string, readonly string[]>>;
  random?: RandomSource;
}>;

export type ResolvedPolicy = Readonly<{
  maxAttemptsPerModel: number;
  maxTotalAttempts: number;
  totalTimeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: JitterMode;
  retryOn: ReadonlySet<string>;
  fallbackOn: ReadonlySet<string>;
  fallbacks: ReadonlyMap<string, readonly string[]>;
  random: RandomSource | null;
}>;

export type StopReason =
  | "success"
  /** لغوِ فراخواننده. */
  | "aborted"
  /** خطایی که نه تلاش دوباره دارد نه جایگزین (ورودی نامعتبر، احراز، داخلی، …). */
  | "non_retryable"
  /** تلاش‌های همان مدل تمام شد و جایگزینی نبود/مجاز نبود. */
  | "attempts_exhausted"
  /** همهٔ مدل‌های زنجیره امتحان شدند. */
  | "chain_exhausted"
  /** ارائه‌دهنده `retryAfterMs`ی بزرگ‌تر از `maxDelayMs` خواست؛ زودتر تلاش نکردیم (و جایگزینی نبود/مجاز نبود). */
  | "retry_after_too_long"
  /** `maxTotalAttempts` پر شد. */
  | "budget_exhausted"
  /** `totalTimeoutMs` (یا انتظارِ لازم) با زمان باقی‌مانده نمی‌خواند. */
  | "deadline";

export type AttemptRecord = Readonly<{
  /** شمارهٔ تلاش در کل فراخوانی، از ۱ (شامل تلاش‌های ردشده بر جایگزین). */
  index: number;
  model: string;
  /** شمارهٔ تلاش بر همین مدل، از ۱. */
  modelAttempt: number;
  /** انتظار backoff پیش از این تلاش؛ نخستین تلاشِ هر مدل ۰. */
  waitedMs: number;
  outcome: "ok" | GatewayErrorCode;
  /** آیا واقعاً به ارائه‌دهنده رسید؟ (`INVALID_REQUEST` بر جایگزین و لغوِ پیشین: خیر.) */
  reachedProvider: boolean;
  /** `null` = ناشناخته (نه صفر). */
  usage: Usage | null;
  cost: Cost | null;
  latencyMs: number;
}>;

/** جمع هزینهٔ همهٔ تلاش‌های دارای هزینه، به‌تفکیک ارز. `micros: null` = جمع از `2⁵³−1` گذشت (هرگز گردشده نمی‌شود). */
export type SpendEntry = Readonly<{ currency: string; micros: number | null }>;

export type ResilienceReport = Readonly<{
  /** مدلی که درخواست اصلی برایش آمد. */
  requestedModel: string | null;
  attempts: readonly AttemptRecord[];
  /** هزینهٔ **همهٔ** تلاش‌ها (نه فقط موفق). */
  spend: readonly SpendEntry[];
  /** شمار تلاش‌های رسیده به ارائه‌دهنده که هزینه‌شان نامعلوم است (مهلت، لغو، مصرف‌نداده، بی‌قیمت) — ممکن است هزینه شده باشد. */
  costUnknownAttempts: number;
  stoppedBecause: StopReason;
}>;

export type ResilientCompletion = Completion & Readonly<{ report: ResilienceReport }>;
export type ResilientError = GatewayError & Readonly<{ report: ResilienceReport }>;

export type ResilientResult = Readonly<{ ok: true; value: ResilientCompletion }> | Readonly<{ ok: false; error: ResilientError }>;

/** ساختاراً زیرنوعِ `Gateway` (هر جا `Gateway` می‌خواهند می‌نشیند): `complete` همان رابط را دارد ولی نتیجه `report` هم دارد. */
export type ResilientGateway = Readonly<{
  complete(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<ResilientResult>;
  limits(model: string): ModelLimits | null;
}>;
