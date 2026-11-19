/**
 * کمک‌تست PostgreSQL واقعی برای settlement-backlog (فقط برای تست‌ها؛ از index صادر نمی‌شود). هر اجرا یک شِمای یک‌بارمصرف
 * (`backlog_test_<تصادفی>`) می‌سازد و در پایان `DROP SCHEMA … CASCADE` می‌کند؛ به `public` و شِمای واقعی `settlement` دست نمی‌زند.
 * بودجهٔ اتصال (ADR-0024): استخرِ آزمون اتصالِ بیکار را زود پس می‌دهد. بدون `KB_TEST_DATABASE_URL`/`DATABASE_URL` تست‌ها رد می‌شوند
 * (CI را دروازهٔ صفر-رد قرمز می‌کند).
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe } from "vitest";
import { createPgSettlementOutbox } from "@/modules/settlement";
import type { PgSettlementOutbox } from "@/modules/settlement";

config({ quiet: true });

export const TEST_DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
export const HAS_DB = typeof TEST_DB_URL === "string" && TEST_DB_URL !== "";
export const dbDescribe = HAS_DB ? describe : describe.skip;
export const TEST_POOL_IDLE_MS = 50;

type Db = Parameters<typeof createPgSettlementOutbox>[0];

export type TestBacklogPg = Readonly<{
  outbox: PgSettlementOutbox;
  /** نمونهٔ دومِ outbox روی استخرِ اتصالِ جدا («فرایندِ دیگر») روی همان شِما. */
  another(): { outbox: PgSettlementOutbox; close(): Promise<void> };
  /** استخرِ اول را می‌بندد (شبیه‌سازیِ قطعِ پایگاه) بی‌آنکه شِما پاک شود. */
  killPrimary(): Promise<void>;
  dispose(): Promise<void>;
}>;

export async function openBacklogPg(poolSize = 4): Promise<TestBacklogPg> {
  if (!HAS_DB) throw new Error("پایگاه آزمون تنظیم نشده است (KB_TEST_DATABASE_URL یا DATABASE_URL).");
  const schema = `backlog_test_${randomBytes(5).toString("hex")}`;
  const pools: Pool[] = [];
  const ended = new Set<Pool>();
  const end = async (p: Pool): Promise<void> => {
    if (ended.has(p)) return;
    ended.add(p);
    await p.end();
  };
  const open = (): { pool: Pool; outbox: PgSettlementOutbox } => {
    const pool = new Pool({ connectionString: TEST_DB_URL, max: poolSize, idleTimeoutMillis: TEST_POOL_IDLE_MS });
    pools.push(pool);
    const made = createPgSettlementOutbox(drizzle(pool) as unknown as Db, { schema });
    if (!made.ok) throw new Error(`createPgSettlementOutbox failed: ${made.error.code}`);
    return { pool, outbox: made.value };
  };
  const first = open();
  const m = await first.outbox.migrate();
  if (!m.ok) throw new Error(`migrate failed: ${m.error.code}`);
  return {
    outbox: first.outbox,
    another() {
      const again = open();
      return { outbox: again.outbox, close: () => end(again.pool) };
    },
    killPrimary: () => end(first.pool),
    dispose: async () => {
      if (!schema.startsWith("backlog_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
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
