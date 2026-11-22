/**
 * settlement-pending · شکلِ SQLِ بررسیِ «وجودِ رابطه» (ADR-0050؛ بی‌پایگاه). رفتارِ واقعیِ اتصالِ گرم در `regclass.pg.test.ts` است؛ این‌جا فقط
 * قفل می‌کنیم که **هیچ** بررسیِ وجودی در ماژول دوباره به `to_regclass`ِ لخت (کشِ کاتالوگ، بی‌تأییدِ pg_class) برنگردد.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { down, migrate, migrationStatus } from "./migrate";
import { MIGRATIONS, migrationChecksum } from "./migrations";

type Row = Record<string, unknown>;
type Query = Parameters<PgDialect["sqlToQuery"]>[0];
const first = MIGRATIONS[0] as NonNullable<(typeof MIGRATIONS)[number]>;

function recorder(ledgerPresent: boolean): { db: LedgerDatabase; log: Array<{ text: string; params: readonly unknown[] }> } {
  const dialect = new PgDialect();
  const log: Array<{ text: string; params: readonly unknown[] }> = [];
  const execute = (query: Query): Promise<{ rows: Row[] }> => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    log.push({ text, params });
    if (/to_regclass/.test(text)) return Promise.resolve({ rows: [{ present: ledgerPresent, outbox: true, ack: true }] });
    if (/^SELECT name, checksum/.test(text)) return Promise.resolve({ rows: ledgerPresent ? [{ name: first.name, checksum: migrationChecksum(first) }] : [] });
    return Promise.resolve({ rows: [] });
  };
  const db = { execute, transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run({ execute }) } as unknown as LedgerDatabase;
  return { db, log };
}
const checks = (log: ReadonlyArray<{ text: string }>): Array<{ text: string; params: readonly unknown[] }> => log.filter((e) => /to_regclass/.test(e.text)) as Array<{ text: string; params: readonly unknown[] }>;
const EXISTS_SHAPE = /EXISTS \(SELECT 1 FROM pg_catalog\.pg_class c WHERE c\.oid = to_regclass\(\$\d+\)\)/;

describe("settlement-pending · بررسیِ وجودِ رابطه: شکلِ SQL (ADR-0050)", () => {
  it("هر بررسی `to_regclass` را به یک اسکنِ pg_class گره می‌زند و هرگز `to_regclass(...) IS NOT NULL`ِ لخت نیست (down، نصب‌نشده)", async () => {
    const r = recorder(false);
    await down(r.db, "settlement");
    const c = checks(r.log);
    expect(c).toHaveLength(1);
    expect(c[0]?.text).toMatch(EXISTS_SHAPE);
    expect(c[0]?.text).not.toMatch(/to_regclass\(\$\d+\)\s+IS NOT NULL/);
    expect(c[0]?.text).toMatch(/AS present$/);
    expect(c[0]?.params).toEqual(['"settlement".settlement_pending_migration_ledger']);
  });

  it("down (نصب‌شده): دفتر ← پیش‌نیاز؛ هر دو با همان شکل و پارامترِ نخستِ درست (نامِ نقل‌قول‌شدهٔ کامل)", async () => {
    const r = recorder(true);
    await down(r.db, "my_schema");
    const c = checks(r.log);
    expect(c).toHaveLength(2);
    for (const e of c) expect(e.text).toMatch(EXISTS_SHAPE);
    expect(c[0]?.params).toEqual(['"my_schema".settlement_pending_migration_ledger']);
    expect(c[1]?.text).toMatch(/AS outbox, EXISTS .* AS ack$/);
    expect(c[1]?.params).toEqual(['"my_schema".settlement_outbox', '"my_schema".settlement_dead_ack']);
  });

  it("migrate: پیش‌نیازِ settlement با همان شکل (دو پارامتر به ترتیب) و پیش از هر DDL", async () => {
    const r = recorder(false);
    await migrate(r.db, "settlement");
    const i = r.log.findIndex((e) => /to_regclass/.test(e.text));
    expect(i).toBeGreaterThan(1);
    expect(r.log[i]?.text).toMatch(EXISTS_SHAPE);
    expect(r.log[i]?.params).toEqual(['"settlement".settlement_outbox', '"settlement".settlement_dead_ack']);
    expect(r.log.findIndex((e) => /^CREATE TABLE/.test(e.text))).toBeGreaterThan(i);
  });

  it("migrationStatus: همان شکل؛ نامِ شِمای نیازمندِ نقل‌قول درست پارامتر می‌شود", async () => {
    const r = recorder(false);
    await migrationStatus(r.db, 'we"ird');
    const c = checks(r.log);
    expect(c).toHaveLength(1);
    expect(c[0]?.text).toMatch(EXISTS_SHAPE);
    expect(c[0]?.params).toEqual(['"we\\"ird".settlement_pending_migration_ledger']);
  });

  it("نگهبانِ منبع: در کدِ محصولِ ماژول فقط **یک** فراخوانیِ `to_regclass(` هست (داخلِ relationExists)؛ فایلِ تازه نمی‌تواند نسخهٔ لخت بیاورد", () => {
    const skip = new Set(["pg-kit.ts", "test-kit.ts"]);
    const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const hits: string[] = [];
    for (const n of readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !skip.has(f))) {
      const code = strip(readFileSync(join(__dirname, n), "utf8"));
      for (const m of code.matchAll(/to_regclass\s*\(/g)) hits.push(`${n}@${m.index}`);
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^migrate\.ts@/);
    const code = strip(readFileSync(join(__dirname, "migrate.ts"), "utf8"));
    expect(code).toMatch(/function relationExists\(qualifiedName: string\): SQL \{\s*return sql`EXISTS \(SELECT 1 FROM pg_catalog\.pg_class c WHERE c\.oid = to_regclass\(\$\{qualifiedName\}\)\)`;/);
  });
});
