/**
 * settlement-pending · down با **چند مهاجرت** (واحد، بی‌پایگاه؛ ADR-0048). امروز فقط `0001` هست و ترتیبِ برگشت با یک عضو دیده نمی‌شود؛ پس فهرستِ
 * مهاجرت‌ها و برگشت‌ها در همین فایل با `vi.mock` جایگزین می‌شود تا قراردادِ «معکوس، فقط اعمال‌شده‌ها، پیش از اولین DDL شکست‌بسته» از همین حالا قفل باشد
 * (مهاجرتِ ۰۰۰۲ی که فردا اضافه شود نباید ترتیب را بی‌آزمون بگذارد). به SQL واقعیِ ۰۰۰۱ دست نمی‌زند.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";

const fakeMigrations = vi.hoisted(() => [
  { name: "0001_a", statements: ["SELECT 1"] },
  { name: "0002_b", statements: ["SELECT 2"] },
  { name: "0003_c", statements: ["SELECT 3"] },
]);
const rollbacks = vi.hoisted(() => new Map<string, readonly string[]>());

vi.mock("./migrations", async (importOriginal) => {
  const real = await importOriginal<typeof import("./migrations")>();
  return { ...real, MIGRATIONS: fakeMigrations, rollbackStatements: (name: string) => rollbacks.get(name) };
});

import { down } from "./migrate";
import { migrationChecksum } from "./migrations";

type Row = Record<string, unknown>;
function fake(applied: readonly string[]): { db: LedgerDatabase; log: string[]; ledger: () => string[] } {
  const dialect = new PgDialect();
  const log: string[] = [];
  let ledger = fakeMigrations.filter((m) => applied.includes(m.name)).map((m) => ({ name: m.name, checksum: migrationChecksum(m) }));
  const execute = (query: Parameters<PgDialect["sqlToQuery"]>[0]): Promise<{ rows: Row[] }> => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    log.push(text);
    if (/to_regclass/.test(text)) return Promise.resolve({ rows: [{ present: true, outbox: true, ack: true }] });
    if (/^SELECT name, checksum/.test(text)) return Promise.resolve({ rows: ledger.map((r) => ({ ...r })) });
    if (/^DELETE FROM/.test(text)) ledger = ledger.filter((r) => r.name !== params[0]);
    return Promise.resolve({ rows: [] });
  };
  const db = { execute, transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run({ execute }) } as unknown as LedgerDatabase;
  return { db, log, ledger: () => ledger.map((r) => r.name) };
}
const ddl = (log: readonly string[]): string[] => log.filter((s) => /^DROP /.test(s));

describe("settlement-pending · down با چند مهاجرت (ترتیب و گستره)", () => {
  it("همهٔ اعمال‌شده‌ها به ترتیبِ معکوس برمی‌گردند؛ ردیفِ دفترِ هر کدام پس از DDLِ خودش و پیش از مهاجرتِ پیشین حذف می‌شود", async () => {
    rollbacks.clear();
    rollbacks.set("0001_a", ["DROP TABLE IF EXISTS {{schema}}.a"]);
    rollbacks.set("0002_b", ["DROP TABLE IF EXISTS {{schema}}.b"]);
    rollbacks.set("0003_c", ["DROP TABLE IF EXISTS {{schema}}.c"]);
    const f = fake(["0001_a", "0002_b", "0003_c"]);
    expect(await down(f.db, "settlement")).toEqual({ ok: true, value: { reverted: ["0003_c", "0002_b", "0001_a"] } });
    const steps = f.log.filter((s) => /^(DROP|DELETE)/.test(s)).map((s) => s.replace(/"settlement"\./g, "").replace(/ WHERE name = \$1/, ""));
    expect(steps).toEqual(["DROP TABLE IF EXISTS c", "DELETE FROM \"settlement_pending_migration_ledger\"", "DROP TABLE IF EXISTS b", "DELETE FROM \"settlement_pending_migration_ledger\"", "DROP TABLE IF EXISTS a", "DELETE FROM \"settlement_pending_migration_ledger\"", "DROP TABLE \"settlement_pending_migration_ledger\""]);
    expect(f.ledger()).toEqual([]);
  });

  it("فقط اعمال‌شده‌ها برگردانده می‌شوند؛ مهاجرتِ معلق دست‌نخورده و دفتر (با یک ردیفِ باقی‌مانده) حذف نمی‌شود", async () => {
    rollbacks.clear();
    rollbacks.set("0001_a", ["DROP TABLE IF EXISTS {{schema}}.a"]);
    rollbacks.set("0002_b", ["DROP TABLE IF EXISTS {{schema}}.b"]);
    rollbacks.set("0003_c", ["DROP TABLE IF EXISTS {{schema}}.c"]);
    const f = fake(["0001_a", "0002_b"]);
    expect(await down(f.db, "settlement")).toEqual({ ok: true, value: { reverted: ["0002_b", "0001_a"] } });
    expect(ddl(f.log).some((s) => s.includes('"c"'))).toBe(false);
  });

  it("برگشتِ گم‌شده برای یکی از اعمال‌شده‌ها ⇒ CORRUPT_DATA **پیش از اولین DDL** (حتی اگر برگشتِ مهاجرتِ آخر هست)", async () => {
    rollbacks.clear();
    rollbacks.set("0002_b", ["DROP TABLE IF EXISTS {{schema}}.b"]);
    rollbacks.set("0003_c", ["DROP TABLE IF EXISTS {{schema}}.c"]);
    const f = fake(["0001_a", "0002_b", "0003_c"]);
    const r = await down(f.db, "settlement");
    expect(r).toMatchObject({ ok: false, error: { code: "CORRUPT_DATA" } });
    expect(f.log.some((s) => /^(DROP|DELETE|LOCK|SET LOCAL)/.test(s))).toBe(false);
    expect(f.ledger()).toEqual(["0001_a", "0002_b", "0003_c"]);
  });

  it("حفره در دفتر (۰۰۰۱ و ۰۰۰۳ بی‌۰۰۰۲) ⇒ رد می‌شود و هیچ DDL/DML اجرا نمی‌شود", async () => {
    rollbacks.clear();
    for (const n of ["0001_a", "0002_b", "0003_c"]) rollbacks.set(n, [`DROP TABLE IF EXISTS {{schema}}.${n}`]);
    const f = fake(["0001_a", "0003_c"]);
    const r = await down(f.db, "settlement");
    expect(r.ok).toBe(false);
    expect(f.log.some((s) => /^(DROP|DELETE|LOCK|SET LOCAL)/.test(s))).toBe(false);
    expect(f.ledger()).toEqual(["0001_a", "0003_c"]);
  });
});
