/**
 * settlement — ارزیابِ سلامتِ رفتگر (ADR-0030، م۳‑ه‑۱): از `SweepLoopStatus` و ساعتِ فراخواننده تصمیم می‌گیرد رفتگر `ok`، `degraded` یا `down` است.
 * خالص و بی‌حالت: بی‌ساعت، بی‌تایمر، بی‌ورودی/خروجی؛ زمان آرگومان است. ریشهٔ ترکیب (`/api/health`) فقط `evaluate` و `sweepHealthHttpStatus` را صدا می‌زند.
 * ناورداها:
 *  ۱. **هرگز نمی‌پرتابد:** ورودی `unknown` است؛ getter/Proxyِ بدجنس و شکلِ نادرست ⇒ نتیجهٔ `down`، نه استثنا.
 *  ۲. **شکستِ بسته:** چیزی که نتوان سنجید (وضعیتِ نامعتبر، ساعتِ نامعتبر) `down` است، نه `ok`.
 *  ۳. **بی‌نشت:** نتیجه فقط کدهای شمارشی و عدد دارد؛ هیچ فیلدِ اضافهٔ ورودی (پیام، کلید، متنِ کاربر) به آن نمی‌رسد.
 *  ۴. **یکنوایی:** با ثابت‌ماندنِ وضعیت، جلو رفتنِ ساعت هرگز سلامت را بهتر نمی‌کند.
 *  ۵. **ضمانتِ مالی معیار است:** آستانه‌ها از `graceMs` می‌آیند (ADR-0023: فاصلهٔ گذرها ≤ ⌊graceMs/2⌋)؛ سکوتِ بیش از آن یعنی رزروِ یتیم ممکن است پیش از دیده‌شدن منقضی شود.
 */
import { SETTLEMENT_LIMITS, configError } from "./config";
import type { HealthReason, HealthReasonCode, HealthStatus, LoopFaultKind, LoopState, SettlementResult, SweepHealth, SweepHealthCheck } from "./types";

const STATES: Readonly<Record<LoopState, true>> = { stopped: true, running: true, stopping: true, stalled: true };
const FAULTS: Readonly<Record<LoopFaultKind, true>> = {
  SWEEP_THREW: true,
  BAD_REPORT: true,
  LIST_FAILED: true,
  OUTBOX_FAILURES: true,
  SCHEDULE_FAILED: true,
  DEAD_LIST_FAILED: true,
  DEAD_DELIVER_FAILED: true,
  DEAD_ACK_FAILED: true,
};

const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isCount = isTime;
const isState = (v: unknown): v is LoopState => typeof v === "string" && has(STATES, v);
const isFault = (v: unknown): v is LoopFaultKind => typeof v === "string" && has(FAULTS, v);

const reason = (code: HealthReasonCode, severity: "degraded" | "down", fault: LoopFaultKind | null = null): HealthReason => Object.freeze({ code, severity, fault });

type Thresholds = Readonly<{ degradedAfterMs: number; downAfterMs: number }>;

/** فقط فیلدهای لازم از `status`؛ هر انحراف ⇒ `null`. فیلدهای اضافه (مثلاً `totals`) نادیده‌اند و هرگز نشت نمی‌کنند. */
type ParsedStatus = Readonly<{ state: LoopState; runs: number; consecutiveFailures: number; lastSuccessAtMs: number | null; lastFault: LoopFaultKind | null }>;

function parseStatus(raw: unknown): ParsedStatus | null {
  if (!isRecord(raw)) return null;
  const { state, runs, consecutiveFailures, lastSuccessAtMs, lastFault } = raw;
  if (!isState(state) || !isCount(runs) || !isCount(consecutiveFailures)) return null;
  if (lastSuccessAtMs !== null && !isTime(lastSuccessAtMs)) return null;
  if (lastFault !== null && !isFault(lastFault)) return null;
  return Object.freeze({ state, runs, consecutiveFailures, lastSuccessAtMs, lastFault });
}

/** مرجعِ سکوت: دیرترینِ آخرین موفقیت و آغاز (پس از `stop`/`start` مجدد، سکوت از آغازِ تازه می‌شمارد). */
function silenceReasons(s: ParsedStatus, nowMs: number, sinceMs: number | null, th: Thresholds): { reasons: HealthReason[]; silenceMs: number | null } {
  const { lastSuccessAtMs: ok } = s;
  const ref = ok === null ? sinceMs : sinceMs === null ? ok : Math.max(ok, sinceMs);
  if (ref === null) return { reasons: [reason(s.runs === 0 ? "NOT_YET_RUN" : "NO_SUCCESS_SINCE_START", "degraded")], silenceMs: null };
  const silence = nowMs - ref;
  if (silence < 0) return { reasons: [reason("CLOCK_BEHIND", "degraded")], silenceMs: null };
  const code: HealthReasonCode = ok !== null && ref === ok ? "STALE_SUCCESS" : "NO_SUCCESS_SINCE_START";
  if (silence > th.downAfterMs) return { reasons: [reason(code, "down")], silenceMs: silence };
  if (silence > th.degradedAfterMs) return { reasons: [reason(code, "degraded")], silenceMs: silence };
  return { reasons: [], silenceMs: silence };
}

