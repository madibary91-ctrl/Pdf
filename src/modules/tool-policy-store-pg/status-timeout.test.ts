/**
 * `status()` سقفِ سمتِ پایگاه دارد (ADR-0074؛ بستنِ بندِ ۴.۳ یادداشتِ تحویل ۰۰۷۲): مثلِ چهار عملیاتِ پورت، نخستین دستورِ تراکنشِ فقط‌خواندنیِ آن
 * `set_config('statement_timeout' …, 'lock_timeout' …)` تراکنشی است، با **همان** مقدارِ `statementTimeoutMs` و **همان** متنِ SQL.
 * بی‌پایگاه (پایگاهِ ساختگی)؛ آزمون‌های PostgreSQL واقعی در status-timeout.pg.test.ts.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createPgPolicyVersionStore, STORE_LIMITS } from "./index";
import { MIGRATIONS, migrationChecksum } from "./migrations";
import type { PolicyPgDatabase, PolicyPgExecutor } from "./types";

const dialect = new PgDialect();
const ledgerOk = [{ name: "0001_init", checksum: migrationChecksum(MIGRATIONS[0]!) }];
const pgErr = (code: string): Error => Object.assign(new Error("SECRET-pg-text password=hunter2 SELECT * FROM"), { code });

type Logged = { text: string; params: unknown[] };
type Answer = { rows: Record<string, unknown>[] } | Error;

/** پایگاهِ ساختگی که به‌جای شمارهٔ دستور، با متنِ دستور پاسخ می‌دهد (به ترتیبِ داخلیِ status وابسته نیست). */
function fake(answer: (text: string) => Answer) {
  const log: Logged[] = [];
  const configs: unknown[] = [];
  const ex: PolicyPgExecutor = {
    execute: async (q: SQL) => {
      const r = dialect.sqlToQuery(q);
      log.push({ text: r.sql, params: r.params });
      const out = answer(r.sql);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  const db: PolicyPgDatabase = {
    execute: ex.execute,
    transaction: async (run, config) => {
      configs.push(config);
      return run(ex);
    },
  };
  return { db, log, configs };
}

const migratedAnswer = (text: string): Answer => {
  if (text.includes("pg_namespace")) return { rows: [{ present: 1 }] };
  if (text.includes("to_regclass") && text.includes("IS NOT NULL")) return { rows: [{ present: true }] };
  if (text.includes("migration_ledger")) return { rows: ledgerOk };
  if (text.includes("pg_constraint")) return { rows: [] };
  if (text.includes("pg_trigger")) return { rows: [] };
  if (text.includes("count(*)")) return { rows: [{ n: "0", m: null }] };
  return { rows: [] };
};

const store = (db: PolicyPgDatabase, options: Record<string, unknown> = {}) => {
  const made = createPgPolicyVersionStore(db, { schema: "tp", ...options });
  if (!made.ok) throw new Error(`make: ${made.error.code}`);
  return made.value;
};

describe("tool-policy-store-pg · status() مهلتِ سمتِ پایگاه دارد", () => {
  it("نخستین دستورِ status همان set_config مهلت‌هاست (statement_timeout و lock_timeout) با مقدارِ صریح؛ تراکنشِ read only", async () => {
    const t = fake(migratedAnswer);
    const r = await store(t.db, { statementTimeoutMs: 777 }).status();
    expect(r.ok).toBe(true);
    expect(t.log[0]!.text).toContain("set_config('statement_timeout'");
    expect(t.log[0]!.text).toContain("set_config('lock_timeout'");
    expect(t.log[0]!.params).toEqual(["777", "777"]);
    expect(t.configs).toEqual([{ accessMode: "read only" }]);
  });

  it("بدونِ گزینه: پیش‌فرضِ ۵۰۰۰ (همان پیش‌فرضِ چهار عملیات)", async () => {
    const t = fake(migratedAnswer);
    await store(t.db).status();
    expect(t.log[0]!.params).toEqual([String(STORE_LIMITS.defaultTimeoutMs), String(STORE_LIMITS.defaultTimeoutMs)]);
    expect(STORE_LIMITS.defaultTimeoutMs).toBe(5000);
  });

  it.each([STORE_LIMITS.minTimeoutMs, 1234, STORE_LIMITS.maxTimeoutMs])("مقدارِ %i دقیقاً به هر دو مهلت می‌رسد", async (ms) => {
    const t = fake(migratedAnswer);
    await store(t.db, { statementTimeoutMs: ms }).status();
    expect(t.log[0]!.params).toEqual([String(ms), String(ms)]);
  });

  it("متنِ SQLِ مهلت در status با latest() یکسان است (یک منبعِ حقیقت؛ انحرافِ بی‌صدا ممکن نیست)", async () => {
    const a = fake(migratedAnswer);
    await store(a.db, { statementTimeoutMs: 321 }).status();
    const b = fake(migratedAnswer);
    await store(b.db, { statementTimeoutMs: 321 }).latest();
    expect(a.log[0]).toEqual(b.log[0]);
  });

  it("مهلت پیش از هر دستورِ دیگر است؛ حتی وقتی شِما نیست (راهِ زودبازگشت هم سقف دارد)", async () => {
    const t = fake(() => ({ rows: [] }));
    const r = await store(t.db, { statementTimeoutMs: 400 }).status();
    expect(r).toMatchObject({ ok: true, value: { schemaExists: false, ready: false } });
    expect(t.log[0]!.text).toContain("set_config('statement_timeout'");
    expect(t.log[0]!.params).toEqual(["400", "400"]);
    expect(t.log[1]!.text).toContain("pg_namespace");
  });

  it("set_config فقط یک بار و پیش از همهٔ دستورهای دیگرِ status می‌آید", async () => {
    const t = fake(migratedAnswer);
    await store(t.db).status();
    expect(t.log.findIndex((q) => q.text.includes("set_config("))).toBe(0);
    expect(t.log.filter((q) => q.text.includes("set_config("))).toHaveLength(1);
    expect(t.log.length).toBeGreaterThan(3);
  });

  it.each(["55P03", "57014", "08006"])("خطای پایگاه %s در status ⇒ Result شکست با کدِ ثابت و بی‌افشا؛ هرگز پرتاب نمی‌شود", async (code) => {
    const t = fake((text) => (text.includes("count(*)") ? pgErr(code) : migratedAnswer(text)));
    const r = await store(t.db).status();
    expect(r).toMatchObject({ ok: false, error: { code: "DB_ERROR", pgCode: code } });
    expect(JSON.stringify(r)).not.toMatch(/hunter2|SECRET|SELECT/);
  });

  it("خرابیِ خودِ set_config ⇒ شکستِ بسته و هیچ دستورِ بعدی اجرا نمی‌شود (بی‌سقف ادامه نمی‌دهیم)", async () => {
    const t = fake((text) => (text.includes("set_config(") ? pgErr("57014") : migratedAnswer(text)));
    const r = await store(t.db).status();
    expect(r).toMatchObject({ ok: false, error: { code: "DB_ERROR", pgCode: "57014" } });
    expect(t.log).toHaveLength(1);
  });

  it("معناشناسیِ وضعیت دست‌نخورده: دفترِ نبوده ⇒ همه معلق، شِما هست", async () => {
    const none = fake((text) => (text.includes("pg_namespace") ? { rows: [{ present: 1 }] } : { rows: [{ present: false }] }));
    expect(await store(none.db).status()).toMatchObject({ ok: true, value: { schemaExists: true, applied: [], pending: ["0001_init"], ready: false } });
  });
});
