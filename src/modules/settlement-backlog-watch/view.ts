/**
 * settlement-backlog-watch — ساختِ نمای همگام از «آخرین نمونهٔ سالم» و «نتیجهٔ آخرین تلاش» (تابعِ خالص؛ ساعت و ارزیاب آرگومان‌اند).
 * ناورداها:
 *  ۱. **شکستِ گذرا شدت را پایین نمی‌آورد:** تلاشِ ناموفق نمونهٔ سالمِ قبلی را کنار نمی‌گذارد؛ فقط `SAMPLE_UNREADABLE` (degraded) به دلیل‌ها می‌افزاید.
 *     نمونهٔ سالم با گذشتِ زمان خودش کهنه می‌شود (`SAMPLE_STALE`، از ارزیابِ ADR-0039)، پس «نمی‌دانم» هرگز `ok` نمی‌شود.
 *  ۲. **بی‌نمونه ⇒ `unknown`** (نه `ok`)، و بی‌نمونه با تلاشِ ناموفق ⇒ `degraded`.
 *  ۳. **دلیل‌ها: خطرناک‌ترین اول**، ترتیبِ نسبیِ هر سطح پایدار؛ `SAMPLE_UNREADABLE` تکراری نمی‌شود.
 */
import type { BacklogHealth, BacklogReason, BacklogSample, BacklogSampleFailure } from "@/modules/settlement-backlog";
import type { BacklogReadyPolicy, BacklogView, BacklogWatchPhase } from "./types";

export type GoodSample = Extract<BacklogSample, { ok: true }>;

export type ViewInput = Readonly<{
  phase: BacklogWatchPhase;
  readyPolicy: BacklogReadyPolicy;
  lastGood: GoodSample | null;
  failure: BacklogSampleFailure | null;
  nowMs: number | null;
  evaluate(input: unknown): BacklogHealth;
}>;

const UNREADABLE: BacklogReason = Object.freeze({ code: "SAMPLE_UNREADABLE" as const, severity: "degraded" as const });
const INVALID: BacklogReason = Object.freeze({ code: "INPUT_INVALID" as const, severity: "down" as const });

export function failClosedView(phase: BacklogWatchPhase, readyPolicy: BacklogReadyPolicy): BacklogView {
  return Object.freeze({
    phase,
    status: "down" as const,
    reasons: Object.freeze([INVALID]),
    count: null,
    truncated: null,
    oldestAgeMs: null,
    sampleAgeMs: null,
    byReason: null,
    failure: null,
    readyPolicy,
  });
}

/** هر استثنا (ارزیابِ خراب) ⇒ نمای شکستِ بسته؛ `view()` هرگز نمی‌پرتابد. */
export function safeView(i: ViewInput): BacklogView {
  try {
    return buildView(i);
  } catch {
    return failClosedView(i.phase, i.readyPolicy);
  }
}

export function buildView(i: ViewInput): BacklogView {
  const { phase, readyPolicy, lastGood, failure } = i;
  if (lastGood === null) {
    return Object.freeze({
      phase,
      status: failure === null ? ("unknown" as const) : ("degraded" as const),
      reasons: Object.freeze(failure === null ? [] : [UNREADABLE]),
      count: null,
      truncated: null,
      oldestAgeMs: null,
      sampleAgeMs: null,
      byReason: null,
      failure,
      readyPolicy,
    });
  }
  const h = i.evaluate({ sample: lastGood, nowMs: i.nowMs });
  const reasons: BacklogReason[] = [...h.reasons];
  let status = h.status;
  if (failure !== null) {
    if (!reasons.some((r) => r.code === "SAMPLE_UNREADABLE")) reasons.push(UNREADABLE);
    if (status === "ok") status = "degraded";
  }
  const ordered = [...reasons.filter((r) => r.severity === "down"), ...reasons.filter((r) => r.severity !== "down")];
  return Object.freeze({
    phase,
    status,
    reasons: Object.freeze(ordered),
    count: h.count,
    truncated: h.truncated,
    oldestAgeMs: h.oldestAgeMs,
    sampleAgeMs: h.sampleAgeMs,
    byReason: h.byReason,
    failure,
    readyPolicy,
  });
}
