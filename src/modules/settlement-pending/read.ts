/**
 * خواندنِ نمایه (داخلی؛ ADR-0046): `listUnacknowledgedDead` با هزینهٔ O(تأییدنشده‌ها) و `verify` (راستی‌آزماییِ نمایه در برابر حقیقت).
 *
 * **حقیقت همیشه outbox است.** نمایه فقط «کدام کلیدها را ببین» را می‌گوید؛ خودِ رکورد با اتصالِ کلیدی (O(سقف)) از outbox خوانده می‌شود و سه شرطِ
 * حقیقت دوباره سنجیده می‌شود (`state='dead'`، همان `settled_at_ms`، بی‌ردیفِ تأیید). پس ردیفِ **کهنه** در نمایه (تأییدشده یا ناهمخوان) هرگز در خروجی
 * نمی‌آید؛ تنها خطرِ باقی‌مانده ردیفِ **گم‌شده** است که TRIGGERها و backfill نمی‌گذارند و `verify()` می‌سنجد.
 * ردیف‌ها سخت‌گیرانه اعتبارسنجی می‌شوند و فقط شکلِ `dead` پذیرفته است؛ ردیفِ خراب ⇒ `STORE_FAILURE` نه رکوردِ نادرست.
 */
import { sql } from "drizzle-orm";
import type { LedgerDatabase, LedgerExecutor, PgStoreResult } from "@/modules/ledger";
import type { DeadReason, OutboxEntry, OutboxResult } from "@/modules/settlement";
import { corrupt, toStoreError } from "./errors";
import { assertCurrent } from "./migrate";
import { tableRef } from "./naming";
import type { PendingDeadIndex, PendingVerifyReport } from "./types";

/** همان سقفِ `listUnacknowledgedDead` ی آداپتورِ settlement (آزمونِ تفاضلی برابریِ مرزها را قفل می‌کند). */
export const PENDING_LIST_LIMIT_MAX = 1000;

/** سقفِ زمانِ سمتِ پایگاه (هم‌ارزِ ADR-0045)؛ آزمونِ تفاضلی برابریِ مرزها با آداپتورِ settlement را قفل می‌کند. */
export const PENDING_READ_STATEMENT_TIMEOUT_LIMITS = Object.freeze({ minMs: 1, maxMs: 7_200_000 });

export function parseReadStatementTimeout(value: unknown): PgStoreResult<number | null> {
  if (value === undefined) return { ok: true, value: null };
  const L = PENDING_READ_STATEMENT_TIMEOUT_LIMITS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < L.minMs || value > L.maxMs) {
    return { ok: false, error: { code: "INVALID_INPUT", message: `readStatementTimeoutMs باید عددِ صحیحِ ${L.minMs} تا ${L.maxMs} میلی‌ثانیه باشد.` } };
  }
  return { ok: true, value };
}

const invalid = (): OutboxResult<never> => ({ ok: false, error: { code: "INVALID_INPUT", message: "ورودی نامعتبر است: limit باید عددِ صحیحِ ۱ تا ۱۰۰۰ باشد." } });
const storeFailure = (): OutboxResult<never> => ({ ok: false, error: { code: "STORE_FAILURE", message: "ذخیرهٔ outbox در دسترس نیست." } });

function parseListQuery(raw: unknown): OutboxResult<number> {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalid();
    const limit = (raw as { limit?: unknown }).limit;
    return typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1 && limit <= PENDING_LIST_LIMIT_MAX ? { ok: true, value: limit } : invalid();
  } catch {
    return invalid();
  }
}

/** باید **نخستین** دستورِ تراکنشِ فقط‌خواندنی باشد؛ `is_local = true` ثابت است (اثرش با پایانِ تراکنش تمام می‌شود). */
async function boundStatementTime(tx: LedgerExecutor, ms: number): Promise<void> {
  await tx.execute(sql`SELECT set_config('statement_timeout', ${String(ms)}, true)`);
}

const COLUMNS = sql.raw(
  "o.tenant_id, o.account_id, o.reservation_id, o.unit, o.reserved, o.created_at_ms, o.expires_at_ms, o.due_at_ms, o.orphan_remainder, o.state, o.charge_attempt_id, o.charge_amount, o.close_remainder, o.close_origin, o.attempts, o.last_error_code, o.dead_reason, o.settled_at_ms",
);

const BAD = "ردیف outbox شکل نادرستی دارد؛ دادهٔ خراب است و به پایش داده نمی‌شود.";
const DEAD: ReadonlySet<unknown> = new Set<DeadReason>(["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"]);

function str(v: unknown): string {
  if (typeof v !== "string") throw corrupt(BAD);
  return v;
}
function strOrNull(v: unknown): string | null {
  return v === null ? null : str(v);
}
function count(v: unknown): number {
  const n = typeof v === "string" && /^\d{1,16}$/.test(v) ? Number(v) : typeof v === "number" ? v : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw corrupt(BAD);
  return n;
}
function countOrNull(v: unknown): number | null {
  return v === null ? null : count(v);
}
function remainder(v: unknown): "release" | "forfeit" {
  if (v !== "release" && v !== "forfeit") throw corrupt(BAD);
  return v;
}

