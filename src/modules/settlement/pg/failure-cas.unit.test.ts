/**
 * ثبتِ شکستِ تکرارپذیر روی آداپتور PostgreSQL، بی‌پایگاه (ADR-0028): مرزِ اعتبارسنجی، شکلِ SQL (چه چیزی نوشته می‌شود و چه چیزی نه)،
 * خرابیِ پایگاه، و ردیفِ خراب. پایگاهِ جعلی هر دستور را ثبت می‌کند؛ رفتارِ واقعی در `failure-cas.pg.test.ts` است.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { LedgerDatabase, LedgerTransactionConfig } from "@/modules/ledger";
import { MIGRATIONS, migrationChecksum } from "./migrations";
import { createPgSettlementOutbox } from "./store";

const dialect = new PgDialect();
const REF = { tenantId: "t1", accountId: "a1", reservationId: "r1" };

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenant_id: "t1", account_id: "a1", reservation_id: "r1", unit: "IRR_MICROS", reserved: "500", created_at_ms: "1000", expires_at_ms: "61000", due_at_ms: "11000",
  orphan_remainder: "forfeit", state: "open", charge_attempt_id: null, charge_amount: null, close_remainder: null, close_origin: null, attempts: "2",
  last_error_code: "STORE_FAILURE", dead_reason: null, settled_at_ms: null, ...over,
});

function stub(reply: (text: string, params: readonly unknown[]) => readonly Record<string, unknown>[], failWith?: Error) {
  const log: { text: string; params: unknown[] }[] = [];
  const configs: (LedgerTransactionConfig | undefined)[] = [];
  const execute = async (query: SQL) => {
    const q = dialect.sqlToQuery(query);
    log.push({ text: q.sql, params: [...q.params] });
    if (q.sql.includes("settlement_migration_ledger")) return { rows: MIGRATIONS.map((m) => ({ name: m.name, checksum: migrationChecksum(m) })) };
    if (failWith !== undefined) throw failWith;
    return { rows: [...reply(q.sql, q.params)] };
  };
  const db: LedgerDatabase = {
    execute,
    transaction: async (run, config) => {
      configs.push(config);
      return run({ execute });
    },
  };
  const made = createPgSettlementOutbox(db, { schema: "zz" });
  if (!made.ok) throw new Error("x");
  return { outbox: made.value, configs, data: () => log.filter((l) => !l.text.includes("settlement_migration_ledger")) };
}
const isSelect = (t: string): boolean => /^select/i.test(t.trim());
const isUpdate = (t: string): boolean => /^update/i.test(t.trim());
const attemptsServer = (attempts: string) => (text: string) => (isSelect(text) ? [row({ attempts })] : isUpdate(text) ? [{ attempts: String(Number(attempts) + 1) }] : []);

describe("settlement/pg · ثبتِ شکستِ تکرارپذیر · مرز: ورودی نامعتبر هرگز به پایگاه نمی‌رسد", () => {
  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.MAX_SAFE_INTEGER + 1], [null], ["2"], [{}], [[]], [true]])("expectedAttempts=%j ⇒ INVALID_INPUT و صفر تراکنش", async (bad) => {
    const s = stub(() => []);
    const r = await s.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9, expectedAttempts: bad } as never);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(s.configs).toHaveLength(0);
    expect(s.data()).toHaveLength(0);
  });

  it("getterِ بدجنس: expectedAttempts فقط یک‌بار خوانده می‌شود (بین اعتبارسنجی و استفاده تغییر نمی‌کند)", async () => {
    let reads = 0;
    const evil = { errorCode: "STORE_FAILURE", dueAtMs: 9, get expectedAttempts() { reads += 1; return reads === 1 ? 2 : 0; } };
    const s = stub(attemptsServer("2"));
    const r = await s.outbox.recordFailure(REF, evil);
    expect(reads).toBe(1);
    expect(r).toEqual({ ok: true, value: { attempts: 3, replayed: false } });
  });
});

describe("settlement/pg · ثبتِ شکستِ تکرارپذیر · شکلِ SQL", () => {
  it("برابر ⇒ یک تراکنشِ نوشتنی: SELECT … FOR UPDATE سپس UPDATE؛ مقدارها فقط پارامتر (هیچ دادهٔ ورودی در متنِ SQL نیست)", async () => {
    const s = stub(attemptsServer("2"));
    const r = await s.outbox.recordFailure(REF, { errorCode: "SECRET_CODE_X", dueAtMs: 987_654, expectedAttempts: 2 });
    expect(r).toEqual({ ok: true, value: { attempts: 3, replayed: false } });
    expect(s.configs).toEqual([undefined]); // تراکنشِ نوشتنی (نه فقط‌خواندنی)
    const d = s.data();
    expect(d).toHaveLength(2);
    expect(d[0]?.text).toMatch(/for update/i);
    expect(isUpdate(d[1]?.text ?? "")).toBe(true);
    expect(d[1]?.params).toEqual(expect.arrayContaining(["SECRET_CODE_X", 987_654]));
    for (const l of d) expect(l.text).not.toMatch(/SECRET_CODE_X|987654|\b2\b.*expected/);
  });

  it("کهنه ⇒ فقط SELECT … FOR UPDATE؛ هیچ UPDATE و INSERT و DELETE نیست؛ نتیجه replayed با شمارندهٔ فعلی", async () => {
    const s = stub(attemptsServer("5"));
    const r = await s.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9, expectedAttempts: 1 });
    expect(r).toEqual({ ok: true, value: { attempts: 5, replayed: true } });
    const d = s.data();
    expect(d).toHaveLength(1);
    expect(d.some((l) => /^\s*(update|insert|delete)/i.test(l.text))).toBe(false);
  });

  it("آینده ⇒ CONFLICT با پیامِ ثابت؛ هیچ نوشتنی", async () => {
    const s = stub(attemptsServer("2"));
    const r = await s.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9, expectedAttempts: 7 });
    expect(r).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    if (!r.ok) expect(r.error.message).not.toMatch(/\b7\b/);
    expect(s.data().some((l) => isUpdate(l.text))).toBe(false);
  });

  it("نهایی ⇒ NOT_ACTIVE پیش از مقایسه؛ هیچ نوشتنی (حتی با expectedAttempts «آینده»)", async () => {
    const s = stub((t) => (isSelect(t) ? [row({ state: "dead", dead_reason: "LEDGER_REJECTED", settled_at_ms: "5" })] : []));
    expect(await s.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9, expectedAttempts: 99 })).toMatchObject({ ok: false, error: { code: "NOT_ACTIVE" } });
    expect(s.data().some((l) => isUpdate(l.text))).toBe(false);
  });

  it("بی‌رکورد ⇒ NOT_FOUND", async () => {
    const s = stub(() => []);
    expect(await s.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9, expectedAttempts: 0 })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("بی‌expectedAttempts: همان دو دستورِ پیشین و نتیجهٔ بی‌replayed (سازگاریِ رو به عقب)", async () => {
    const s = stub(attemptsServer("2"));
    const r = await s.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9 });
    expect(r).toEqual({ ok: true, value: { attempts: 3 } });
    expect(s.data().map((l) => (isSelect(l.text) ? "select" : isUpdate(l.text) ? "update" : "?"))).toEqual(["select", "update"]);
  });

  it("متنِ UPDATE در مسیرِ CAS با مسیرِ بی‌CAS یکی است (شرطِ CAS زیرِ قفل در کد است نه در SQLِ تازه)", async () => {
    const a = stub(attemptsServer("2"));
    const b = stub(attemptsServer("2"));
    await a.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9 });
    await b.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9, expectedAttempts: 2 });
    expect(b.data().map((l) => l.text)).toEqual(a.data().map((l) => l.text));
  });
});

describe("settlement/pg · ثبتِ شکستِ تکرارپذیر · خرابی", () => {
  it("خطای پایگاه ⇒ STORE_FAILURE ثابت و بی‌نشتِ پیامِ خام", async () => {
    const s = stub(() => [], new Error("password=hunter2 host=db.internal"));
    const r = await s.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9, expectedAttempts: 0 });
    expect(r).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    expect(JSON.stringify(r)).not.toMatch(/hunter2|db\.internal/);
  });

  it("UPDATE بی‌ردیف (ردیفِ قفل‌شده ناپدید شد) ⇒ STORE_FAILURE، نه موفقیتِ کاذب", async () => {
    const s = stub((t) => (isSelect(t) ? [row({ attempts: "2" })] : []));
    expect(await s.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9, expectedAttempts: 2 })).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
  });

  it("شمارندهٔ خرابِ ردیف (غیرعدد) ⇒ STORE_FAILURE", async () => {
    const s = stub((t) => (isSelect(t) ? [row({ attempts: "abc" })] : []));
    expect(await s.outbox.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9, expectedAttempts: 2 })).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
  });
});
