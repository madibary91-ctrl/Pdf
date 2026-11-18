/**
 * نگاشت ردیف‌های پایگاه ⇄ مدل دامنه (داخلی). هر مقدارِ خوانده‌شده **سخت‌گیرانه** سنجیده می‌شود؛ ردیفی که شکلش با مدل نمی‌خواند
 * خطای `CORRUPT_DATA` است و هرگز «اصلاح» نمی‌شود. پیام‌ها ثابت‌اند و مقدار ردیف را بازتاب نمی‌دهند.
 */
import type { AccountKey, AccountState, AttemptCharge, JournalEntry, JournalType, Processed, Receipt, Reservation } from "../types";
import { ID_RE } from "../validate";
import { corrupt } from "./errors";

type Row = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** bigint پستگرس با pg به‌صورت رشته می‌آید؛ فقط صحیح ایمنِ نامنفی پذیرفته می‌شود. */
export function int(v: unknown, what: string): number {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = Number(v);
  else if (typeof v === "string" && /^[0-9]{1,16}$/.test(v)) n = Number(v);
  else throw corrupt(`ستون «${what}» عدد صحیح نیست.`);
  if (!Number.isSafeInteger(n) || n < 0) throw corrupt(`ستون «${what}» از بازهٔ صحیح ایمن بیرون است.`);
  return n;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw corrupt(`ستون «${what}» متن نیست.`);
  return v;
}

function nullableInt(v: unknown, what: string): number | null {
  return v === null || v === undefined ? null : int(v, what);
}

function jsonValue(v: unknown, what: string): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    throw corrupt(`ستون «${what}» JSON معتبر نیست.`);
  }
}

const ATTEMPT_KEYS = "charged,refunded,requested,shortfall";

function parseAttempts(raw: unknown): Record<string, AttemptCharge> {
  const v = jsonValue(raw, "attempts");
  if (!isRecord(v)) throw corrupt("ستون «attempts» شیء نیست.");
  const out: Record<string, AttemptCharge> = {};
  for (const [id, a] of Object.entries(v)) {
    if (!ID_RE.test(id) || !isRecord(a) || Object.keys(a).sort().join(",") !== ATTEMPT_KEYS) throw corrupt("ساختار «attempts» نامعتبر است.");
    out[id] = { requested: int(a["requested"], "attempt.requested"), charged: int(a["charged"], "attempt.charged"), shortfall: int(a["shortfall"], "attempt.shortfall"), refunded: int(a["refunded"], "attempt.refunded") };
  }
  return out;
}

const RECEIPT_KINDS: ReadonlySet<string> = new Set(["open", "grant", "reserve", "charge", "close", "refund"]);

function parseReceipt(raw: unknown): Receipt {
  const v = jsonValue(raw, "receipt");
  if (!isRecord(v) || typeof v["kind"] !== "string" || !RECEIPT_KINDS.has(v["kind"])) throw corrupt("ساختار «receipt» نامعتبر است.");
  for (const x of Object.values(v)) if (typeof x !== "string" && typeof x !== "number") throw corrupt("ساختار «receipt» نامعتبر است.");
  return v as unknown as Receipt;
}

function parseReservation(r: Row): Reservation {
  const status = r["status"];
  if (status !== "open" && status !== "closed") throw corrupt("وضعیت رزرو نامعتبر است.");
  const closedBy = r["closed_by"] ?? null;
  if (closedBy !== null && closedBy !== "release" && closedBy !== "forfeit" && closedBy !== "expiry") throw corrupt("closed_by نامعتبر است.");
  const id = str(r["reservation_id"], "reservation_id");
  return {
    id,
    amount: int(r["amount"], "amount"),
    remaining: int(r["remaining"], "remaining"),
    charged: int(r["charged"], "charged"),
    status,
    closedBy,
    closedAmount: int(r["closed_amount"], "closed_amount"),
    createdAtMs: int(r["created_at_ms"], "created_at_ms"),
    expiresAtMs: int(r["expires_at_ms"], "expires_at_ms"),
    closedAtMs: nullableInt(r["closed_at_ms"], "closed_at_ms"),
    attempts: parseAttempts(r["attempts"]),
  };
}

export function stateFromRows(key: AccountKey, acc: Row, reservations: readonly Row[], processed: readonly Row[]): AccountState {
  const res: Record<string, Reservation> = {};
  for (const row of reservations) {
    const r = parseReservation(row);
    if (Object.hasOwn(res, r.id)) throw corrupt("رزرو تکراری.");
    res[r.id] = r;
  }
  const proc: Record<string, Processed> = {};
  for (const row of processed) {
    const k = str(row["op_key"], "op_key");
    if (Object.hasOwn(proc, k)) throw corrupt("کلید یکتاییِ تکراری.");
    proc[k] = { fingerprint: str(row["fingerprint"], "fingerprint"), receipt: parseReceipt(row["receipt"]) };
  }
  return {
    tenantId: key.tenantId,
    accountId: key.accountId,
    unit: str(acc["unit"], "unit"),
    createdAtMs: int(acc["created_at_ms"], "created_at_ms"),
    lastAtMs: int(acc["last_at_ms"], "last_at_ms"),
    seq: int(acc["seq"], "seq"),
    available: int(acc["available"], "available"),
    held: int(acc["held"], "held"),
    totals: {
      granted: int(acc["granted"], "granted"),
      charged: int(acc["charged"], "charged"),
      forfeited: int(acc["forfeited"], "forfeited"),
      refunded: int(acc["refunded"], "refunded"),
      shortfall: int(acc["shortfall"], "shortfall"),
    },
    reservations: res,
    processed: proc,
  };
}

const JOURNAL_TYPES: ReadonlySet<string> = new Set(["grant", "reserve", "charge", "release", "forfeit", "expire", "refund"]);

function nullableId(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null;
  const s = str(v, what);
  if (!ID_RE.test(s)) throw corrupt(`ستون «${what}» شناسهٔ معتبر نیست.`);
  return s;
}

export function journalFromRow(r: Row): JournalEntry {
  const type = str(r["type"], "type");
  if (!JOURNAL_TYPES.has(type)) throw corrupt("نوع ورودی ژورنال نامعتبر است.");
  return {
    seq: int(r["seq"], "seq"),
    atMs: int(r["at_ms"], "at_ms"),
    type: type as JournalType,
    amount: int(r["amount"], "amount"),
    shortfall: int(r["shortfall"], "shortfall"),
    reservationId: nullableId(r["reservation_id"], "reservation_id"),
    attemptId: nullableId(r["attempt_id"], "attempt_id"),
    refId: nullableId(r["ref_id"], "ref_id"),
    availableAfter: int(r["available_after"], "available_after"),
    heldAfter: int(r["held_after"], "held_after"),
  };
}

/** نمایهٔ متعارفِ یک رزرو برای مقایسهٔ تفاضلی (ترتیب کلیدهای `attempts` که jsonb عوض می‌کند بی‌اثر است). */
export function reservationCanon(r: Reservation): string {
  const attempts = Object.keys(r.attempts)
    .sort()
    .map((id) => {
      const a = r.attempts[id] as AttemptCharge;
      return [id, a.requested, a.charged, a.shortfall, a.refunded];
    });
  return JSON.stringify([r.id, r.amount, r.remaining, r.charged, r.status, r.closedBy, r.closedAmount, r.createdAtMs, r.expiresAtMs, r.closedAtMs, attempts]);
}

export function processedCanon(p: Processed): string {
  const receipt = Object.entries(p.receipt as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([p.fingerprint, receipt]);
}
