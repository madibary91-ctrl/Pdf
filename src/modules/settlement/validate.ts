/**
 * settlement — اعتبارسنجی مرزی پورت outbox. همه‌چیز سخت‌گیرانه و بی‌پرتاب؛ پیام‌ها ثابت‌اند و مقدارِ ورودی را بازتاب نمی‌دهند.
 * مقدارها یک‌بار خوانده می‌شوند (getter/Proxy نتواند بین اعتبارسنجی و استفاده تغییر دهد).
 */
import { ID_RE, UNIT_RE } from "@/modules/ledger";
import type { BeginInput, ChargeIntent, ClaimQuery, CloseIntent, DeadAck, DeadReason, FailureInput, OutboxError, OutboxErrorCode, OutboxResult, ReservationRef } from "./types";

export const LIST_LIMIT_MAX = 1000;
/** سقفِ اجارهٔ رفتگر (یک شبانه‌روز)؛ اجارهٔ بی‌پایان رکورد را عملاً گم می‌کرد (ADR-0029). */
export const LEASE_MS_MAX = 86_400_000;

export const outboxError = (code: OutboxErrorCode, message: string): { ok: false; error: OutboxError } => ({ ok: false, error: Object.freeze({ code, message }) });
const invalid = (): { ok: false; error: OutboxError } => outboxError("INVALID_INPUT", "ورودی outbox نامعتبر است.");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
export const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isRemainder = (v: unknown): v is "release" | "forfeit" => v === "release" || v === "forfeit";
const DEAD_REASONS: ReadonlySet<unknown> = new Set<DeadReason>(["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"]);
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function parseRef(raw: unknown): OutboxResult<ReservationRef> {
  try {
    if (!isRecord(raw)) return invalid();
    const { tenantId, accountId, reservationId } = raw;
    if (!isId(tenantId) || !isId(accountId) || !isId(reservationId)) return invalid();
    return { ok: true, value: Object.freeze({ tenantId, accountId, reservationId }) };
  } catch {
    return invalid();
  }
}

export function parseBegin(raw: unknown): OutboxResult<BeginInput> {
  try {
    if (!isRecord(raw)) return invalid();
    const { tenantId, accountId, reservationId, unit, reserved, createdAtMs, expiresAtMs, dueAtMs, orphanRemainder } = raw;
    if (!isId(tenantId) || !isId(accountId) || !isId(reservationId)) return invalid();
    if (typeof unit !== "string" || !UNIT_RE.test(unit)) return invalid();
    if (!isCount(reserved) || reserved < 1 || !isCount(createdAtMs) || !isCount(expiresAtMs) || !isCount(dueAtMs)) return invalid();
    if (!isRemainder(orphanRemainder)) return invalid();
    return { ok: true, value: Object.freeze({ tenantId, accountId, reservationId, unit, reserved, createdAtMs, expiresAtMs, dueAtMs, orphanRemainder }) };
  } catch {
    return invalid();
  }
}

export function parseChargeIntent(raw: unknown): OutboxResult<ChargeIntent> {
  try {
    if (!isRecord(raw)) return invalid();
    const { attemptId, amount } = raw;
    if (!isId(attemptId) || !isCount(amount)) return invalid();
    return { ok: true, value: Object.freeze({ attemptId, amount }) };
  } catch {
    return invalid();
  }
}

export function parseCloseIntent(raw: unknown): OutboxResult<CloseIntent> {
  try {
    if (!isRecord(raw)) return invalid();
    const { remainder, origin } = raw;
    if (!isRemainder(remainder) || (origin !== "caller" && origin !== "sweeper")) return invalid();
    return { ok: true, value: Object.freeze({ remainder, origin }) };
  } catch {
    return invalid();
  }
}

export function parseFailure(raw: unknown): OutboxResult<FailureInput> {
  try {
    if (!isRecord(raw)) return invalid();
    const { errorCode, dueAtMs, expectedAttempts } = raw;
    if (typeof errorCode !== "string" || !ERROR_CODE_RE.test(errorCode) || !isCount(dueAtMs)) return invalid();
    // `undefined` ≡ نبودن (فراخواننده‌ای که فیلد را شرطی می‌گذارد)؛ `null`/غیرعدد/منفی/اعشار/ناایمن ⇒ نامعتبر.
    if (expectedAttempts === undefined) return { ok: true, value: Object.freeze({ errorCode, dueAtMs }) };
    if (!isCount(expectedAttempts)) return invalid();
    return { ok: true, value: Object.freeze({ errorCode, dueAtMs, expectedAttempts }) };
  } catch {
    return invalid();
  }
}

export function parseBurial(raw: unknown): OutboxResult<Readonly<{ reason: DeadReason; errorCode: string | null; atMs: number }>> {
  try {
    if (!isRecord(raw)) return invalid();
    const { reason, errorCode, atMs } = raw;
    if (!DEAD_REASONS.has(reason) || !isCount(atMs)) return invalid();
    if (errorCode !== null && (typeof errorCode !== "string" || !ERROR_CODE_RE.test(errorCode))) return invalid();
    return { ok: true, value: Object.freeze({ reason: reason as DeadReason, errorCode, atMs }) };
  } catch {
    return invalid();
  }
}

export function parseLimit(raw: unknown): OutboxResult<number> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= LIST_LIMIT_MAX ? { ok: true, value: raw } : invalid();
}

export function parseDue(raw: unknown): OutboxResult<Readonly<{ nowMs: number; limit: number }>> {
  try {
    if (!isRecord(raw)) return invalid();
    const { nowMs, limit } = raw;
    const l = parseLimit(limit);
    if (!isCount(nowMs) || !l.ok) return invalid();
    return { ok: true, value: Object.freeze({ nowMs, limit: l.value }) };
  } catch {
    return invalid();
  }
}

/** `isLeaseMs` همان حدِ `claimDue` و پیکربندیِ رفتگر است؛ یک تعریف، دو مصرف‌کننده. */
export const isLeaseMs = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= LEASE_MS_MAX;

/** `nowMs + leaseMs` هم باید صحیحِ ایمن بماند (ستونِ `due_at_ms` همین دامنه است)؛ وگرنه ورودی نامعتبر است، نه سرریزِ بی‌صدا. */
export function parseClaim(raw: unknown): OutboxResult<ClaimQuery> {
  try {
    if (!isRecord(raw)) return invalid();
    const { nowMs, limit, leaseMs } = raw;
    const l = parseLimit(limit);
    if (!isCount(nowMs) || !l.ok || !isLeaseMs(leaseMs) || !Number.isSafeInteger(nowMs + leaseMs)) return invalid();
    return { ok: true, value: Object.freeze({ nowMs, limit: l.value, leaseMs }) };
  } catch {
    return invalid();
  }
}

export function parseListDead(raw: unknown): OutboxResult<number> {
  try {
    if (!isRecord(raw)) return invalid();
    return parseLimit(raw["limit"]);
  } catch {
    return invalid();
  }
}

export function parseDeadAck(raw: unknown): OutboxResult<DeadAck> {
  try {
    if (!isRecord(raw)) return invalid();
    const { atMs } = raw;
    if (!isCount(atMs)) return invalid();
    return { ok: true, value: Object.freeze({ atMs }) };
  } catch {
    return invalid();
  }
}
