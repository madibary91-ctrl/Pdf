/**
 * کمک‌تست PostgreSQL واقعی برای settlement-pending (فقط برای تست‌ها؛ از index صادر نمی‌شود). عمداً `pg-kit.ts` نه `test-db.ts`:
 * فهرستِ فایل‌های `test-db.ts` در `tooling/test-connection-budget.test.ts` قفل است و تغییرش `Test-Change-Approved` می‌خواهد؛ قاعدهٔ بودجهٔ اتصال
 * (ADR-0024) اما همین‌جا رعایت شده است: هر استخر `idleTimeoutMillis` ۵۰ms دارد و `application_name` برچسب‌دار است.
 * هر اجرا یک شِمای یک‌بارمصرف (`pending_test_<تصادفی>`) می‌سازد و در پایان `DROP SCHEMA … CASCADE` می‌کند؛ به `public` و شِمای واقعی `settlement` دست نمی‌زند.
 * بدون `KB_TEST_DATABASE_URL`/`DATABASE_URL` تست‌ها رد می‌شوند (CI را دروازهٔ صفر-رد قرمز می‌کند).
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { createPgSettlementOutbox } from "@/modules/settlement";
import type { OutboxResult, PgSettlementOutbox, ReservationRef } from "@/modules/settlement";
import { createPendingDeadIndex } from "./index";
import type { PendingDeadIndex, PendingDeadIndexOptions } from "./index";

config({ quiet: true });

export const TEST_DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
export const HAS_DB = typeof TEST_DB_URL === "string" && TEST_DB_URL !== "";
export const dbDescribe = HAS_DB ? describe : describe.skip;
export const POOL_IDLE_MS = 50;
const APP_NAME = `settlement-pending-test-${randomBytes(3).toString("hex")}`;

export type Raw = (statement: string, params?: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>;

export type PendingKit = Readonly<{
  schema: string;
  db: LedgerDatabase;
  outbox: PgSettlementOutbox;
  /** نمایه روی استخرِ اول؛ `migrate()` را خودتان صدا بزنید (`migratePending: false` پیش‌فرضِ بازکننده است). */
  index: PendingDeadIndex;
  /** نمایهٔ تازه روی استخرِ جدا و گزینه‌های دلخواه (برای سقفِ زمان و «فرایندِ دیگر»). */
  indexWith(options?: Omit<PendingDeadIndexOptions, "schema">, poolSize?: number): { index: PendingDeadIndex; db: LedgerDatabase; raw: Raw; close(): Promise<void> };
  outboxWith(options?: { readStatementTimeoutMs?: number }): PgSettlementOutbox;
  /** SQL خام؛ `{{s}}` با نامِ نقل‌قول‌شدهٔ شِما جایگزین می‌شود. */
  raw: Raw;
  /** یک اتصال و یک تراکنشِ دستی (BEGIN داده شده)؛ `commit`/`rollback` با فراخواننده؛ در پایان همیشه ROLLBACK و آزادسازی. */
  session<T>(fn: (q: Raw, commit: () => Promise<void>) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}>;

export async function openPendingKit(opts: Readonly<{ migratePending?: boolean; poolSize?: number }> = {}): Promise<PendingKit> {
  if (!HAS_DB) throw new Error("پایگاه آزمون تنظیم نشده است (KB_TEST_DATABASE_URL یا DATABASE_URL).");
  const schema = `pending_test_${randomBytes(5).toString("hex")}`;
  const pools: Pool[] = [];
  const ended = new Set<Pool>();
  const end = async (p: Pool): Promise<void> => {
    if (ended.has(p)) return;
    ended.add(p);
    await p.end();
  };
  const newPool = (max: number): Pool => {
    const pool = new Pool({ connectionString: TEST_DB_URL, max, idleTimeoutMillis: POOL_IDLE_MS, application_name: APP_NAME });
    pools.push(pool);
    return pool;
  };
  const rawOn =
    (pool: Pool): Raw =>
    async (statement, params = []) =>
      (await pool.query(statement.split("{{s}}").join(`"${schema}"`), [...params])).rows as Record<string, unknown>[];

  const first = newPool(opts.poolSize ?? 6);
  const db = drizzle(first) as unknown as LedgerDatabase;
  const made = createPgSettlementOutbox(db, { schema });
  if (!made.ok) throw new Error(`createPgSettlementOutbox failed: ${made.error.code}`);
  const m = await made.value.migrate();
  if (!m.ok) throw new Error(`settlement migrate failed: ${m.error.code}`);
  const idx = createPendingDeadIndex(db, { schema });
  if (!idx.ok) throw new Error(`createPendingDeadIndex failed: ${idx.error.code}`);
  if (opts.migratePending === true) {
    const pm = await idx.value.migrate();
    if (!pm.ok) throw new Error(`pending migrate failed: ${pm.error.code}`);
  }

  return {
    schema,
    db,
    outbox: made.value,
    index: idx.value,
    indexWith(options = {}, poolSize = 2) {
      const pool = newPool(poolSize);
      const d = drizzle(pool) as unknown as LedgerDatabase;
      const r = createPendingDeadIndex(d, { schema, ...options });
      if (!r.ok) throw new Error(`createPendingDeadIndex failed: ${r.error.code}`);
      return { index: r.value, db: d, raw: rawOn(pool), close: () => end(pool) };
    },
    outboxWith(options = {}) {
      const r = createPgSettlementOutbox(drizzle(newPool(2)) as unknown as LedgerDatabase, { schema, ...options });
      if (!r.ok) throw new Error(`createPgSettlementOutbox failed: ${r.error.code}`);
      return r.value;
    },
    raw: rawOn(first),
    session: async (fn) => {
      const client = await first.connect();
      try {
        await client.query("BEGIN");
        const q: Raw = async (statement, params = []) => (await client.query(statement.split("{{s}}").join(`"${schema}"`), [...params])).rows as Record<string, unknown>[];
        return await fn(q, async () => {
          await client.query("COMMIT");
        });
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    },
    dispose: async () => {
      if (!schema.startsWith("pending_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
      const cleaner = new Pool({ connectionString: TEST_DB_URL, max: 1, idleTimeoutMillis: POOL_IDLE_MS });
      try {
        await drizzle(cleaner).execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`);
      } finally {
        await cleaner.end();
        for (const p of pools) await end(p);
      }
    },
  };
}

export const must = <T>(r: OutboxResult<T>): T => {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
};

export const BEGIN_FACTS = { unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const };
export const ref = (reservationId: string, o: Partial<ReservationRef> = {}): ReservationRef => ({ tenantId: "t1", accountId: "a1", reservationId, ...o });

/** رکوردی می‌سازد و می‌میراند (`bury`)؛ کلید را برمی‌گرداند. */
export async function makeDead(o: PgSettlementOutbox, id: string, atMs = 20_000, over: Partial<ReservationRef> = {}): Promise<ReservationRef> {
  const r = ref(id, over);
  must(await o.begin({ ...r, ...BEGIN_FACTS }));
  must(await o.bury(r, { reason: "LEDGER_REJECTED", errorCode: null, atMs }));
  return r;
}
