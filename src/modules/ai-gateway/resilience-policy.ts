/**
 * اعتبارسنجی و «انجمادِ» سیاست تاب‌آوری (ADR-0015 §۲). سیاست از JSON/محیط هم می‌آید، پس `unknown` فرض می‌شود.
 * هیچ پیش‌فرضی نیست؛ کلید ناشناخته رد؛ ناسازگاریِ بی‌اثر رد؛ همهٔ مشکل‌ها یک‌جا و فقط با نام فیلد (بدون محتوا).
 * `modelNames` اگر `null` باشد (پیکربندی هستهٔ همین فراخوانی نامعتبر است) فقط سنجشِ ارجاع به مدل‌ها رد می‌شود.
 */
import type { FallbackEligibleCode, JitterMode, RandomSource, ResolvedPolicy, RetryableCode } from "./resilience-types";

export const POLICY_LIMITS = Object.freeze({
  maxAttemptsPerModel: 10,
  maxTotalAttempts: 20,
  maxTotalTimeoutMs: 3_600_000,
  maxBaseDelayMs: 60_000,
  maxDelayMs: 600_000,
  maxFallbacksPerModel: 5,
});

/** برای نوشتنِ صریحِ `retryOn` (پیش‌فرض نیست). `PROVIDER_ERROR` عمداً نیست: ممکن است هزینه شده باشد. */
export const RETRYABLE_CODES: readonly RetryableCode[] = Object.freeze(["TIMEOUT", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE"] as const);

/** برای نوشتنِ صریحِ `fallbackOn` (پیش‌فرض نیست). */
export const FALLBACK_ELIGIBLE_CODES: readonly FallbackEligibleCode[] = Object.freeze([
  "TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_AUTH",
  "PROVIDER_REJECTED",
  "PROVIDER_BAD_RESPONSE",
  "PROVIDER_ERROR",
] as const);

const POLICY_KEYS: ReadonlySet<string> = new Set(["maxAttemptsPerModel", "maxTotalAttempts", "totalTimeoutMs", "backoff", "retryOn", "fallbackOn", "fallbacks", "random"]);
const BACKOFF_KEYS: ReadonlySet<string> = new Set(["baseDelayMs", "maxDelayMs", "jitter"]);
const JITTERS: ReadonlySet<string> = new Set(["none", "full", "equal"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const key = (k: string): string => JSON.stringify(k.slice(0, 40));

/** فهرست یکتای کدها از یک مجموعهٔ مجاز؛ مشکل‌ها به `issues` می‌روند. */
function readCodes(v: unknown, field: string, allowed: readonly string[], issues: string[]): ReadonlySet<string> {
  const out = new Set<string>();
  if (!Array.isArray(v)) {
    issues.push(`${field} باید آرایه (می‌تواند تهی باشد) از ${allowed.join("، ")} باشد.`);
    return out;
  }
  for (const c of v as unknown[]) {
    if (typeof c !== "string" || !allowed.includes(c)) issues.push(`${field}: مقدار نامجاز ${key(String(c))} (مجاز: ${allowed.join("، ")}).`);
    else if (out.has(c)) issues.push(`${field}: مقدار تکراری ${key(c)}.`);
    else out.add(c);
  }
  return out;
}

export function resolvePolicy(
  input: unknown,
  modelNames: ReadonlySet<string> | null,
): Readonly<{ ok: true; value: ResolvedPolicy }> | Readonly<{ ok: false; issues: readonly string[] }> {
  try {
    if (!isRecord(input)) return { ok: false, issues: ["policy باید شیء باشد."] };
    const issues: string[] = [];
    for (const k of Object.keys(input)) if (!POLICY_KEYS.has(k)) issues.push(`policy: کلید ناشناخته ${key(k)} (مجاز: ${[...POLICY_KEYS].join("، ")}).`);

    const maxAttemptsPerModel = input["maxAttemptsPerModel"];
    if (!isIntIn(maxAttemptsPerModel, 1, POLICY_LIMITS.maxAttemptsPerModel)) issues.push(`policy.maxAttemptsPerModel الزامی و عدد صحیح ۱ تا ${POLICY_LIMITS.maxAttemptsPerModel} است.`);
    const maxTotalAttempts = input["maxTotalAttempts"];
    if (!isIntIn(maxTotalAttempts, 1, POLICY_LIMITS.maxTotalAttempts)) issues.push(`policy.maxTotalAttempts الزامی و عدد صحیح ۱ تا ${POLICY_LIMITS.maxTotalAttempts} است.`);
    const totalTimeoutMs = input["totalTimeoutMs"];
    if (!isIntIn(totalTimeoutMs, 1, POLICY_LIMITS.maxTotalTimeoutMs)) issues.push(`policy.totalTimeoutMs الزامی و عدد صحیح ۱ تا ${POLICY_LIMITS.maxTotalTimeoutMs} است.`);

    let baseDelayMs = 0;
    let maxDelayMs = 0;
    let jitter: JitterMode = "none";
    const b = input["backoff"];
    if (!isRecord(b)) {
      issues.push("policy.backoff الزامی و باید شیء باشد.");
    } else {
      for (const k of Object.keys(b)) if (!BACKOFF_KEYS.has(k)) issues.push(`policy.backoff: کلید ناشناخته ${key(k)}.`);
      const base = b["baseDelayMs"];
      if (!isIntIn(base, 0, POLICY_LIMITS.maxBaseDelayMs)) issues.push(`policy.backoff.baseDelayMs الزامی و عدد صحیح ۰ تا ${POLICY_LIMITS.maxBaseDelayMs} است.`);
      else baseDelayMs = base;
      const max = b["maxDelayMs"];
      if (!isIntIn(max, 0, POLICY_LIMITS.maxDelayMs)) issues.push(`policy.backoff.maxDelayMs الزامی و عدد صحیح ۰ تا ${POLICY_LIMITS.maxDelayMs} است.`);
      else if (isIntIn(base, 0, POLICY_LIMITS.maxBaseDelayMs) && max < base) issues.push("policy.backoff.maxDelayMs نباید کمتر از baseDelayMs باشد.");
      else maxDelayMs = max;
      const j = b["jitter"];
      if (typeof j !== "string" || !JITTERS.has(j)) issues.push("policy.backoff.jitter الزامی و none، full یا equal است.");
      else jitter = j as JitterMode;
    }

    const retryOn = readCodes(input["retryOn"], "policy.retryOn", RETRYABLE_CODES, issues);
    const fallbackOn = readCodes(input["fallbackOn"], "policy.fallbackOn", FALLBACK_ELIGIBLE_CODES, issues);
    if (isIntIn(maxAttemptsPerModel, 2, POLICY_LIMITS.maxAttemptsPerModel) && Array.isArray(input["retryOn"]) && retryOn.size === 0) {
      issues.push("policy.retryOn نباید تهی باشد وقتی maxAttemptsPerModel بیش از ۱ است (تلاش دوباره هرگز اجرا نمی‌شد).");
    }

    const fallbacks = new Map<string, readonly string[]>();
    const rawFallbacks = input["fallbacks"];
    if (!isRecord(rawFallbacks)) {
      issues.push("policy.fallbacks الزامی و باید شیء باشد (می‌تواند تهی باشد).");
    } else {
      for (const name of Object.keys(rawFallbacks)) {
        const at = `policy.fallbacks[${key(name)}]`;
        if (modelNames !== null && !modelNames.has(name)) issues.push(`${at}: مدل اصلی در models تعریف نشده است.`);
        const chain = rawFallbacks[name];
        if (!Array.isArray(chain) || chain.length < 1 || chain.length > POLICY_LIMITS.maxFallbacksPerModel) {
          issues.push(`${at} باید آرایهٔ ۱ تا ${POLICY_LIMITS.maxFallbacksPerModel} نام مدل باشد.`);
          continue;
        }
        const seen = new Set<string>();
        for (const m of chain as unknown[]) {
          if (typeof m !== "string") issues.push(`${at}: عضو غیرمتنی.`);
          else if (m === name) issues.push(`${at}: مدل نمی‌تواند جایگزین خودش باشد.`);
          else if (seen.has(m)) issues.push(`${at}: جایگزین تکراری ${key(m)}.`);
          else {
            if (modelNames !== null && !modelNames.has(m)) issues.push(`${at}: جایگزین ${key(m)} در models تعریف نشده است.`);
            seen.add(m);
          }
        }
        fallbacks.set(name, Object.freeze([...seen]));
      }
      if (fallbacks.size > 0 && Array.isArray(input["fallbackOn"]) && fallbackOn.size === 0) {
        issues.push("policy.fallbackOn نباید تهی باشد وقتی fallbacks دارد (جایگزین هرگز اجرا نمی‌شد).");
      }
    }

    let random: RandomSource | null = null;
    const r = input["random"];
    if (r !== undefined) {
      if (!isRecord(r) || typeof r["next"] !== "function") issues.push("policy.random باید تابع next داشته باشد.");
      else random = Object.freeze({ next: (r["next"] as RandomSource["next"]).bind(r) });
    } else if (jitter !== "none" && isRecord(b) && typeof b["jitter"] === "string" && JITTERS.has(b["jitter"])) {
      issues.push("policy.random با jitter غیر از none الزامی است (هسته تصادف را خودش نمی‌سازد؛ باید تزریق شود).");
    }

    if (issues.length > 0) return { ok: false, issues };
    return {
      ok: true,
      value: Object.freeze({
        maxAttemptsPerModel: maxAttemptsPerModel as number,
        maxTotalAttempts: maxTotalAttempts as number,
        totalTimeoutMs: totalTimeoutMs as number,
        baseDelayMs,
        maxDelayMs,
        jitter,
        retryOn,
        fallbackOn,
        fallbacks,
        random,
      }),
    };
  } catch {
    return { ok: false, issues: ["policy قابل خواندن نیست."] };
  }
}
