/**
 * کمک‌تست PostgreSQL واقعی برای آداپتور outbox (فقط برای تست‌ها؛ از index صادر نمی‌شود). هر اجرا یک شِمای یک‌بارمصرف
 * (`settlement_test_<تصادفی>`) می‌سازد و در پایان `DROP SCHEMA … CASCADE` می‌کند؛ به `public` یا شِمای واقعی `settlement`/`ledger` دست نمی‌زند.
 * `reopen()` «ریستارتِ فرایند» را شبیه‌سازی می‌کند: استخرِ اتصالِ تازه و نمونهٔ تازه روی همان شِما (بی‌مهاجرتِ دوباره).
 * بدون `KB_TEST_DATABASE_URL`/`DATABASE_URL` تست‌ها رد می‌شوند (CI را `ledger/pg/guard.test.ts` و دروازهٔ صفر-رد قرمز می‌کنند).
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { LedgerDatabase } from "@/modules/ledger";
import { HAS_DB, TEST_DB_URL, dbDescribe } from "../test-db";
import { createPgSettlementOutbox } from "./store";
import type { PgSettlementOutbox } from "./types";

export { HAS_DB, TEST_DB_URL, dbDescribe };

export type TestOutbox = Readonly<{
  outbox: PgSettlementOutbox;
  schema: string;
  /** پایگاه drizzle روی استخرِ نخست (برای ساختنِ ذخیرهٔ دفتر یا ردیابیِ دستورها در همان شِما). */
  db: LedgerDatabase;
  /** SQL خام روی همین شِما برای دستکاریِ عمدیِ پایگاه (آزمونِ قیدها و خرابی). `{{s}}` با نامِ نقل‌قول‌شدهٔ شِما جایگزین می‌شود. */
  raw(statement: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  /** یک اتصال و یک تراکنش برای دستورهای وابسته (`SET LOCAL`، `EXPLAIN`)؛ همیشه ROLLBACK می‌شود. */
  session<T>(fn: (query: (statement: string, params?: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>) => Promise<T>): Promise<T>;
  /** نمونهٔ تازه روی همان شِما با استخرِ اتصالِ تازه (ریستارتِ فرایند)؛ نمونهٔ قبلی هنوز می‌تواند کار کند. */
  reopen(): Promise<Readonly<{ outbox: PgSettlementOutbox; close(): Promise<void> }>>;
  /** پایانِ همهٔ اتصال‌های این نمونه بی‌حذفِ شِما (مرگِ فرایند). */
  kill(): Promise<void>;
  dispose(): Promise<void>;
}>;

export const newSchemaName = (): string => `settlement_test_${randomBytes(5).toString("hex")}`;

export async function openPgOutbox(poolSize = 10, schema = newSchemaName(), migrate = true): Promise<TestOutbox> {
  if (!HAS_DB) throw new Error("پایگاه آزمون تنظیم نشده است (KB_TEST_DATABASE_URL یا DATABASE_URL).");
  const pools: Pool[] = [];
  const open = (): { pool: Pool; db: LedgerDatabase; outbox: PgSettlementOutbox } => {
    const pool = new Pool({ connectionString: TEST_DB_URL, max: poolSize });
    pools.push(pool);
    const db = drizzle(pool);
    const made = createPgSettlementOutbox(db, { schema });
    if (!made.ok) throw new Error(`createPgSettlementOutbox failed: ${made.error.code}`);
    return { pool, db, outbox: made.value };
  };
  const first = open();
  if (migrate) {
    const m = await first.outbox.migrate();
    if (!m.ok) throw new Error(`migrate failed: ${m.error.code}`);
  }
  const ended = new Set<Pool>();
  const end = async (p: Pool): Promise<void> => {
    if (ended.has(p)) return;
    ended.add(p);
    await p.end();
  };
  return {
    outbox: first.outbox,
    schema,
    db: first.db,
    raw: async (statement, params = []) => {
      const res = await first.pool.query(statement.split("{{s}}").join(`"${schema}"`), [...params]);
      return res.rows as Record<string, unknown>[];
    },
    session: async (fn) => {
      const client = await first.pool.connect();
      try {
        await client.query("BEGIN");
        return await fn(async (statement, params = []) => (await client.query(statement.split("{{s}}").join(`"${schema}"`), [...params])).rows as Record<string, unknown>[]);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    },
    reopen: async () => {
      const again = open();
      return { outbox: again.outbox, close: () => end(again.pool) };
    },
    kill: async () => {
      await end(first.pool);
    },
    dispose: async () => {
      if (!schema.startsWith("settlement_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
      const cleaner = new Pool({ connectionString: TEST_DB_URL, max: 1 });
      try {
        await drizzle(cleaner).execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`);
      } finally {
        await cleaner.end();
        for (const p of pools) await end(p);
      }
    },
  };
}
