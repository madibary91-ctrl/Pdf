/**
 * outbox تسویه روی PostgreSQL (ADR-0022): پیاده‌سازیِ ماندگارِ پورت `SettlementOutbox`؛ همان `describeOutboxContract` را بی‌تغییر می‌گذراند.
 *
 * هر عملیات = **یک تراکنش**: سپر مهاجرت ← (برای نوشتن) `SELECT … FOR UPDATE` روی ردیفِ همان رزرو ← تصمیم ← `UPDATE` ← commit.
 * قفلِ ردیف، همهٔ تصمیم‌ها را روی یک رکورد سریال می‌کند؛ پس `resolveClose` (بی‌قصدِ مصرف ⇒ سیاستِ یتیم، با قصدِ مصرف ⇒ `release`) و ثبتِ
 * هم‌زمانِ قصدِ مصرفِ درون‌خطی هرگز بر پایهٔ عکسِ کهنه تصمیم نمی‌گیرند (شرط مسابقهٔ ADR-0021 تصمیم ۳ را خودِ پایگاه می‌بندد).
 * اعتبارسنجی مرزی پیش از هر تماس با پایگاه (ورودیِ نامعتبر هیچ تراکنشی نمی‌سازد). هر پرتابِ لایهٔ پایگاه ⇒ `STORE_FAILURE` با پیامِ ثابت و بی‌جزئیات
 * (قرارداد: بی‌پرتاب)؛ تراکنشِ ناقص برمی‌گردد و چیزی نوشته نمی‌شود. زمان‌ها همیشه از فراخواننده می‌آیند (بی‌`now()` پایگاه).
 */
import { sql } from "drizzle-orm";
import type { LedgerDatabase, LedgerExecutor, PgStoreResult } from "@/modules/ledger";
import type { BeginInput, ChargeIntent, CloseIntent, DeadAck, DeadReason, FailureInput, OutboxEntry, OutboxResult, ReservationRef } from "../types";
import { outboxError, parseBegin, parseBurial, parseChargeIntent, parseCloseIntent, parseDeadAck, parseDue, parseFailure, parseListDead, parseRef, isCount } from "../validate";
import { corrupt } from "./errors";
import { assertCurrent, migrate, migrationStatus } from "./migrate";
import { SETTLEMENT_DEFAULT_SCHEMA, parseSchemaName, tableRef } from "./naming";
import { COLUMNS, countsFromRows, entryFromRow, readCount } from "./rows";
import type { PgSettlementOutbox, PgSettlementOutboxOptions } from "./types";

const ok = <T>(value: T): OutboxResult<T> => ({ ok: true, value });
const notFound = () => outboxError("NOT_FOUND", "رکورد تسویه پیدا نشد.");
const notActive = () => outboxError("NOT_ACTIVE", "رکورد تسویه نهایی شده است.");
const conflict = (message: string) => outboxError("CONFLICT", message);
const storeFailure = () => outboxError("STORE_FAILURE", "ذخیرهٔ outbox در دسترس نیست.");
const isActive = (e: OutboxEntry): boolean => e.state === "open" || e.state === "settling";

