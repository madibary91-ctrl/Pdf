/**
 * settlement — سیاستِ خالصِ حلقهٔ رفتگر (ADR-0023): تأخیرِ گذر بعد و اعتبارسنجیِ گزارشِ رفتگر.
 * بی‌زمان و بی‌حالت: همهٔ ورودی‌ها آرگومان‌اند تا با آزمون خاصیتی سنجیده شوند.
 */
import type { BuriedItem, DeadLetter, DeadReason, LoopFaultKind, ReservationRef, SweepReport } from "./types";

export type DelayPolicy = Readonly<{ intervalMs: number; maxBackoffMs: number; maxDrainRuns: number }>;
export type RunOutcome = "unhealthy" | "progress" | "idle";
export type NextDelay = Readonly<{ delayMs: number; drainRuns: number }>;

/**
 * - شکست: عقب‌نشینیِ نمایی `interval × 2^(شکست‌های پیاپی − ۱)` با سقف `maxBackoffMs` (نخستین شکست همان فاصلهٔ عادی است: یک سکسکه کند نمی‌کند).
 * - گذرِ پربار (تسویه یا مرگ): بی‌انتظار دوباره، تا `maxDrainRuns` گذرِ پیاپی؛ سپس فاصلهٔ عادی (گرسنگیِ پایگاه/حلقهٔ داغ نیست).
 * - وگرنه: فاصلهٔ عادی و شمارندهٔ تخلیه صفر.
 * هرگز بیش از `maxBackoffMs` (که خودش ≤ ⌊graceMs/2⌋ است) نمی‌ماند.
 */
export function nextDelay(policy: DelayPolicy, outcome: RunOutcome, consecutiveFailures: number, drainRuns: number): NextDelay {
  if (outcome === "unhealthy") {
    const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 30);
    return { delayMs: Math.min(policy.maxBackoffMs, policy.intervalMs * 2 ** exponent), drainRuns: 0 };
  }
  if (outcome === "progress" && drainRuns < policy.maxDrainRuns) return { delayMs: 0, drainRuns: drainRuns + 1 };
  return { delayMs: policy.intervalMs, drainRuns: 0 };
}

export function faultOf(report: SweepReport): LoopFaultKind | null {
  if (report.listFailed) return "LIST_FAILED";
  if (report.outboxFailures > 0) return "OUTBOX_FAILURES";
  return null;
}

export const hasProgress = (report: SweepReport): boolean => report.settled > 0 || report.buried.length > 0;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isShort = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const REASONS: ReadonlySet<string> = new Set<DeadReason>(["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"]);
const MAX_BURIED = 100_000;

function parseBuried(raw: unknown): BuriedItem | null {
  if (!isRecord(raw)) return null;
  const { tenantId, accountId, reservationId, reason, errorCode } = raw;
  if (!isShort(tenantId) || !isShort(accountId) || !isShort(reservationId)) return null;
  if (typeof reason !== "string" || !REASONS.has(reason)) return null;
  if (errorCode !== null && !isShort(errorCode)) return null;
  return Object.freeze({ tenantId, accountId, reservationId, reason: reason as DeadReason, errorCode });
}

/**
 * رفتگرِ تزریقی بیرونی است: خروجی‌اش را باید ریز‌به‌ریز اعتبارسنجی کرد. نتیجه **کپیِ منجمدِ** فقط فیلدهای شناخته‌شده است
 * (هر فیلدِ اضافه، مثل پیامِ خام، حذف می‌شود و دست‌کاریِ بعدیِ مشاهده‌گر به حلقه نمی‌رسد). نامعتبر ⇒ `null`.
 */
export function parseReport(raw: unknown): SweepReport | null {
  try {
    if (!isRecord(raw)) return null;
    const { examined, settled, retryLater, raced, outboxFailures, buried, listFailed } = raw;
    if (!isCount(examined) || !isCount(settled) || !isCount(retryLater) || !isCount(raced) || !isCount(outboxFailures)) return null;
    if (typeof listFailed !== "boolean" || !Array.isArray(buried) || buried.length > MAX_BURIED) return null;
    const items: BuriedItem[] = [];
    for (const b of buried as readonly unknown[]) {
      const item = parseBuried(b);
      if (item === null) return null;
      items.push(item);
    }
    return Object.freeze({ examined, settled, retryLater, raced, outboxFailures, buried: Object.freeze(items), listFailed });
  } catch {
    return null;
  }
}

// ───────────────────────── م۳‑د‑۲: زنگِ ماندگار (ADR-0026) ─────────────────────────

export type ParsedDeadLetter = Readonly<{ ref: ReservationRef; key: string; letter: DeadLetter }>;

/** کلیدِ یکتای رکورد (JSON، تا جداکننده در شناسه‌ها اشتباه نشود). */
export const deadKey = (r: ReservationRef): string => JSON.stringify([r.tenantId, r.accountId, r.reservationId]);

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function parseDeadEntry(raw: unknown): ParsedDeadLetter | null {
  if (!isRecord(raw)) return null;
  const { tenantId, accountId, reservationId, unit, reserved, state, deadReason, lastErrorCode, attempts, settledAtMs } = raw;
  if (!isShort(tenantId) || !isShort(accountId) || !isShort(reservationId) || !isShort(unit)) return null;
  if (state !== "dead" || typeof deadReason !== "string" || !REASONS.has(deadReason)) return null;
  if (!isCount(reserved) || !isCount(attempts)) return null;
  if (lastErrorCode !== null && !isShort(lastErrorCode)) return null;
  if (settledAtMs !== null && !isTime(settledAtMs)) return null;
  const ref: ReservationRef = Object.freeze({ tenantId, accountId, reservationId });
  const letter: DeadLetter = Object.freeze({ tenantId, accountId, reservationId, unit, reserved, reason: deadReason as DeadReason, errorCode: lastErrorCode, attempts, deadAtMs: settledAtMs });
  return Object.freeze({ ref, key: deadKey(ref), letter });
}

/**
 * خروجیِ `listUnacknowledgedDead` را باور نمی‌کند: آرایه‌ای حداکثر `maxItems` عضوی از رکوردهای `dead` با شناسه و عددهای معتبر؛
 * هر انحراف ⇒ `null` (کلِ فهرست رد می‌شود، نه نیمی از آن: outbox خراب است و نباید روی فهرستش تأیید ثبت کرد).
 * نتیجه کپیِ منجمدِ فقط فیلدهای شناخته‌شده است (پیامِ خام هرگز به `deliver` نمی‌رسد).
 */
export function parseDeadList(raw: unknown, maxItems: number): readonly ParsedDeadLetter[] | null {
  try {
    if (!Array.isArray(raw) || raw.length > maxItems) return null;
    const out: ParsedDeadLetter[] = [];
    for (const e of raw as readonly unknown[]) {
      const p = parseDeadEntry(e);
      if (p === null) return null;
      out.push(p);
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}
