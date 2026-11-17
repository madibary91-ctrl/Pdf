/**
 * تصمیمِ گامِ بعد پس از یک تلاشِ ناموفق: تلاش دوباره (با انتظار)، رفتن به مدل جایگزین، یا ایستادن. خالص و بی‌I/O؛
 * تمام «سیاست» اینجا و مستقل‌آزمودنی است (ADR-0015 §۳ تا §۶). ترتیب بررسی‌ها عمدی است و در تست‌ها قفل شده.
 */
import { computeBackoff } from "./backoff";
import type { GatewayErrorCode } from "./types";
import type { ResolvedPolicy, StopReason } from "./resilience-types";

export type Decision =
  | Readonly<{ kind: "retry"; waitMs: number }>
  | Readonly<{ kind: "next_model" }>
  | Readonly<{ kind: "stop"; reason: StopReason }>;

export type DecisionInput = Readonly<{
  code: GatewayErrorCode;
  /** برچسب هسته؛ تلاش دوباره فقط با «`retryOn` و `retryable`» هر دو. */
  retryable: boolean;
  retryAfterMs: number | null;
  /** جایگاه مدلِ جاری در زنجیره (۰ = اصلی) و طول زنجیره (اصلی + جایگزین‌ها). */
  position: number;
  chainLength: number;
  /** شمارهٔ تلاشِ همین مدل که همین حالا تمام شد (از ۱). */
  modelAttempt: number;
  /** شمار فراخوانی‌های رسیده به ارائه‌دهنده تا اکنون (همین تلاش هم اگر رسید). */
  callsMade: number;
  /** زمان باقی‌مانده تا مهلت کل، پس از پایان همین تلاش. */
  remainingMs: number;
  policy: ResolvedPolicy;
  /** `[0,1]` برای jitter؛ فقط وقتی لازم شود صدا زده می‌شود (تصادف بی‌دلیل مصرف نمی‌شود). */
  jitterUnit: () => number;
}>;

/** خطاهایی که هرگز تلاش/جایگزین ندارند (خطای ورودی/پیکربندی/داخلی؛ تکرارش بی‌معنا یا خطرناک است). */
const NEVER_RETRIED: ReadonlySet<GatewayErrorCode> = new Set<GatewayErrorCode>(["INVALID_REQUEST", "UNKNOWN_MODEL", "INVALID_CONFIG", "INTERNAL_ERROR"]);

const stop = (reason: StopReason): Decision => ({ kind: "stop", reason });

/** انتظارِ پیش از تلاش دوباره، یا `null` اگر ارائه‌دهنده بیش از `maxDelayMs` خواسته (نباید زودتر برویم). */
function waitBeforeRetry(i: DecisionInput): number | null {
  const p = i.policy;
  if (i.retryAfterMs !== null && i.retryAfterMs > p.maxDelayMs) return null;
  const backoff = computeBackoff({
    retryNumber: i.modelAttempt,
    baseDelayMs: p.baseDelayMs,
    maxDelayMs: p.maxDelayMs,
    jitter: p.jitter,
    unit: p.jitter === "none" ? 1 : i.jitterUnit(),
  });
  return i.retryAfterMs === null ? backoff : Math.max(backoff, i.retryAfterMs);
}

export function decideNext(i: DecisionInput): Decision {
  const p = i.policy;
  const hasNext = i.position + 1 < i.chainLength;

  if (i.code === "ABORTED") return stop("aborted");
  // درخواستی که برای مدل جایگزین نامعتبر است (سقف کوچک‌تر) بی‌هزینه رد می‌شود؛ هرگز کوتاه نمی‌شود.
  if (i.code === "INVALID_REQUEST" && i.position > 0) return hasNext ? { kind: "next_model" } : stop("chain_exhausted");
  if (NEVER_RETRIED.has(i.code)) return stop("non_retryable");

  if (i.callsMade >= p.maxTotalAttempts) return stop("budget_exhausted");

  const retryEligible = p.retryOn.has(i.code) && i.retryable;
  let blockedByTime = false;
  let retryAfterTooLong = false;
  if (retryEligible && i.modelAttempt < p.maxAttemptsPerModel) {
    const wait = waitBeforeRetry(i);
    if (wait === null) retryAfterTooLong = true;
    // انتظار + دست‌کم یک میلی‌ثانیه برای خودِ تلاش باید در زمان باقی‌مانده جا شود.
    else if (wait + 1 <= i.remainingMs) return { kind: "retry", waitMs: wait };
    else blockedByTime = true;
  }

  if (hasNext && p.fallbackOn.has(i.code)) return { kind: "next_model" };

  if (blockedByTime) return stop("deadline");
  if (retryAfterTooLong) return stop("retry_after_too_long");
  if (i.chainLength > 1 && !hasNext && p.fallbackOn.has(i.code)) return stop("chain_exhausted");
  return stop(retryEligible ? "attempts_exhausted" : "non_retryable");
}
