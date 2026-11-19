/**
 * اجارهٔ رکوردهای سررسیده روی آداپتور PostgreSQL، بی‌پایگاه (ADR-0029): مرزِ اعتبارسنجی، شکلِ SQL (اتمی، `SKIP LOCKED`، بی‌داده در متن)،
 * خرابیِ پایگاه و ردیفِ خراب. پایگاهِ جعلی هر دستور را ثبت می‌کند؛ رفتارِ واقعی و هم‌زمانی در `claim.pg.test.ts` است.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { LedgerDatabase, LedgerTransactionConfig } from "@/modules/ledger";
import { MIGRATIONS, migrationChecksum } from "./migrations";
import { createPgSettlementOutbox } from "./store";

const dialect = new PgDialect();

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenant_id: "t1", account_id: "a1", reservation_id: "r1", unit: "IRR_MICROS", reserved: "500", created_at_ms: "1000", expires_at_ms: "61000", due_at_ms: "40000",
  orphan_remainder: "forfeit", state: "open", charge_attempt_id: null, charge_amount: null, close_remainder: null, close_origin: null, attempts: "0",
  last_error_code: null, dead_reason: null, settled_at_ms: null, k_due: "1000", ...over,
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

describe("settlement/pg · اجاره (claimDue) · مرز: ورودی نامعتبر هرگز به پایگاه نمی‌رسد", () => {
  it.each([
    [null],
    [undefined],
    [{}],
    [{ nowMs: 1, limit: 1 }],
    [{ nowMs: 1, limit: 0, leaseMs: 1 }],
    [{ nowMs: 1, limit: 1001, leaseMs: 1 }],
    [{ nowMs: 1, limit: 1, leaseMs: 0 }],
    [{ nowMs: 1, limit: 1, leaseMs: 86_400_001 }],
    [{ nowMs: -1, limit: 1, leaseMs: 1 }],
    [{ nowMs: Number.MAX_SAFE_INTEGER, limit: 1, leaseMs: 1 }],
    [{ nowMs: "1", limit: 1, leaseMs: 1 }],
  ])("%j ⇒ INVALID_INPUT و صفر تراکنش", async (bad) => {
    const s = stub(() => []);
    const r = await s.outbox.claimDue(bad as never);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(s.configs).toHaveLength(0);
    expect(s.data()).toHaveLength(0);
  });

  it("getterِ بدجنس: هر میدان فقط یک‌بار خوانده می‌شود (بین اعتبارسنجی و استفاده تغییر نمی‌کند)", async () => {
    let reads = 0;
    const evil = { nowMs: 10_000, limit: 5, get leaseMs() { reads += 1; return reads === 1 ? 30_000 : 1; } };
    const s = stub(() => [row()]);
    const r = await s.outbox.claimDue(evil);
    expect(reads).toBe(1);
    expect(r.ok).toBe(true);
    expect(s.data()[0]?.params).toEqual([10_000, 5, 40_000]);
  });
});

describe("settlement/pg · اجاره (claimDue) · شکلِ SQL", () => {
  it("یک تراکنشِ نوشتنی و یک دستورِ دادهٔ اتمی؛ SKIP LOCKED و MATERIALIZED؛ مقدارها فقط پارامتر (نه در متن)", async () => {
    const s = stub(() => [row()]);
    const r = await s.outbox.claimDue({ nowMs: 123_456_789, limit: 37, leaseMs: 424_242 });
    expect(r.ok).toBe(true);
    expect(s.configs).toEqual([undefined]); // خواندنی-فقط نیست (می‌نویسد)
    const data = s.data();
    expect(data).toHaveLength(1);
    const text = data[0]?.text ?? "";
    expect(text).toMatch(/for update skip locked/i);
    expect(text).toMatch(/materialized/i);
    expect(text).toMatch(/order by due_at_ms, tenant_id, account_id, reservation_id/i);
    expect(text).toMatch(/state in \('open', 'settling'\)/i);
    expect(text).not.toMatch(/123456789|424242|547\d{3}|\b37\b/);
    expect(data[0]?.params).toEqual([123_456_789, 37, 123_456_789 + 424_242]);
    // فقط due_at_ms نوشته می‌شود: وضعیت، شمارنده و قصدها در SET نیستند.
    const set = /\bset\b([\s\S]*?)\bfrom\b/i.exec(text.slice(text.search(/update/i)));
    expect(set?.[1]).toMatch(/due_at_ms/i);
    expect(set?.[1]).not.toMatch(/attempts|state|charge|close|last_error|dead_reason|settled/i);
  });

  it("خروجی بر پایهٔ ترتیبِ ردیف‌های پاسخ نگاشت می‌شود و ردیفِ کمکی k_due به رکورد نشت نمی‌کند", async () => {
    const s = stub(() => [row({ reservation_id: "r1" }), row({ reservation_id: "r2", attempts: "3" })]);
    const r = await s.outbox.claimDue({ nowMs: 50_000, limit: 5, leaseMs: 1_000 });
    expect(r.ok && r.value.map((e) => e.reservationId)).toEqual(["r1", "r2"]);
    expect(r.ok && r.value[1]?.attempts).toBe(3);
    expect(r.ok && Object.keys(r.value[0] ?? {})).not.toContain("k_due");
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
  });
});

describe("settlement/pg · اجاره (claimDue) · خرابی", () => {
  it("خطای پایگاه ⇒ STORE_FAILURE با پیامِ ثابت (بی‌پژواکِ پیامِ پایگاه)", async () => {
    const s = stub(() => [], new Error("password=hunter2 host=10.0.0.5"));
    const r = await s.outbox.claimDue({ nowMs: 1, limit: 1, leaseMs: 1 });
    expect(r).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    expect(JSON.stringify(r)).not.toMatch(/hunter2|10\.0\.0\.5/);
  });

  it.each([
    ["state ناشناخته", { state: "weird" }],
    ["due_at_ms منفی", { due_at_ms: "-5" }],
    ["due_at_ms ناایمن", { due_at_ms: "99999999999999999" }],
    ["attempts غیرعدد", { attempts: "x" }],
    ["شناسهٔ تهی", { tenant_id: null }],
  ])("ردیفِ خراب (%s) ⇒ STORE_FAILURE؛ هیچ رکوردِ نادرستی به رفتگر داده نمی‌شود", async (_n, over) => {
    const s = stub(() => [row(), row({ reservation_id: "r2", ...over })]);
    const r = await s.outbox.claimDue({ nowMs: 1, limit: 5, leaseMs: 1 });
    expect(r).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
  });
});