export function buildPgOutbox(db: LedgerDatabase, schema: string): PgSettlementOutbox {
  const T = tableRef(schema, "settlement_outbox");
  const A = tableRef(schema, "settlement_dead_ack");

  /** یک تراکنش با سپر مهاجرت؛ هر پرتاب (پایگاه، ردیفِ خراب) ⇒ `STORE_FAILURE` (پیام ثابت، بی‌جزئیات). */
  async function run<R>(fn: (tx: LedgerExecutor) => Promise<OutboxResult<R>>, readOnly = false): Promise<OutboxResult<R>> {
    try {
      return await db.transaction(
        async (tx) => {
          await assertCurrent(tx, schema);
          return fn(tx);
        },
        readOnly ? { accessMode: "read only" } : undefined,
      );
    } catch {
      return storeFailure();
    }
  }

  const keyWhere = (r: ReservationRef) => sql`tenant_id = ${r.tenantId} AND account_id = ${r.accountId} AND reservation_id = ${r.reservationId}`;

  async function select(tx: LedgerExecutor, r: ReservationRef, forUpdate: boolean): Promise<OutboxEntry | null> {
    const res = await tx.execute(sql`SELECT ${COLUMNS} FROM ${T} WHERE ${keyWhere(r)} ${forUpdate ? sql`FOR UPDATE` : sql``}`);
    const row = res.rows[0];
    return row === undefined ? null : entryFromRow(row);
  }

  /** رکورد را قفل می‌کند؛ نبودن ⇒ NOT_FOUND، نهایی ⇒ NOT_ACTIVE. */
  async function lockActive(tx: LedgerExecutor, r: ReservationRef): Promise<{ ok: true; value: OutboxEntry } | { ok: false; error: ReturnType<typeof notFound>["error"] }> {
    const e = await select(tx, r, true);
    if (e === null) return notFound();
    if (!isActive(e)) return notActive();
    return { ok: true, value: e };
  }

  return Object.freeze({
    begin: (raw: BeginInput) => {
      const p = parseBegin(raw);
      if (!p.ok) return Promise.resolve(p);
      const b = p.value;
      return run(async (tx) => {
        const ins = await tx.execute(sql`INSERT INTO ${T}
          (tenant_id, account_id, reservation_id, unit, reserved, created_at_ms, expires_at_ms, due_at_ms, orphan_remainder, state)
          VALUES (${b.tenantId}, ${b.accountId}, ${b.reservationId}, ${b.unit}, ${b.reserved}, ${b.createdAtMs}, ${b.expiresAtMs}, ${b.dueAtMs}, ${b.orphanRemainder}, 'open')
          ON CONFLICT (tenant_id, account_id, reservation_id) DO NOTHING
          RETURNING 1 AS inserted`);
        if (ins.rows.length > 0) return ok({ replayed: false });
        // رکورد پیش‌تر هست. میدان‌های آغاز تغییرناپذیرند (TRIGGER)، پس مقایسه با هر عکسی درست است.
        const cur = await select(tx, b, false);
        if (cur === null) throw corrupt("رکوردِ موجود پس از تعارض یافت نشد.");
        const same = cur.unit === b.unit && cur.reserved === b.reserved && cur.expiresAtMs === b.expiresAtMs && cur.orphanRemainder === b.orphanRemainder;
        return same ? ok({ replayed: true }) : conflict("رکورد تسویه با محتوای دیگری پیش‌تر آغاز شده است.");
      });
    },

    recordCharge: (ref: ReservationRef, intent: ChargeIntent) => {
      const r = parseRef(ref);
      const i = parseChargeIntent(intent);
      if (!r.ok) return Promise.resolve(r);
      if (!i.ok) return Promise.resolve(i);
      const ref2 = r.value;
      const want = i.value;
      return run(async (tx) => {
        const a = await lockActive(tx, ref2);
        if (!a.ok) return a;
        const e = a.value;
        if (e.close !== null) return conflict("پس از قصدِ بستن، قصدِ مصرف ممنوع است.");
        if (e.charge !== null) return e.charge.attemptId === want.attemptId && e.charge.amount === want.amount ? ok({ replayed: true }) : conflict("قصدِ مصرفِ دیگری پیش‌تر ثبت شده است.");
        await tx.execute(sql`UPDATE ${T} SET charge_attempt_id = ${want.attemptId}, charge_amount = ${want.amount}, state = 'settling' WHERE ${keyWhere(ref2)}`);
        return ok({ replayed: false });
      });
    },

    recordClose: (ref: ReservationRef, intent: CloseIntent) => {
      const r = parseRef(ref);
      const i = parseCloseIntent(intent);
      if (!r.ok) return Promise.resolve(r);
      if (!i.ok) return Promise.resolve(i);
      const ref2 = r.value;
      const want = i.value;
      return run(async (tx) => {
        const a = await lockActive(tx, ref2);
        if (!a.ok) return a;
        const e = a.value;
        if (e.close !== null) return e.close.remainder === want.remainder ? ok({ replayed: true }) : conflict("قصدِ بستنِ دیگری پیش‌تر ثبت شده است.");
        await tx.execute(sql`UPDATE ${T} SET close_remainder = ${want.remainder}, close_origin = ${want.origin}, state = 'settling' WHERE ${keyWhere(ref2)}`);
        return ok({ replayed: false });
      });
    },

    resolveClose: (ref: ReservationRef) => {
      const r = parseRef(ref);
      if (!r.ok) return Promise.resolve(r);
      const ref2 = r.value;
      return run(async (tx) => {
        const a = await lockActive(tx, ref2);
        if (!a.ok) return a;
        const e = a.value;
        if (e.close !== null) return ok(e);
        // تصمیم زیر قفلِ ردیف: بی‌قصدِ مصرف ⇒ سیاستِ یتیم؛ با قصدِ مصرف ⇒ همیشه release (هرگز بیش از هزینهٔ ثبت‌شده نمی‌گیرد).
        const res = await tx.execute(sql`UPDATE ${T}
          SET close_remainder = CASE WHEN charge_attempt_id IS NULL THEN orphan_remainder ELSE 'release' END, close_origin = 'sweeper', state = 'settling'
          WHERE ${keyWhere(ref2)}
          RETURNING ${COLUMNS}`);
        const row = res.rows[0];
        if (row === undefined) throw corrupt("ردیفِ قفل‌شده پس از به‌روزرسانی یافت نشد.");
        return ok(entryFromRow(row));
      });
    },

    finish: (ref: ReservationRef, atMs: number) => {
      const r = parseRef(ref);
      if (!r.ok) return Promise.resolve(r);
      if (!isCount(atMs)) return Promise.resolve(outboxError("INVALID_INPUT", "ورودی outbox نامعتبر است."));
      const ref2 = r.value;
      return run(async (tx) => {
        const e = await select(tx, ref2, true);
        if (e === null) return notFound();
        if (e.state === "done") return ok({ replayed: true });
        if (e.state === "dead") return notActive();
        if (e.close === null) return conflict("پایان بدون قصدِ بستن ممکن نیست.");
        await tx.execute(sql`UPDATE ${T} SET state = 'done', settled_at_ms = ${atMs} WHERE ${keyWhere(ref2)}`);
        return ok({ replayed: false });
      });
    },

    recordFailure: (ref: ReservationRef, failure: FailureInput) => {
      const r = parseRef(ref);
      const f = parseFailure(failure);
      if (!r.ok) return Promise.resolve(r);
      if (!f.ok) return Promise.resolve(f);
      const ref2 = r.value;
      const want = f.value;
      const expected = want.expectedAttempts;
      return run(async (tx) => {
        const a = await lockActive(tx, ref2);
        if (!a.ok) return a;
        if (expected !== undefined) {
          // compare-and-set زیرِ قفلِ ردیف (ADR-0028): تصمیم و نوشتن در یک تراکنش، پس دو رفتگرِ هم‌زمان یک شکست را دوبار نمی‌شمارند.
          if (a.value.attempts > expected) return ok({ attempts: a.value.attempts, replayed: true });
          if (a.value.attempts < expected) return conflict("شمارندهٔ تلاشِ مورد انتظار از شمارندهٔ رکورد بیشتر است.");
        }
        const res = await tx.execute(sql`UPDATE ${T} SET attempts = attempts + 1, last_error_code = ${want.errorCode}, due_at_ms = ${want.dueAtMs}
          WHERE ${keyWhere(ref2)} RETURNING attempts`);
        const row = res.rows[0];
        if (row === undefined) throw corrupt("ردیفِ قفل‌شده پس از به‌روزرسانی یافت نشد.");
        const attempts = readCount(row["attempts"]);
        return ok(expected === undefined ? { attempts } : { attempts, replayed: false });
      });
    },

    bury: (ref: ReservationRef, burial: Readonly<{ reason: DeadReason; errorCode: string | null; atMs: number }>) => {
      const r = parseRef(ref);
      const b = parseBurial(burial);
      if (!r.ok) return Promise.resolve(r);
      if (!b.ok) return Promise.resolve(b);
      const ref2 = r.value;
      const want = b.value;
      return run(async (tx) => {
        const e = await select(tx, ref2, true);
        if (e === null) return notFound();
        if (e.state === "done") return notActive();
        if (e.state === "dead") return e.deadReason === want.reason ? ok({ replayed: true }) : conflict("رکورد با دلیل دیگری پیش‌تر مرده است.");
        await tx.execute(sql`UPDATE ${T} SET state = 'dead', dead_reason = ${want.reason}, last_error_code = ${want.errorCode}, settled_at_ms = ${want.atMs}
          WHERE ${keyWhere(ref2)}`);
        return ok({ replayed: false });
      });
    },

    get: (ref: ReservationRef) => {
      const r = parseRef(ref);
      if (!r.ok) return Promise.resolve(r);
      const ref2 = r.value;
      return run(async (tx) => ok(await select(tx, ref2, false)), true);
    },

    listDue: (query) => {
      const q = parseDue(query);
      if (!q.ok) return Promise.resolve(q);
      const { nowMs, limit } = q.value;
      return run(async (tx) => {
        const res = await tx.execute(sql`SELECT ${COLUMNS} FROM ${T}
          WHERE state IN ('open', 'settling') AND due_at_ms <= ${nowMs}
          ORDER BY due_at_ms, tenant_id, account_id, reservation_id
          LIMIT ${limit}`);
        return ok(Object.freeze(res.rows.map(entryFromRow)));
      }, true);
    },

    listDead: (query) => {
      const l = parseListDead(query);
      if (!l.ok) return Promise.resolve(l);
      const limit = l.value;
      return run(async (tx) => {
        const res = await tx.execute(sql`SELECT ${COLUMNS} FROM ${T}
          WHERE state = 'dead'
          ORDER BY settled_at_ms, tenant_id, account_id, reservation_id
          LIMIT ${limit}`);
        return ok(Object.freeze(res.rows.map(entryFromRow)));
      }, true);
    },

    listUnacknowledgedDead: (query) => {
      const l = parseListDead(query);
      if (!l.ok) return Promise.resolve(l);
      const limit = l.value;
      return run(async (tx) => {
        // ضدپیوند با جدول تأیید؛ ترتیب و ایندکسِ جزئیِ `dead` همان `listDead` است.
        const res = await tx.execute(sql`SELECT ${COLUMNS} FROM ${T} o
          WHERE o.state = 'dead'
            AND NOT EXISTS (SELECT 1 FROM ${A} a WHERE a.tenant_id = o.tenant_id AND a.account_id = o.account_id AND a.reservation_id = o.reservation_id)
          ORDER BY o.settled_at_ms, o.tenant_id, o.account_id, o.reservation_id
          LIMIT ${limit}`);
        return ok(Object.freeze(res.rows.map(entryFromRow)));
      }, true);
    },

    acknowledgeDead: (ref: ReservationRef, ack: DeadAck) => {
      const r = parseRef(ref);
      const a = parseDeadAck(ack);
      if (!r.ok) return Promise.resolve(r);
      if (!a.ok) return Promise.resolve(a);
      const ref2 = r.value;
      const want = a.value;
      return run(async (tx) => {
        // قفلِ ردیفِ رکورد (مثل بقیهٔ نوشتن‌ها): دو تأییدِ هم‌زمان سریال می‌شوند و دقیقاً یکی «تازه» است.
        const e = await select(tx, ref2, true);
        if (e === null) return notFound();
        if (e.state !== "dead") return conflict("فقط رکوردِ مرده تأیید رسیدگی می‌شود.");
        const ins = await tx.execute(sql`INSERT INTO ${A} (tenant_id, account_id, reservation_id, acked_at_ms)
          VALUES (${ref2.tenantId}, ${ref2.accountId}, ${ref2.reservationId}, ${want.atMs})
          ON CONFLICT (tenant_id, account_id, reservation_id) DO NOTHING
          RETURNING 1 AS inserted`);
        return ok({ replayed: ins.rows.length === 0 });
      });
    },

    counts: () =>
      run(async (tx) => {
        const res = await tx.execute(sql`SELECT state, count(*)::text AS n FROM ${T} GROUP BY state`);
        return ok(countsFromRows(res.rows));
      }, true),

    migrate: () => migrate(db, schema),
    status: () => migrationStatus(db, schema),
  });
}

const isFn = (v: unknown): boolean => typeof v === "function";

/**
 * outbox PostgreSQL. `db` = `drizzle(pool)` از بیرون (این ماژول اتصال نمی‌سازد). ابتدا `await outbox.migrate()`.
 * نام شِما `settlement` است مگر `options.schema` بدهید (فقط `^[a-z][a-z0-9_]{0,39}$`).
 */
export function createPgSettlementOutbox(db: LedgerDatabase, options: PgSettlementOutboxOptions = {}): PgStoreResult<PgSettlementOutbox> {
  const d = db as Partial<LedgerDatabase> | null;
  if (typeof d !== "object" || d === null || !isFn(d.execute) || !isFn(d.transaction)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "«db» باید پایگاه drizzle (execute و transaction) باشد." } };
  }
  if (typeof options !== "object" || options === null) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "«options» باید شیء باشد." } };
  }
  const schema = parseSchemaName(options.schema ?? SETTLEMENT_DEFAULT_SCHEMA);
  if (!schema.ok) return schema;
  return { ok: true, value: buildPgOutbox(db, schema.value) };
}
