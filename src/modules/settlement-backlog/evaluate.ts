/**
 * settlement-backlog — ارزیابِ خالصِ پسماند (ADR-0039): از «نمونه» و «اکنون» تصمیم می‌گیرد `ok`، `degraded` یا `down`.
 * بی‌ساعت، بی‌تایمر، بی‌ورودی/خروجی؛ زمان آرگومان است. ناورداها:
 *  ۱. **هرگز نمی‌پرتابد:** ورودی `unknown`؛ getter/Proxyِ بدجنس و شکلِ نادرست ⇒ `down` (INPUT_INVALID)، نه استثنا.
 *  ۲. **شکستِ بسته:** نمونهٔ ناسازگار (جمعِ byReason ≠ count، truncated ناهمخوان با سقف، …) هرگز `ok` نیست؛ «نمونهٔ ناخوانا» هم `ok` نیست.
 *  ۳. **بی‌نشت:** نتیجه فقط کدِ شمارشی و عدد دارد؛ هیچ فیلدِ اضافهٔ ورودی (مثلاً شناسه) به آن نمی‌رسد.
 *  ۴. **یکنوایی:** با ثابت‌ماندنِ نمونه، جلو رفتنِ ساعت هرگز سلامت را بهتر نمی‌کند.
 *  ۵. **بریدنِ فهرست آستانه را پنهان نمی‌کند:** `downCount ≤ sampleLimit` (config)، پس فهرستِ بریده‌شده دست‌کم `down` است.
 */
import type { DeadReason } from "@/modules/settlement";
import type { HealthStatus } from "@/modules/settlement";
import type { BacklogByReason, BacklogHealth, BacklogReason, BacklogReasonCode, BacklogSampleFailure, BacklogThresholds } from "./types";

const FAILURES: Readonly<Record<BacklogSampleFailure, true>> = { CLOCK_INVALID: true, LIST_FAILED: true, BAD_LIST: true, TIMEOUT: true };
const REASON_KEYS: readonly DeadReason[] = ["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"];

const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isFailure = (v: unknown): v is BacklogSampleFailure => typeof v === "string" && has(FAILURES, v);

const reason = (code: BacklogReasonCode, severity: "degraded" | "down"): BacklogReason => Object.freeze({ code, severity });

export type EvalContext = Readonly<{ thresholds: BacklogThresholds; sampleLimit: number }>;

type ParsedSample =
  | Readonly<{ ok: true; atMs: number; count: number; truncated: boolean; oldestDeadAtMs: number | null; undated: number; byReason: BacklogByReason }>
  | Readonly<{ ok: false; atMs: number | null; code: BacklogSampleFailure }>;

function parseByReason(raw: unknown): BacklogByReason | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== REASON_KEYS.length) return null;
  const out: Record<string, number> = {};
  for (const k of REASON_KEYS) {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return null;
    out[k] = v;
  }
  return Object.freeze(out) as BacklogByReason;
}

/** فقط فیلدهای لازم؛ هر انحراف یا ناسازگاری ⇒ `null`. فیلدهای اضافه نادیده‌اند و هرگز نشت نمی‌کنند. */
function parseSample(raw: unknown, ctx: EvalContext): ParsedSample | null {
  if (!isRecord(raw)) return null;
  const ok = raw["ok"];
  if (ok === false) {
    const atMs = raw["atMs"];
    const code = raw["code"];
    if (!(atMs === null || isTime(atMs)) || !isFailure(code)) return null;
    return Object.freeze({ ok: false as const, atMs, code });
  }
  if (ok !== true) return null;
  const { atMs, count, truncated, oldestDeadAtMs, undated } = raw;
  const byReason = parseByReason(raw["byReason"]);
  if (!isTime(atMs) || byReason === null) return null;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > ctx.sampleLimit) return null;
  if (typeof undated !== "number" || !Number.isSafeInteger(undated) || undated < 0 || undated > count) return null;
  if (truncated !== (count === ctx.sampleLimit)) return null;
  if (oldestDeadAtMs !== null && !isTime(oldestDeadAtMs)) return null;
  if ((oldestDeadAtMs === null) !== (undated === count)) return null;
  if (REASON_KEYS.reduce((a, k) => a + byReason[k], 0) !== count) return null;
  return Object.freeze({ ok: true as const, atMs, count, truncated, oldestDeadAtMs, undated, byReason });
}

