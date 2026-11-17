/**
 * کمک‌تست یکپارچگی با پایگاه واقعی (فقط برای تست‌ها؛ از index صادر نمی‌شود).
 *
 * سیاست:
 *  - هر فایل تست یک **شِمای یک‌بارمصرف** (`legal_kb_test_<تصادفی>`) می‌سازد و در پایان `DROP SCHEMA … CASCADE` می‌کند؛
 *    به جدول‌های برنامه (`public`) یا شِمای واقعی `legal_kb` هرگز دست نمی‌زند.
 *  - نشانی پایگاه: `KB_TEST_DATABASE_URL` یا `DATABASE_URL` (و فایل `.env`). اگر هیچ‌کدام نباشد تست‌های پایگاه **رد می‌شوند**
 *    (با هشدار)، مگر در CI (`CI=true`) که نبودنِ پایگاه خودش تست قرمز است (`unit.test.ts`): «سبزِ بی‌اجرا» برای نرم‌افزار حقوقی پذیرفتنی نیست.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { describe } from "vitest";
import { auditSchemaName } from "./naming";
import { createKbStore, type KbStore } from "./store";

config({ quiet: true });

export const TEST_DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
export const HAS_DB = typeof TEST_DB_URL === "string" && TEST_DB_URL !== "";

/** `describe` که بدون پایگاه رد می‌شود. */
export const dbDescribe = HAS_DB ? describe : describe.skip;

export type TestKb = Readonly<{
  pool: Pool;
  db: ReturnType<typeof drizzle>;
  store: KbStore;
  schema: string;
  /** SQL خام روی همین پایگاه (برای دور زدن عمدی store در تست قیدها). `{{schema}}` جایگزین می‌شود. */
  raw(text: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  drop(): Promise<void>;
}>;

export async function openTestKb(options: Readonly<{ migrate?: boolean }> = {}): Promise<TestKb> {
  if (!HAS_DB) throw new Error("پایگاه آزمون تنظیم نشده است (KB_TEST_DATABASE_URL یا DATABASE_URL).");
  const schema = `legal_kb_test_${randomBytes(5).toString("hex")}`;
  const pool = new Pool({ connectionString: TEST_DB_URL, max: 10 });
  const db = drizzle(pool);
  const made = createKbStore(db, { schema });
  if (!made.ok) throw new Error(made.error.message);
  const store = made.value;
  if (options.migrate !== false) {
    const m = await store.migrate();
    if (!m.ok) throw new Error(`migrate failed: ${m.error.code} ${m.error.message}`);
  }
  return {
    pool,
    db,
    store,
    schema,
    raw: async (text, params = []) => (await pool.query(text.split("{{schema}}").join(`"${schema}"`), [...params])).rows,
    drop: async () => {
      if (!schema.startsWith("legal_kb_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
      await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`);
      await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(auditSchemaName(schema))} CASCADE`);
      await pool.end();
    },
  };
}
