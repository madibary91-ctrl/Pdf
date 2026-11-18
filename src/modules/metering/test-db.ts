/**
 * کمک‌تست یکپارچگی با PostgreSQL واقعی (فقط برای تست‌ها؛ از index صادر نمی‌شود). مثل ledger/pg/test-db: هر اجرا یک شِمای یک‌بارمصرف
 * (`metering_test_<تصادفی>`) می‌سازد و در پایان `DROP SCHEMA … CASCADE` می‌کند؛ به `public` یا شِمای واقعی `ledger` دست نمی‌زند.
 * بدون `KB_TEST_DATABASE_URL`/`DATABASE_URL` تست‌ها رد می‌شوند (CI را `ledger/pg/guard.test.ts` و دروازهٔ صفر-رد قرمز می‌کنند).
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe } from "vitest";
import { createPgAccountStore } from "@/modules/ledger";
import type { PgAccountStore } from "@/modules/ledger";

config({ quiet: true });

export const TEST_DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
export const HAS_DB = typeof TEST_DB_URL === "string" && TEST_DB_URL !== "";
export const dbDescribe = HAS_DB ? describe : describe.skip;

export type TestPg = Readonly<{ store: PgAccountStore; dispose(): Promise<void> }>;

export async function openPgStore(poolSize = 10): Promise<TestPg> {
  if (!HAS_DB) throw new Error("پایگاه آزمون تنظیم نشده است (KB_TEST_DATABASE_URL یا DATABASE_URL).");
  const schema = `metering_test_${randomBytes(5).toString("hex")}`;
  const pool = new Pool({ connectionString: TEST_DB_URL, max: poolSize, idleTimeoutMillis: 50 }); // بودجهٔ اتصال: ADR-0024
  const db = drizzle(pool);
  const made = createPgAccountStore(db, { schema });
  if (!made.ok) throw new Error(`createPgAccountStore failed: ${made.error.code}`);
  const m = await made.value.migrate();
  if (!m.ok) throw new Error(`migrate failed: ${m.error.code}`);
  return {
    store: made.value,
    dispose: async () => {
      if (!schema.startsWith("metering_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
      await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`);
      await pool.end();
    },
  };
}