type View = Readonly<{
  count: number | null;
  truncated: boolean | null;
  oldestAgeMs: number | null;
  sampleAgeMs: number | null;
  byReason: BacklogByReason | null;
  failure: BacklogSampleFailure | null;
}>;
const EMPTY_VIEW: View = Object.freeze({ count: null, truncated: null, oldestAgeMs: null, sampleAgeMs: null, byReason: null, failure: null });

function build(th: BacklogThresholds, reasons: readonly BacklogReason[], view: View): BacklogHealth {
  // خطرناک‌ترین‌ها اول؛ مرتب‌سازیِ پایدار (ترتیبِ قاعده‌ها در هر سطح حفظ می‌شود).
  const sorted = [...reasons.filter((r) => r.severity === "down"), ...reasons.filter((r) => r.severity === "degraded")];
  const status: HealthStatus = sorted.length === 0 ? "ok" : sorted[0]?.severity === "down" ? "down" : "degraded";
  return Object.freeze({ status, reasons: Object.freeze(sorted), ...view, thresholds: th });
}

function evaluateRaw(ctx: EvalContext, input: unknown): BacklogHealth {
  const th = ctx.thresholds;
  if (!isRecord(input)) return build(th, [reason("INPUT_INVALID", "down")], EMPTY_VIEW);
  const nowMs = input["nowMs"];
  const s = parseSample(input["sample"], ctx);
  if (s === null || !isTime(nowMs)) return build(th, [reason("INPUT_INVALID", "down")], EMPTY_VIEW);

  if (!s.ok) return build(th, [reason("SAMPLE_UNREADABLE", "degraded")], { ...EMPTY_VIEW, failure: s.code });

  const out: BacklogReason[] = [];
  let behind = false;
  const sampleAge = nowMs - s.atMs;
  let sampleAgeMs: number | null = null;
  if (sampleAge < 0) behind = true;
  else {
    sampleAgeMs = sampleAge;
    if (sampleAge > th.sampleMaxAgeMs) out.push(reason("SAMPLE_STALE", "degraded"));
  }

  if (s.count >= th.downCount) out.push(reason("COUNT_CRITICAL", "down"));
  else if (s.count >= th.degradedCount) out.push(reason("COUNT_HIGH", "degraded"));

  let oldestAgeMs: number | null = null;
  if (s.oldestDeadAtMs !== null) {
    const age = nowMs - s.oldestDeadAtMs;
    if (age < 0) behind = true;
    else {
      oldestAgeMs = age;
      if (age > th.downAfterMs) out.push(reason("OLDEST_STUCK", "down"));
      else if (age > th.degradedAfterMs) out.push(reason("OLDEST_AGED", "degraded"));
    }
  }
  if (s.undated > 0) out.push(reason("AGE_UNKNOWN", "degraded"));
  if (behind) out.push(reason("CLOCK_BEHIND", "degraded"));

  return build(th, out, { count: s.count, truncated: s.truncated, oldestAgeMs, sampleAgeMs, byReason: s.byReason, failure: null });
}

/** ارزیابِ بی‌پرتاب. `ctx` از پیکربندیِ اعتبارسنجی‌شده می‌آید. */
export function evaluateBacklog(ctx: EvalContext, input: unknown): BacklogHealth {
  try {
    return evaluateRaw(ctx, input);
  } catch {
    return build(ctx.thresholds, [reason("INPUT_INVALID", "down")], EMPTY_VIEW);
  }
}
