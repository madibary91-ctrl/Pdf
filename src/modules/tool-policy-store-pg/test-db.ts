/**
 * کمک‌تست PostgreSQL واقعی برای آداپتور نسخه‌های سیاست (فقط تست؛ از index صادر نمی‌شود). هر اجرا یک شِمای یک‌بارمصرف
 * (`tool_policy_test_<تصادفی>`) می‌سازد (خودِ تست `CREATE SCHEMA` می‌زند، نه ماژول) و در پایان `DROP SCHEMA … CASCADE` می‌کند؛
 * به `public` یا شِمای واقعی `tool_policy` دست نمی‌زند. بدونِ `KB_TEST_DATABASE_URL`/`DATABASE_URL` تست‌ها رد می‌شوند
 * (دروازهٔ صفر-ردِ CI آن را قرمز می‌کند). بودجهٔ اتصال (ADR-0024): استخر اتصالِ بیکار را زود پس می‌دهد.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe } from "vitest";
import { createPgPolicyVersionStore } from "./store";
import type { PgPolicyStoreOptions, PgPolicyVersionStore, PolicyPgDatabase } from "./types";

config({ quiet: true });

export const TEST_DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
export const HAS_DB = typeof TEST_DB_URL === "string" && TEST_DB_URL !== "";
export const dbDescribe = HAS_DB ? describe : describe.skip;

export const TEST_POOL_IDLE_MS = 50;
export const newSchemaName = (): string => `tool_policy_test_${randomBytes(5).toString("hex")}`;

export type TestPolicyStore = Readonly<{
  store: PgPolicyVersionStore;
  schema: string;
  db: PolicyPgDatabase;
  pool: Pool;
  /** SQL خام روی همین شِما برای دست‌کاریِ عمدیِ پایگاه (آزمونِ قیدها و خرابی). `{{s}}` ← نامِ نقل‌قول‌شدهٔ شِما. */
  raw(statement: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  /** نمونهٔ تازه روی همان شِما با استخرِ تازه (ریستارتِ فرایند). */
  reopen(options?: PgPolicyStoreOptions): Promise<Readonly<{ store: PgPolicyVersionStore; close(): Promise<void> }>>;
  dispose(): Promise<void>;
}>;

export async function openPgPolicyStore(opts: Readonly<{ poolSize?: number; schema?: string; migrate?: boolean; create?: boolean; store?: PgPolicyStoreOptions }> = {}): Promise<TestPolicyStore> {
  if (!HAS_DB) throw new Error("پایگاه آزمون تنظیم نشده است (KB_TEST_DATABASE_URL یا DATABASE_URL).");
  const schema = opts.schema ?? newSchemaName();
  const pools: Pool[] = [];
  const open = (storeOptions: PgPolicyStoreOptions = opts.store ?? {}): { pool: Pool; db: PolicyPgDatabase; store: PgPolicyVersionStore } => {
    const pool = new Pool({ connectionString: TEST_DB_URL, max: opts.poolSize ?? 10, idleTimeoutMillis: TEST_POOL_IDLE_MS });
    pools.push(pool);
    const db = drizzle(pool);
    const made = createPgPolicyVersionStore(db, { ...storeOptions, schema });
    if (!made.ok) throw new Error(`createPgPolicyVersionStore failed: ${made.error.code}`);
    return { pool, db, store: made.value };
  };
  const first = open();
  if (opts.create !== false) await first.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
  if (opts.migrate !== false) {
    const m = await first.store.migrate();
    if (!m.ok) throw new Error(`migrate failed: ${m.error.code}`);
  }
  const ended = new Set<Pool>();
  const end = async (p: Pool): Promise<void> => {
    if (ended.has(p)) return;
    ended.add(p);
    await p.end();
  };
  return {
    store: first.store,
    schema,
    db: first.db,
    pool: first.pool,
    raw: async (statement, params = []) => (await first.pool.query(statement.split("{{s}}").join(`"${schema}"`), [...params])).rows as Record<string, unknown>[],
    reopen: async (options) => {
      const again = open(options);
      return { store: again.store, close: () => end(again.pool) };
    },
    dispose: async () => {
      if (!schema.startsWith("tool_policy_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
      const cleaner = new Pool({ connectionString: TEST_DB_URL, max: 1, idleTimeoutMillis: TEST_POOL_IDLE_MS });
      try {
        await drizzle(cleaner).execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`);
      } finally {
        await cleaner.end();
        for (const p of pools) await end(p);
      }
    },
  };
}
