/**
 * settlement-pending · برگشتِ رسمی (`down`) — واحد (بی‌پایگاه؛ ADR-0048، ب‑۲‑۲‑۱).
 * دو دسته:
 *  ۱) **همخوانیِ ایستا میانِ مهاجرت و برگشتش:** از متنِ `MIGRATIONS` استخراج می‌شود چه ساخته می‌شود و آزمون می‌سنجد برگشت همه‌اش را — به ترتیبِ امن — برمی‌دارد؛
 *     پس مهاجرتِ ۰۰۰۲ی که چیزی بسازد و برگشتش را فراموش کند همین‌جا قرمز می‌شود (نه در تولید).
 *  ۲) **توالیِ دقیقِ دستورها** با پایگاهِ جعلی که هر SQL را ثبت می‌کند: بی‌کار، شکست‌بسته پیش از هر DDL، ترتیبِ DDL، نگاشتِ خطا بی‌نشت.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { createPendingDeadIndex } from "./index";
import { down } from "./migrate";
import { MIGRATIONS, ROLLBACK_NAMES, migrationChecksum, renderStatement, rollbackStatements } from "./migrations";

const first = MIGRATIONS[0] as NonNullable<(typeof MIGRATIONS)[number]>;
const S = "{{schema}}";
const rollbackOf = (name: string): readonly string[] => {
  const r = rollbackStatements(name);
  if (r === undefined) throw new Error(`برگشتی برای ${name} نیست`);
  return r;
};
const idx = (statements: readonly string[], re: RegExp): number => statements.findIndex((s) => re.test(s));

describe("settlement-pending · برگشت ⇄ مهاجرت (ایستا)", () => {
  it("هر مهاجرت دقیقاً یک برگشت دارد و برعکس؛ نامِ ناشناخته/نمونه‌ای از Object.prototype برگشت ندارد", () => {
    expect([...ROLLBACK_NAMES].sort()).toEqual(MIGRATIONS.map((m) => m.name).sort());
    for (const name of ["", "0002_from_the_future", "__proto__", "constructor", "toString", "hasOwnProperty"]) expect(rollbackStatements(name), name).toBeUndefined();
  });

  it("هر جدول/تابع/TRIGGER/ایندکسی که مهاجرت می‌سازد، برگشت برمی‌دارد (استخراج از متنِ نصب)", () => {
    for (const m of MIGRATIONS) {
      const up = m.statements.join("\n");
      const downText = rollbackOf(m.name).join("\n");
      const tables = [...up.matchAll(/CREATE TABLE \{\{schema\}\}\.(\w+)/g)].map((x) => x[1] as string);
      const functions = [...up.matchAll(/CREATE FUNCTION \{\{schema\}\}\.(\w+)\(/g)].map((x) => x[1] as string);
      const triggers = [...up.matchAll(/CREATE TRIGGER (\w+)[\s\S]*?ON \{\{schema\}\}\.(\w+)/g)].map((x) => ({ name: x[1] as string, table: x[2] as string }));
      const indexes = [...up.matchAll(/CREATE INDEX (\w+) ON \{\{schema\}\}\.(\w+)/g)].map((x) => ({ name: x[1] as string, table: x[2] as string }));
      expect(tables.length, "نصب باید دست‌کم یک جدول بسازد (استخراج کار می‌کند)").toBeGreaterThan(0);
      expect(functions.length).toBeGreaterThan(0);
      expect(triggers.length).toBeGreaterThan(0);
      expect(indexes.length).toBeGreaterThan(0);

      for (const t of tables) expect(downText, `DROP TABLE ${t}`).toContain(`DROP TABLE IF EXISTS ${S}.${t}`);
      for (const f of functions) expect(downText, `DROP FUNCTION ${f}`).toContain(`DROP FUNCTION IF EXISTS ${S}.${f}()`);
      for (const t of triggers) {
        // TRIGGERِ روی جدولی که خودِ برگشت حذف می‌کند با جدول می‌رود؛ بقیه باید صریح حذف شوند.
        if (tables.includes(t.table)) continue;
        expect(downText, `DROP TRIGGER ${t.name}`).toContain(`DROP TRIGGER IF EXISTS ${t.name} ON ${S}.${t.table}`);
      }
      for (const i of indexes) expect(tables.includes(i.table), `ایندکسِ ${i.name} باید با جدولش برود یا صریح حذف شود`).toBe(true);
    }
  });

  it("ترتیب: قفل پیش از هر DROP؛ TRIGGERهای outbox/ack ← جدول ← توابع؛ تابع تا TRIGGERِ مصرف‌کننده‌اش هست حذف نمی‌شود", () => {
    for (const m of MIGRATIONS) {
      const up = m.statements.join("\n");
      const d = rollbackOf(m.name);
      // هم‌قفلِ نصب: همان جدول‌ها، با قفلِ قوی‌تر (DROP TRIGGER ACCESS EXCLUSIVE می‌خواهد)
      expect(d[0]).toBe("SET LOCAL lock_timeout = '15s'");
      const upLock = /LOCK TABLE ([^\n]+?) IN SHARE ROW EXCLUSIVE MODE/.exec(up)?.[1];
      expect(upLock, "نصب باید LOCK TABLE داشته باشد").toBeDefined();
      expect(d[1]).toBe(`LOCK TABLE ${upLock} IN ACCESS EXCLUSIVE MODE`);
      // پیش از اولین DROP دقیقاً همین دو دستور (هیچ قفلِ اضافه‌ای، و جدولِ نمایه هرگز پیش از DROP قفلِ جدا نمی‌گیرد)
      expect(d.findIndex((s) => /^DROP /.test(s))).toBe(2);
      expect(d.filter((s) => /^LOCK /.test(s))).toHaveLength(1);

      const tableAt = idx(d, /^DROP TABLE /);
      const lastTriggerAt = d.map((s, i) => (/^DROP TRIGGER /.test(s) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
      expect(lastTriggerAt).toBeGreaterThan(1);
      expect(tableAt).toBeGreaterThan(lastTriggerAt);
      for (const [i, s] of d.entries()) {
        const fn = /^DROP FUNCTION IF EXISTS \{\{schema\}\}\.(\w+)\(\)/.exec(s)?.[1];
        if (fn === undefined) continue;
        expect(i, `تابع ${fn} پس از جدول`).toBeGreaterThan(tableAt);
        // هر TRIGGERِ نصب که این تابع را اجرا می‌کند: یا صریح پیش‌تر حذف می‌شود یا روی جدولی است که پیش‌تر رفته است.
        for (const t of up.matchAll(/CREATE TRIGGER (\w+)[\s\S]*?ON \{\{schema\}\}\.(\w+)[\s\S]*?EXECUTE FUNCTION \{\{schema\}\}\.(\w+)\(\)/g)) {
          if (t[3] !== fn) continue;
          const explicit = idx(d, new RegExp(`^DROP TRIGGER IF EXISTS ${t[1] as string} `));
          expect(explicit >= 0 ? explicit < i : tableAt < i, `TRIGGER ${t[1] as string} پیش از تابع ${fn}`).toBe(true);
        }
      }
    }
  });

  it("بدونِ CASCADE؛ بدونِ هیچ DML/DDLِ دیگر و بی‌تغییرِ ساختارِ outbox/ack؛ همه‌چیز با شِما نقل‌قول‌شده", () => {
    for (const m of MIGRATIONS) {
      for (const s of rollbackOf(m.name)) {
        expect(s, s).not.toMatch(/\bCASCADE\b/i);
        expect(s, s).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|DISABLE)\b/i);
        expect(s, s).not.toMatch(/\bON\s+(?!\{\{schema\}\}\.)/);
        expect(s, s).not.toMatch(/\bDROP\s+(TABLE|FUNCTION)\s+IF\s+EXISTS\s+(?!\{\{schema\}\}\.)/);
        expect(s, s).not.toMatch(/\bDROP\s+(?!TRIGGER|TABLE|FUNCTION)/);
        // تنها جدول‌هایی که DROP می‌شوند، از آنِ همین ماژول‌اند، نه outbox/ack
        expect(s, s).not.toMatch(/\bDROP\s+TABLE[^\n]*settlement_(outbox|dead_ack)\b/);
        expect(renderStatement(s, "x_schema")).not.toContain("{{schema}}");
      }
    }
  });
});

// ───────────────────────── پایگاهِ جعلیِ ثبت‌کننده ─────────────────────────
type Row = Record<string, unknown>;
type Opts = Readonly<{ ledger: "absent" | readonly Row[]; tables?: boolean; failAt?: RegExp; failWith?: unknown }>;
type Query = Parameters<PgDialect["sqlToQuery"]>[0];
function fake(o: Opts, onExecute?: (text: string, params: readonly unknown[]) => void): { db: LedgerDatabase; log: string[]; ledger: () => readonly Row[]; ledgerDropped: () => boolean } {
  const dialect = new PgDialect();
  const log: string[] = [];
  let ledger: Row[] = o.ledger === "absent" ? [] : o.ledger.map((r) => ({ ...r }));
  let present = o.ledger !== "absent";
  let dropped = false;
  const execute = (query: Query): Promise<{ rows: Row[] }> => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    log.push(text);
    onExecute?.(text, params);
    if (o.failAt?.test(text)) return Promise.reject(o.failWith ?? new Error("secret-connection-detail host=db user=u"));
    if (/to_regclass/.test(text)) {
      if (String(params[0]).includes("settlement_pending_migration_ledger")) return Promise.resolve({ rows: [{ present }] });
      return Promise.resolve({ rows: [{ outbox: o.tables !== false, ack: o.tables !== false }] });
    }
    if (/^SELECT name, checksum/.test(text)) return Promise.resolve({ rows: ledger.map((r) => ({ ...r })) });
    if (/^DELETE FROM/.test(text)) {
      ledger = ledger.filter((r) => r["name"] !== params[0]);
      return Promise.resolve({ rows: [] });
    }
    if (/^DROP TABLE "[^"]+"\."settlement_pending_migration_ledger"/.test(text)) {
      present = false;
      dropped = true;
    }
    return Promise.resolve({ rows: [] });
  };
  const db = { execute, transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run({ execute }) } as unknown as LedgerDatabase;
  return { db, log, ledger: () => ledger, ledgerDropped: () => dropped };
}
const applied = (): Row[] => [{ name: first.name, checksum: migrationChecksum(first) }];
const isDdl = (s: string): boolean => /^(DROP|SET LOCAL|LOCK TABLE)/.test(s);
const SCHEMA = "settlement";
const q = (s: string): string => renderStatement(s, SCHEMA);

describe("settlement-pending · down: توالیِ دستورها (پایگاهِ جعلی)", () => {
  it("نصب‌نشده (بی‌دفتر) ⇒ بی‌کار: فقط دو قفلِ مشورتی و یک to_regclass؛ هیچ DDL/DML", async () => {
    const f = fake({ ledger: "absent" });
    expect(await down(f.db, SCHEMA)).toEqual({ ok: true, value: { reverted: [] } });
    expect(f.log).toHaveLength(3);
    expect(f.log[0]).toContain("pg_advisory_xact_lock");
    expect(f.log[1]).toContain("pg_advisory_xact_lock");
    expect(f.log.some(isDdl)).toBe(false);
  });

  it("قفل‌های مشورتی همان ترتیبِ migrate(): settlement ← pending (پیش از هر چیز)", async () => {
    const keys: unknown[] = [];
    const f = fake({ ledger: applied() }, (text, params) => {
      if (text.includes("pg_advisory_xact_lock")) keys.push(params[0]);
    });
    await down(f.db, SCHEMA);
    expect(keys).toEqual([`settlement:migrate:${SCHEMA}`, `settlement-pending:migrate:${SCHEMA}`]);
    expect(f.log.findIndex(isDdl)).toBeGreaterThan(1);
  });

  it("نصب‌شده ⇒ توالیِ دقیق: بازبینیِ دفتر ← پیش‌نیاز ← برگشتِ مهاجرت ← حذفِ ردیفِ دفتر ← خواندنِ دفتر ← حذفِ دفترِ خالی", async () => {
    const f = fake({ ledger: applied() });
    expect(await down(f.db, SCHEMA)).toEqual({ ok: true, value: { reverted: [first.name] } });
    const rest = f.log.slice(2); // پس از دو قفلِ مشورتی
    const n = rollbackOf(first.name).length;
    expect(rest[0]).toContain("to_regclass");
    expect(rest[1]).toMatch(/^SELECT name, checksum/);
    expect(rest[2]).toContain("to_regclass");
    expect(rest.slice(3, 3 + n)).toEqual(rollbackOf(first.name).map(q));
    const after = rest.slice(3 + n);
    expect(after).toHaveLength(3);
    expect(after[0]).toMatch(/^DELETE FROM "settlement"\."settlement_pending_migration_ledger" WHERE name = \$1/);
    expect(after[1]).toMatch(/^SELECT name, checksum/);
    expect(after[2]).toBe('DROP TABLE "settlement"."settlement_pending_migration_ledger"');
    expect(f.ledgerDropped()).toBe(true);
    expect(f.ledger()).toEqual([]);
  });

  it("دفترِ موجود ولی خالی ⇒ فقط خودِ دفتر حذف می‌شود؛ هیچ DDLی روی outbox/ack", async () => {
    const f = fake({ ledger: [] });
    expect(await down(f.db, SCHEMA)).toEqual({ ok: true, value: { reverted: [] } });
    expect(f.log.filter(isDdl)).toEqual(['DROP TABLE "settlement"."settlement_pending_migration_ledger"']);
  });

  it("checksum ناهمخوان ⇒ MIGRATION_TAMPERED و هیچ DDL/DML (شکست‌بسته پیش از هر تغییر)", async () => {
    const f = fake({ ledger: [{ name: first.name, checksum: "0".repeat(64) }] });
    expect(await down(f.db, SCHEMA)).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
    expect(f.log.some((s) => isDdl(s) || /^DELETE/.test(s))).toBe(false);
    expect(f.ledger()).toHaveLength(1);
  });

  it("مهاجرتِ ناشناخته در دفتر ⇒ MIGRATION_UNKNOWN و هیچ DDL/DML", async () => {
    const f = fake({ ledger: [...applied(), { name: "0002_from_the_future", checksum: "x" }] });
    expect(await down(f.db, SCHEMA)).toMatchObject({ ok: false, error: { code: "MIGRATION_UNKNOWN" } });
    expect(f.log.some((s) => isDdl(s) || /^DELETE/.test(s))).toBe(false);
  });

  it("جدول‌های settlement نیست ولی دفتر هست ⇒ NOT_MIGRATED بی‌هیچ DDL", async () => {
    const f = fake({ ledger: applied(), tables: false });
    expect(await down(f.db, SCHEMA)).toMatchObject({ ok: false, error: { code: "NOT_MIGRATED" } });
    expect(f.log.some(isDdl)).toBe(false);
  });

  it("شکست در میانهٔ DDL ⇒ هیچ دستورِ بعدی اجرا نمی‌شود و ردیفِ دفتر حذف نمی‌شود", async () => {
    const f = fake({ ledger: applied(), failAt: /^DROP TABLE IF EXISTS/ });
    expect(await down(f.db, SCHEMA)).toMatchObject({ ok: false, error: { code: "DB_ERROR" } });
    const dropIdx = f.log.findIndex((s) => /^DROP TABLE IF EXISTS/.test(s));
    expect(f.log).toHaveLength(dropIdx + 1);
    expect(f.log.some((s) => /^DELETE/.test(s))).toBe(false);
    expect(f.ledger()).toHaveLength(1);
  });

  it("خطای pg: فقط SQLSTATE در خروجی؛ هرگز متنِ SQL، نامِ شِما یا جزئیاتِ اتصال", async () => {
    const pgErr = Object.assign(new Error("cannot drop table pending_secret_schema.x because other objects depend on it; host=db password=hunter2"), { code: "2BP01" });
    const f = fake({ ledger: applied(), failAt: /^DROP TABLE IF EXISTS/, failWith: { cause: pgErr } });
    const r = await down(f.db, "pending_secret_schema");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: "DB_ERROR", pgCode: "2BP01" });
    const text = JSON.stringify(r.error);
    for (const leak of ["pending_secret_schema", "hunter2", "host=db", "DROP TABLE", "secret-connection-detail"]) expect(text).not.toContain(leak);

    const g = fake({ ledger: applied(), failAt: /^LOCK TABLE/, failWith: { cause: Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }) } });
    expect(await down(g.db, SCHEMA)).toMatchObject({ ok: false, error: { code: "DB_ERROR", pgCode: "55P03" } });
    expect(g.log.filter((s) => /^DROP/.test(s))).toEqual([]);
  });

  it("هرگز نمی‌پرتابد: حتی اگر پایگاه همه‌چیز را پرتاب کند، نتیجهٔ بسته برمی‌گردد", async () => {
    const f = fake({ ledger: applied(), failAt: /./ });
    await expect(down(f.db, SCHEMA)).resolves.toMatchObject({ ok: false, error: { code: "DB_ERROR" } });
  });

  it("رابطِ عمومی: index.down تابع است و شیءِ فروشگاه freeze است؛ شِمای نامعتبر هیچ نمایه‌ای نمی‌سازد", async () => {
    const f = fake({ ledger: "absent" });
    const made = createPendingDeadIndex(f.db);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(typeof made.value.down).toBe("function");
    expect(Object.isFrozen(made.value)).toBe(true);
    expect(await made.value.down()).toEqual({ ok: true, value: { reverted: [] } });
    expect(createPendingDeadIndex(f.db, { schema: "Public" }).ok).toBe(false);
  });
});