/** فقط رکوردِ `dead` با دلیل و زمانِ مرگ؛ هر شکلِ دیگر خراب است (نمایه فقط مرده‌ها را نشان می‌دهد). */
export function deadEntryFromRow(row: Record<string, unknown>): OutboxEntry {
  if (row["state"] !== "dead") throw corrupt(BAD);
  const deadReason = row["dead_reason"];
  if (!DEAD.has(deadReason)) throw corrupt(BAD);
  const settledAtMs = count(row["settled_at_ms"]);

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
    reserved: count(row["reserved"]),
    createdAtMs: count(row["created_at_ms"]),
    expiresAtMs: count(row["expires_at_ms"]),
    dueAtMs: count(row["due_at_ms"]),
    orphanRemainder: remainder(row["orphan_remainder"]),
    state: "dead" as const,
    charge: attemptId === null || amount === null ? null : Object.freeze({ attemptId, amount }),
    close: closeRemainder === null || closeOrigin === null ? null : Object.freeze({ remainder: closeRemainder, origin: closeOrigin as "caller" | "sweeper" }),
    attempts: count(row["attempts"]),
    lastErrorCode: strOrNull(row["last_error_code"]),
    deadReason: deadReason as DeadReason,
    settledAtMs,
  });
}

export function buildPendingReader(db: LedgerDatabase, schema: string, readStatementTimeoutMs: number | null): Pick<PendingDeadIndex, "listUnacknowledgedDead" | "verify"> {
  const P = tableRef(schema, "settlement_dead_pending");
  const T = tableRef(schema, "settlement_outbox");
  const A = tableRef(schema, "settlement_dead_ack");

  async function readTx<R>(fn: (tx: LedgerExecutor) => Promise<R>, isolation?: "repeatable read"): Promise<R> {
    return db.transaction(
      async (tx) => {
        if (readStatementTimeoutMs !== null) await boundStatementTime(tx, readStatementTimeoutMs);
        await assertCurrent(tx, schema);
        return fn(tx);
      },
      { accessMode: "read only", ...(isolation === undefined ? {} : { isolationLevel: isolation }) },
    );
  }

  return {
    listUnacknowledgedDead: async (query) => {
      const l = parseListQuery(query);
      if (!l.ok) return l;
      const limit = l.value;
      try {
        const entries = await readTx(async (tx) => {
          const res = await tx.execute(sql`SELECT ${COLUMNS} FROM ${P} p
            JOIN ${T} o ON o.tenant_id = p.tenant_id AND o.account_id = p.account_id AND o.reservation_id = p.reservation_id
            WHERE o.state = 'dead' AND o.settled_at_ms = p.settled_at_ms
              AND NOT EXISTS (SELECT 1 FROM ${A} a WHERE a.tenant_id = o.tenant_id AND a.account_id = o.account_id AND a.reservation_id = o.reservation_id)
            ORDER BY p.settled_at_ms, p.tenant_id, p.account_id, p.reservation_id
            LIMIT ${limit}`);
          return Object.freeze(res.rows.map(deadEntryFromRow));
        });
        return { ok: true, value: entries };
      } catch {
        return storeFailure();
      }
    },

    verify: async () => {
      try {
        const report = await readTx(async (tx) => {
          // یک عکسِ یکپارچه (REPEATABLE READ)؛ بی‌آن، نویسندهٔ هم‌زمان میانِ شمارش‌ها ناسازگاریِ دروغین می‌ساخت.
          const res = await tx.execute(sql`SELECT
            (SELECT count(*) FROM ${T} o WHERE o.state = 'dead'
               AND NOT EXISTS (SELECT 1 FROM ${A} a WHERE a.tenant_id = o.tenant_id AND a.account_id = o.account_id AND a.reservation_id = o.reservation_id))::text AS expected,
            (SELECT count(*) FROM ${P})::text AS indexed,
            (SELECT count(*) FROM ${T} o WHERE o.state = 'dead'
               AND NOT EXISTS (SELECT 1 FROM ${A} a WHERE a.tenant_id = o.tenant_id AND a.account_id = o.account_id AND a.reservation_id = o.reservation_id)
               AND NOT EXISTS (SELECT 1 FROM ${P} p WHERE p.tenant_id = o.tenant_id AND p.account_id = o.account_id AND p.reservation_id = o.reservation_id AND p.settled_at_ms = o.settled_at_ms))::text AS missing,
            (SELECT count(*) FROM ${P} p WHERE NOT EXISTS (
               SELECT 1 FROM ${T} o WHERE o.tenant_id = p.tenant_id AND o.account_id = p.account_id AND o.reservation_id = p.reservation_id
                 AND o.state = 'dead' AND o.settled_at_ms = p.settled_at_ms
                 AND NOT EXISTS (SELECT 1 FROM ${A} a WHERE a.tenant_id = o.tenant_id AND a.account_id = o.account_id AND a.reservation_id = o.reservation_id)))::text AS stale`);
          const row = res.rows[0];
          if (row === undefined) throw corrupt("پاسخِ راستی‌آزمایی خالی است.");
          const expected = count(row["expected"]);
          const indexed = count(row["indexed"]);
          const missing = count(row["missing"]);
          const stale = count(row["stale"]);
          return { consistent: missing === 0 && stale === 0, expected, indexed, missing, stale } satisfies PendingVerifyReport;
        }, "repeatable read");
        return { ok: true, value: Object.freeze(report) };
      } catch (e) {
        return { ok: false, error: toStoreError(e).error };
      }
    },
  };
}
