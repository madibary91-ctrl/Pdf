/** اعتبارسنجیِ گزینه‌های ساخت (ورودیِ ناشناخته؛ هر کلید یک بار خوانده می‌شود؛ هیچ مقداری بازتاب نمی‌شود). */
import { SOURCE_LIMITS } from "@/modules/tool-policy-source";
import type { RefreshableSource, RefreshTimer, RefresherConfigError } from "./types";

export const REFRESHER_LIMITS = Object.freeze({
  intervalMs: Object.freeze({ min: 1_000, max: 3_600_000 }),
  retryMs: Object.freeze({ min: 100, max: 3_600_000 }),
  attemptDeadlineMs: Object.freeze({ min: 100, max: 300_000 }),
  refreshTimeoutMs: SOURCE_LIMITS.refreshTimeoutMs,
  maxStaleMs: SOURCE_LIMITS.maxStaleMs,
});

const KEYS = ["source", "timer", "intervalMs", "retryMs", "attemptDeadlineMs", "refreshTimeoutMs", "maxStaleMs"] as const;

export type ParsedOptions = Readonly<{
  refresh: () => Promise<unknown>;
  after: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  intervalMs: number;
  retryMs: number;
  attemptDeadlineMs: number;
}>;

const isInt = (v: unknown, r: Readonly<{ min: number; max: number }>): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= r.min && v <= r.max;

function member(owner: unknown, key: string): unknown {
  try {
    return typeof owner === "object" && owner !== null ? (owner as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined; // دسترسی به کلید پرتاب کرد ⇒ نامعتبر
  }
}

export function parseOptions(options: unknown): { ok: true; value: ParsedOptions } | { ok: false; error: RefresherConfigError } {
  const issues: string[] = [];
  const bad = (): { ok: false; error: RefresherConfigError } => ({
    ok: false,
    error: Object.freeze({ code: "INVALID_CONFIG", message: "گزینه‌های حلقهٔ تازه‌سازیِ سیاست نامعتبر است.", issues: Object.freeze(issues.slice(0, 20)) }),
  });
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    issues.push("options");
    return bad();
  }
  const got: Record<string, unknown> = {};
  try {
    for (const k of Object.keys(options)) if (!(KEYS as readonly string[]).includes(k)) issues.push(`unknown:${k.length <= 40 ? k : "?"}`);
    for (const k of KEYS) got[k] = (options as Record<string, unknown>)[k];
  } catch {
    issues.push("options");
    return bad();
  }
  const source = got["source"] as RefreshableSource | undefined;
  const timer = got["timer"] as RefreshTimer | undefined;
  const refresh = member(source, "refresh");
  const after = member(timer, "after");
  const cancel = member(timer, "cancel");
  if (typeof refresh !== "function") issues.push("source.refresh");
  if (typeof after !== "function") issues.push("timer.after");
  if (typeof cancel !== "function") issues.push("timer.cancel");
  const L = REFRESHER_LIMITS;
  const { intervalMs, retryMs, attemptDeadlineMs, refreshTimeoutMs, maxStaleMs } = got as Record<string, unknown>;
  const okInterval = isInt(intervalMs, L.intervalMs);
  const okRetry = isInt(retryMs, L.retryMs);
  const okDeadline = isInt(attemptDeadlineMs, L.attemptDeadlineMs);
  const okTimeout = isInt(refreshTimeoutMs, L.refreshTimeoutMs);
  const okStale = isInt(maxStaleMs, L.maxStaleMs);
  if (!okInterval) issues.push("intervalMs");
  if (!okRetry) issues.push("retryMs");
  if (!okDeadline) issues.push("attemptDeadlineMs");
  if (!okTimeout) issues.push("refreshTimeoutMs");
  if (!okStale) issues.push("maxStaleMs");
  if (okInterval && okRetry && retryMs > intervalMs) issues.push("relation:retryMs<=intervalMs");
  if (okDeadline && okTimeout && refreshTimeoutMs > attemptDeadlineMs) issues.push("relation:refreshTimeoutMs<=attemptDeadlineMs");
  // یک چرخهٔ ازدست‌رفته (تلاشِ بی‌پاسخ) نباید منبع را STALE کند. بدترین سنِ آخرین تأیید درست پیش از رسیدنِ تلاشِ موفقِ بعد:
  // تلاشِ موفقِ قبلی کُند (deadline) + interval + تلاشِ بی‌پاسخ (deadline) + retry + تلاشِ موفقِ بعدیِ کُند (deadline).
  if (okInterval && okRetry && okDeadline && okStale && intervalMs + 3 * attemptDeadlineMs + retryMs > maxStaleMs) issues.push("relation:interval+3*attemptDeadline+retry<=maxStaleMs");
  if (issues.length > 0) return bad();
  const fnRefresh = refresh as () => Promise<unknown>;
  const fnAfter = after as (fn: () => void, ms: number) => unknown;
  const fnCancel = cancel as (h: unknown) => void;
  return {
    ok: true,
    value: Object.freeze({
      refresh: () => fnRefresh.call(source),
      after: (fn: () => void, ms: number) => fnAfter.call(timer, fn, ms),
      cancel: (h: unknown) => void fnCancel.call(timer, h),
      intervalMs: intervalMs as number,
      retryMs: retryMs as number,
      attemptDeadlineMs: attemptDeadlineMs as number,
    }),
  };
}
