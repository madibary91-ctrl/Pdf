/**
 * نگاشت ردیف ⇄ `OutboxEntry` (داخلی). ردیف‌ها سخت‌گیرانه اعتبارسنجی می‌شوند: ردیفی که شکلش با مدل نمی‌خواند (دستکاریِ بیرونی که قیدها را
 * دور زده باشد) پرتاب می‌کند و در لایهٔ بالا `STORE_FAILURE` می‌شود، نه یک رکوردِ نادرست که تصمیمِ مالیِ رفتگر را منحرف کند.
 * bigint در node-postgres رشته است؛ مقدار باید صحیحِ ایمن باشد (دامنهٔ پایگاه همین را تضمین می‌کند).
 */
import { sql } from "drizzle-orm";
import { corrupt } from "./errors";
import type { DeadReason, EntryState, OutboxEntry } from "../types";

/** ستون‌ها به ترتیب ثابت؛ ثابتِ کد است، نه ورودی کاربر. */
export const COLUMNS = sql.raw(
  "tenant_id, account_id, reservation_id, unit, reserved, created_at_ms, expires_at_ms, due_at_ms, orphan_remainder, state, charge_attempt_id, charge_amount, close_remainder, close_origin, attempts, last_error_code, dead_reason, settled_at_ms",
);

const BAD = "ردیف outbox شکل نادرستی دارد؛ دادهٔ خراب است و به رفتگر داده نمی‌شود.";
const STATES: ReadonlySet<unknown> = new Set<EntryState>(["open", "settling", "done", "dead"]);
const DEAD: ReadonlySet<unknown> = new Set<DeadReason>(["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"]);

function str(v: unknown): string {
  if (typeof v !== "string") throw corrupt(BAD);
  return v;
}
function strOrNull(v: unknown): string | null {
  if (v === null) return null;
  return str(v);
}
export function readCount(v: unknown): number {
  const n = typeof v === "string" && /^\d{1,16}$/.test(v) ? Number(v) : typeof v === "number" ? v : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw corrupt(BAD);
  return n;
}
function countOrNull(v: unknown): number | null {
  return v === null ? null : readCount(v);
}
function remainder(v: unknown): "release" | "forfeit" {
  if (v !== "release" && v !== "forfeit") throw corrupt(BAD);
  return v;
}

export function entryFromRow(row: Record<string, unknown>): OutboxEntry {
  const state = row["state"];
  if (!STATES.has(state)) throw corrupt(BAD);
  const deadReason = row["dead_reason"];
  if (deadReason !== null && !DEAD.has(deadReason)) throw corrupt(BAD);

  const attemptId = strOrNull(row["charge_attempt_id"]);
  const amount = countOrNull(row["charge_amount"]);
  if ((attemptId === null) !== (amount === null)) throw corrupt(BAD);
  const closeRemainder = row["close_remainder"] === null ? null : remainder(row["close_remainder"]);
  const closeOrigin = strOrNull(row["close_origin"]);
  if ((closeRemainder === null) !== (closeOrigin === null)) throw corrupt(BAD);
  if (closeOrigin !== null && closeOrigin !== "caller" && closeOrigin !== "sweeper") throw corrupt(BAD);

  return Object.freeze({
    tenantId: str(row["tenant_id"]),
    accountId: str(row["account_id"]),
    reservationId: str(row["reservation_id"]),
    unit: str(row["unit"]),
    reserved: readCount(row["reserved"]),
    createdAtMs: readCount(row["created_at_ms"]),
    expiresAtMs: readCount(row["expires_at_ms"]),
    dueAtMs: readCount(row["due_at_ms"]),
    orphanRemainder: remainder(row["orphan_remainder"]),
    state: state as EntryState,
    charge: attemptId === null || amount === null ? null : Object.freeze({ attemptId, amount }),
    close: closeRemainder === null || closeOrigin === null ? null : Object.freeze({ remainder: closeRemainder, origin: closeOrigin as "caller" | "sweeper" }),
    attempts: readCount(row["attempts"]),
    lastErrorCode: strOrNull(row["last_error_code"]),
    deadReason: deadReason === null ? null : (deadReason as DeadReason),
    settledAtMs: countOrNull(row["settled_at_ms"]),
  });
}

export function countsFromRows(rows: readonly Record<string, unknown>[]): Readonly<Record<EntryState, number>> {
  const c: Record<EntryState, number> = { open: 0, settling: 0, done: 0, dead: 0 };
  for (const r of rows) {
    const s = r["state"];
    if (!STATES.has(s)) throw corrupt(BAD);
    c[s as EntryState] = readCount(r["n"]);
  }
  return Object.freeze(c);
}
