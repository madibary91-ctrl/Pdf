/**
 * تأیید رسیدگی به مرده‌ها روی آداپتور PostgreSQL، بی‌پایگاه (ADR-0025): مرزِ اعتبارسنجی، خرابیِ پایگاه، شکلِ SQL، و قفلِ مهاجرتِ 0002.
 * پایگاهِ جعلی هر دستور را ثبت می‌کند؛ رفتارِ واقعی در `dead-ack.pg.test.ts` است.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { LedgerDatabase, LedgerTransactionConfig } from "@/modules/ledger";
import { MIGRATIONS, migrationChecksum, renderStatement } from "./migrations";
import { createPgSettlementOutbox } from "./store";

const dialect = new PgDialect();
const REF = { tenantId: "t1", accountId: "a1", reservationId: "r1" };

const DEAD_ROW: Record<string, unknown> = {
  tenant_id: "t1", account_id: "a1", reservation_id: "r1", unit: "IRR_MICROS", reserved: "500", created_at_ms: "1000", expires_at_ms: "61000", due_at_ms: "11000",
  orphan_remainder: "forfeit", state: "dead", charge_attempt_id: null, charge_amount: null, close_remainder: null, close_origin: null, attempts: "0",
  last_error_code: null, dead_reason: "LEDGER_REJECTED", settled_at_ms: "20000",
};

function stub(reply: (text: string, params: readonly unknown[]) => readonly Record<string, unknown>[] = () => [], failWith?: Error) {
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
  return { outbox: made.value, log, configs, data: () => log.filter((l) => !l.text.includes("settlement_migration_ledger")) };
}

describe("settlement/pg · تأیید رسیدگی · مرز: ورودی نامعتبر هرگز به پایگاه نمی‌رسد", () => {
  it("acknowledgeDead و listUnacknowledgedDead با ورودی بد ⇒ INVALID_INPUT و صفر تراکنش", async () => {
    const s = stub();
    const badAcks = [null, undefined, {}, { atMs: -1 }, { atMs: 1.5 }, { atMs: Number.NaN }, { atMs: "1" }, { atMs: Number.MAX_SAFE_INTEGER + 1 }];
    for (const bad of badAcks) expect(await s.outbox.acknowledgeDead(REF, bad as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    for (const bad of [null, undefined, {}, { tenantId: "bad id", accountId: "a", reservationId: "r" }]) expect(await s.outbox.acknowledgeDead(bad as never, { atMs: 1 })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    for (const bad of [null, undefined, {}, { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { limit: "3" }]) expect(await s.outbox.listUnacknowledgedDead(bad as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(s.log).toHaveLength(0);
    expect(s.configs).toHaveLength(0);
  });
});

describe("settlement/pg · تأیید رسیدگی · خطای پایگاه ⇒ STORE_FAILURE (بی‌پرتاب، بی‌نشت)", () => {
  const boom = new Error("password=LEAK-CANARY host=10.0.0.9");
  it.each([
    ["acknowledgeDead", (o: ReturnType<typeof stub>["outbox"]) => o.acknowledgeDead(REF, { atMs: 5 })],
    ["listUnacknowledgedDead", (o: ReturnType<typeof stub>["outbox"]) => o.listUnacknowledgedDead({ limit: 5 })],
  ])("%s: پرتابِ پایگاه با متنِ حساس ⇒ پیامِ ثابت و بی‌پژواک", async (_n, call) => {
    const r = await call(stub(undefined, boom).outbox);
    expect(r).toEqual({ ok: false, error: { code: "STORE_FAILURE", message: "ذخیرهٔ outbox در دسترس نیست." } });
    expect(JSON.stringify(r)).not.toContain("LEAK-CANARY");
  });
  it("ردیفِ خرابِ فهرست (state ناشناخته) ⇒ STORE_FAILURE، نه رکوردِ نادرست", async () => {
    const s = stub(() => [{ ...DEAD_ROW, state: "zzz" }]);
    expect(await s.outbox.listUnacknowledgedDead({ limit: 5 })).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
  });
  it("ردیفِ نبودنِ پس از قفل ⇒ NOT_FOUND؛ ردیفِ غیرمرده ⇒ CONFLICT و هیچ INSERT ای نمی‌رود", async () => {
    const none = stub(() => []);
    expect(await none.outbox.acknowledgeDead(REF, { atMs: 1 })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(none.data().some((l) => /INSERT/i.test(l.text))).toBe(false);
    const open = stub(() => [{ ...DEAD_ROW, state: "open", dead_reason: null, settled_at_ms: null }]);
    expect(await open.outbox.acknowledgeDead(REF, { atMs: 1 })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(open.data().some((l) => /INSERT/i.test(l.text))).toBe(false);
  });
});

describe("settlement/pg · تأیید رسیدگی · شکلِ SQL (روی db جعلی)", () => {
  it("فهرست: فقط‌خواندنی، بی‌قفل، ضدپیوند با جدول تأیید، ترتیبِ صریح و limit پارامتر", async () => {
    const s = stub(() => [DEAD_ROW]);
    expect(await s.outbox.listUnacknowledgedDead({ limit: 7 })).toMatchObject({ ok: true });
    const q = s.data()[0] as { text: string; params: unknown[] };
    expect(s.configs).toEqual([{ accessMode: "read only" }]);
    expect(q.text).toContain('FROM "zz"."settlement_outbox" o');
    expect(q.text).toContain('"zz"."settlement_dead_ack"');
    expect(q.text).toMatch(/not exists/i);
    expect(q.text).toMatch(/o\.state = 'dead'/);
    expect(q.text).toMatch(/order by o\.settled_at_ms, o\.tenant_id, o\.account_id, o\.reservation_id/i);
    expect(q.text).not.toMatch(/for update/i);
    expect(q.params).toEqual([7]);
  });
  it("تأیید: نوشتن (نه فقط‌خواندنی)، نخست SELECT … FOR UPDATE روی رکورد، سپس INSERT … ON CONFLICT DO NOTHING؛ همهٔ مقدارها پارامتر", async () => {
    const s = stub((t) => (/for update/i.test(t) ? [DEAD_ROW] : []));
    expect(await s.outbox.acknowledgeDead(REF, { atMs: 123456789 })).toEqual({ ok: true, value: { replayed: true } }); // INSERT چیزی برنگرداند ⇒ پیش‌تر تأیید شده بود
    expect(s.configs).toEqual([undefined]);
    const [sel, ins] = s.data() as [{ text: string; params: unknown[] }, { text: string; params: unknown[] }];
    expect(sel.text).toMatch(/for update/i);
    expect(ins.text).toMatch(/^insert into "zz"\."settlement_dead_ack"/i);
    expect(ins.text).toMatch(/on conflict \(tenant_id, account_id, reservation_id\) do nothing/i);
    expect(ins.params).toEqual(["t1", "a1", "r1", 123456789]);
    for (const l of s.data()) {
      expect(l.text).not.toContain("123456789");
      expect(l.text).not.toMatch(/'t1'|'a1'|'r1'/);
    }
    const fresh = stub((t) => (/for update/i.test(t) ? [DEAD_ROW] : /insert/i.test(t) ? [{ inserted: 1 }] : []));
    expect(await fresh.outbox.acknowledgeDead(REF, { atMs: 1 })).toEqual({ ok: true, value: { replayed: false } });
  });
});

describe("settlement/pg · مهاجرت 0002 (قفل‌شده)", () => {
  const m = MIGRATIONS[1] as (typeof MIGRATIONS)[number];
  const all = m.statements.join("\n");
  it("نام، شمارِ دستورها و checksum قفل است؛ 0001 دست‌نخورده می‌ماند (checksum آن در unit.test.ts قفل است)", () => {
    expect(m.name).toBe("0002_dead_ack");
    expect(m.statements).toHaveLength(4);
    expect(migrationChecksum(m)).toBe("e10d9fe8e6c89f5d93e5dc92a3bf59c8d41517541c28f9f8f979a473968c54bb");
  });
  it("افزایشی و ایمن: جدولِ تازه با کلیدِ سه‌بخشی، TRIGGERِ نوشتن‌یک‌بار و ضدTRUNCATE؛ بی‌FK، بی‌DROP/DELETE/ALTER، بی‌now()", () => {
    expect(all).toMatch(/CREATE TABLE \{\{schema\}\}\.settlement_dead_ack/);
    expect(all).toMatch(/PRIMARY KEY \(tenant_id, account_id, reservation_id\)/);
    expect(all).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON \{\{schema\}\}\.settlement_dead_ack/);
    expect(all).toMatch(/BEFORE TRUNCATE ON \{\{schema\}\}\.settlement_dead_ack/);
    expect(all).toMatch(/o\.state = 'dead'/);
    expect(all).not.toMatch(/FOREIGN KEY|REFERENCES/i);
    expect(all).not.toMatch(/DROP\s|DELETE\s+FROM|ALTER\s|TRUNCATE\s+TABLE/i);
    expect(all).not.toMatch(/\bnow\s*\(/i);
    for (const st of m.statements) expect(renderStatement(st, "zz")).not.toContain("{{schema}}");
  });
  it("ستونِ زمان از دامنهٔ settlement_count است (هم‌ارز صحیحِ ایمنِ نامنفی) و NOT NULL", () => {
    expect(all).toMatch(/acked_at_ms \{\{schema\}\}\.settlement_count NOT NULL/);
  });
});