function build(th: Thresholds, reasons: readonly HealthReason[], silenceMs: number | null, s: ParsedStatus | null): SweepHealth {
  // خطرناک‌ترین‌ها اول؛ مرتب‌سازیِ پایدار (ترتیبِ قاعده‌ها در هر سطح حفظ می‌شود).
  const sorted = [...reasons.filter((r) => r.severity === "down"), ...reasons.filter((r) => r.severity === "degraded")];
  const status: HealthStatus = sorted.length === 0 ? "ok" : sorted[0]?.severity === "down" ? "down" : "degraded";
  return Object.freeze({
    status,
    reasons: Object.freeze(sorted),
    silenceMs,
    consecutiveFailures: s === null ? null : s.consecutiveFailures,
    lastFault: s === null ? null : s.lastFault,
    degradedAfterMs: th.degradedAfterMs,
    downAfterMs: th.downAfterMs,
  });
}

function evaluateRaw(th: Thresholds, input: unknown): SweepHealth {
  if (!isRecord(input)) return build(th, [reason("STATUS_INVALID", "down"), reason("CLOCK_INVALID", "down")], null, null);
  const { status: rawStatus, nowMs, sinceMs } = input;
  const s = parseStatus(rawStatus);
  const since = sinceMs === undefined || sinceMs === null ? null : isTime(sinceMs) ? sinceMs : undefined;
  const invalid: HealthReason[] = [];
  if (s === null) invalid.push(reason("STATUS_INVALID", "down"));
  if (!isTime(nowMs) || since === undefined) invalid.push(reason("CLOCK_INVALID", "down"));
  if (s === null || !isTime(nowMs) || since === undefined) return build(th, invalid, null, s);

  switch (s.state) {
    case "stopped":
      return build(th, [reason("LOOP_STOPPED", "down")], null, s);
    case "stalled":
      return build(th, [reason("LOOP_STALLED", "down")], null, s);
    case "stopping":
      return build(th, [reason("LOOP_STOPPING", "degraded")], null, s);
    case "running": {
      const out: HealthReason[] = [];
      if (s.consecutiveFailures > 0) out.push(reason("LOOP_FAULTING", "degraded", s.lastFault));
      const sil = silenceReasons(s, nowMs, since, th);
      return build(th, [...out, ...sil.reasons], sil.silenceMs, s);
    }
  }
}

/** پیکربندی روی مرز اعتبارسنجی می‌شود (ورودی `unknown`؛ بی‌پرتاب؛ مشکل‌ها فقط نامِ فیلدند، هرگز مقدار). */
export function createSweepHealthCheck(raw: unknown): SettlementResult<SweepHealthCheck> {
  const issues: string[] = [];
  let th: Thresholds | null = null;
  try {
    if (!isRecord(raw)) return configError(["پیکربندی باید یک شیء ساده باشد."]);
    const allowed = new Set(["graceMs", "degradedAfterMs", "downAfterMs"]);
    for (const k of Object.keys(raw)) if (!allowed.has(k)) issues.push(`کلید ناشناخته: ${JSON.stringify(k.slice(0, 40))}.`);
    const max = SETTLEMENT_LIMITS.maxGraceMs;
    const grace = raw["graceMs"];
    const graceOk = isIntIn(grace, 2, max);
    if (!graceOk) issues.push(`graceMs الزامی است (صحیح ۲ تا ${max}).`);
    const d = raw["degradedAfterMs"];
    const u = raw["downAfterMs"];
    const degraded = d === undefined ? (graceOk ? Math.floor(grace / 2) : null) : isIntIn(d, 1, max) ? d : null;
    const down = u === undefined ? (graceOk ? grace : null) : isIntIn(u, 1, max) ? u : null;
    if (d !== undefined && degraded === null) issues.push(`degradedAfterMs باید صحیح ۱ تا ${max} باشد.`);
    if (u !== undefined && down === null) issues.push(`downAfterMs باید صحیح ۱ تا ${max} باشد.`);
    if (degraded !== null && down !== null && degraded > down) issues.push("degradedAfterMs نباید از downAfterMs بیشتر باشد.");
    if (issues.length === 0 && degraded !== null && down !== null) th = Object.freeze({ degradedAfterMs: degraded, downAfterMs: down });
  } catch {
    return configError(["پیکربندی قابل‌خواندن نیست."]);
  }
  if (th === null) return configError(issues);
  const fixed: Thresholds = th;
  const check: SweepHealthCheck = Object.freeze({
    evaluate(input) {
      try {
        return evaluateRaw(fixed, input);
      } catch {
        return build(fixed, [reason("STATUS_INVALID", "down")], null, null);
      }
    },
  });
  return { ok: true, value: check };
}

/**
 * کدِ HTTP پروب: `down` ⇒ ۵۰۳؛ `ok` و `degraded` ⇒ ۲۰۰ (هشدار نباید ریستارتِ زنجیره‌ای بسازد؛ بدنه دلیل را نشان می‌دهد).
 * ورودیِ غیرِ `SweepHealth` (نتیجهٔ دست‌ساز/خراب) ⇒ ۵۰۳ (شکستِ بسته). هرگز نمی‌پرتابد.
 */
export function sweepHealthHttpStatus(health: SweepHealth): 200 | 503 {
  try {
    const status: unknown = isRecord(health) ? health["status"] : undefined;
    return status === "ok" || status === "degraded" ? 200 : 503;
  } catch {
    return 503;
  }
}
