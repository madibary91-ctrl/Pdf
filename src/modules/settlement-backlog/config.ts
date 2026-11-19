/**
 * settlement-backlog — اعتبارسنجی پیکربندی روی مرز (ورودی `unknown`؛ بی‌پرتاب؛ مشکل‌ها فقط نامِ فیلدند، هرگز مقدار).
 * هر کلید دقیقاً یک بار خوانده می‌شود (getterِ بدجنس نمی‌تواند میانِ اعتبارسنجی و استفاده مقدار عوض کند).
 */
import { SETTLEMENT_LIMITS } from "@/modules/settlement";
import type { LoopTimer } from "@/modules/settlement";
import type { BacklogClock, BacklogConfigError, BacklogOutbox, BacklogResult, BacklogThresholds } from "./types";

export const SETTLEMENT_BACKLOG_LIMITS = Object.freeze({
  /** سقفِ خواندن = سقفِ دستهٔ `listUnacknowledgedDead` در outbox. */
  maxSampleLimit: SETTLEMENT_LIMITS.maxDeadBatchLimit,
  defaultSampleLimit: SETTLEMENT_LIMITS.maxDeadBatchLimit,
  /** سقفِ هر آستانهٔ زمانی: یک سال. */
  maxAgeMs: 365 * 86_400_000,
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 3_600_000,
});

export type BacklogSettings = Readonly<{
  outbox: BacklogOutbox;
  clock: BacklogClock;
  timer: LoopTimer | null;
  timeoutMs: number;
  sampleLimit: number;
  thresholds: BacklogThresholds;
}>;

const KEYS = new Set(["outbox", "clock", "degradedCount", "downCount", "degradedAfterMs", "downAfterMs", "sampleMaxAgeMs", "sampleLimit", "timer", "timeoutMs"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;
const hasFns = (v: unknown, names: readonly string[]): boolean => (typeof v === "object" || typeof v === "function") && v !== null && names.every((n) => typeof (v as Record<string, unknown>)[n] === "function");

export function configError(issues: readonly string[]): { ok: false; error: BacklogConfigError } {
  return { ok: false, error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندی پایشِ پسماندِ زنگ نامعتبر است.", issues: Object.freeze([...issues]) }) };
}

export function resolveBacklogSettings(raw: unknown): BacklogResult<BacklogSettings> {
  const issues: string[] = [];
  try {
    if (!isRecord(raw)) return configError(["پیکربندی باید یک شیء ساده باشد."]);
    for (const k of Object.keys(raw)) if (!KEYS.has(k)) issues.push(`کلید ناشناخته: ${JSON.stringify(k.slice(0, 40))}.`);
    const outbox = raw["outbox"];
    const clock = raw["clock"];
    const timer = raw["timer"];
    const timeoutMs = raw["timeoutMs"];
    const sampleLimitRaw = raw["sampleLimit"];
    const degradedCount = raw["degradedCount"];
    const downCount = raw["downCount"];
    const degradedAfterMs = raw["degradedAfterMs"];
    const downAfterMs = raw["downAfterMs"];
    const sampleMaxAgeMs = raw["sampleMaxAgeMs"];

    if (!hasFns(outbox, ["listUnacknowledgedDead"])) issues.push("outbox باید listUnacknowledgedDead داشته باشد.");
    if (!hasFns(clock, ["nowMs"])) issues.push("clock الزامی است و باید nowMs داشته باشد.");

    const maxAge = SETTLEMENT_BACKLOG_LIMITS.maxAgeMs;
    const lim = sampleLimitRaw === undefined ? SETTLEMENT_BACKLOG_LIMITS.defaultSampleLimit : sampleLimitRaw;
    const limOk = isIntIn(lim, 1, SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);
    if (!limOk) issues.push(`sampleLimit باید صحیح ۱ تا ${SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit} باشد.`);
    const dcOk = isIntIn(degradedCount, 1, limOk ? lim : SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);
    const ucOk = isIntIn(downCount, 1, limOk ? lim : SETTLEMENT_BACKLOG_LIMITS.maxSampleLimit);
    if (!dcOk) issues.push("degradedCount الزامی است (صحیح ۱ تا sampleLimit).");
    if (!ucOk) issues.push("downCount الزامی است (صحیح ۱ تا sampleLimit).");
    if (dcOk && ucOk && degradedCount > downCount) issues.push("degradedCount نباید از downCount بیشتر باشد.");
    const daOk = isIntIn(degradedAfterMs, 1, maxAge);
    const uaOk = isIntIn(downAfterMs, 1, maxAge);
    if (!daOk) issues.push(`degradedAfterMs الزامی است (صحیح ۱ تا ${maxAge}).`);
    if (!uaOk) issues.push(`downAfterMs الزامی است (صحیح ۱ تا ${maxAge}).`);
    if (daOk && uaOk && degradedAfterMs > downAfterMs) issues.push("degradedAfterMs نباید از downAfterMs بیشتر باشد.");
    const smOk = isIntIn(sampleMaxAgeMs, 1, maxAge);
    if (!smOk) issues.push(`sampleMaxAgeMs الزامی است (صحیح ۱ تا ${maxAge}).`);

    let timerOk: LoopTimer | null = null;
    if (timer !== undefined) {
      if (hasFns(timer, ["after", "cancel"])) timerOk = timer as LoopTimer;
      else issues.push("timer باید after و cancel داشته باشد.");
    }
    let timeout: number = SETTLEMENT_BACKLOG_LIMITS.defaultTimeoutMs;
    if (timeoutMs !== undefined) {
      if (timer === undefined) issues.push("timeoutMs بدونِ timer معنا ندارد.");
      else if (!isIntIn(timeoutMs, 1, SETTLEMENT_BACKLOG_LIMITS.maxTimeoutMs)) issues.push(`timeoutMs باید صحیح ۱ تا ${SETTLEMENT_BACKLOG_LIMITS.maxTimeoutMs} باشد.`);
      else timeout = timeoutMs;
    }

    if (issues.length > 0) return configError(issues);
    const thresholds: BacklogThresholds = Object.freeze({
      degradedCount: degradedCount as number,
      downCount: downCount as number,
      degradedAfterMs: degradedAfterMs as number,
      downAfterMs: downAfterMs as number,
      sampleMaxAgeMs: sampleMaxAgeMs as number,
    });
    return {
      ok: true,
      value: Object.freeze({ outbox: outbox as BacklogOutbox, clock: clock as BacklogClock, timer: timerOk, timeoutMs: timeout, sampleLimit: lim as number, thresholds }),
    };
  } catch {
    return configError(["پیکربندی قابل‌خواندن نیست."]);
  }
}
