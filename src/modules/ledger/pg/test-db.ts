/**
 * کمک‌تست یکپارچگی با پایگاه واقعی (فقط برای تست‌ها؛ از index صادر نمی‌شود).
 *
 * سیاست (مثل legal-kb-store):
 *  - هر فایل تست یک **شِمای یک‌بارمصرف** (`ledger_test_<تصادفی>`) می‌سازد و در پایان `DROP SCHEMA … CASCADE` می‌کند؛
 *    به جدول‌های برنامه (`public`) یا شِمای واقعی `ledger` هرگز دست نمی‌زند.
 *  - نشانی پایگاه: `KB_TEST_DATABASE_URL` یا `DATABASE_URL` (و فایل `.env`). اگر هیچ‌کدام نباشد تست‌های پایگاه **رد می‌شوند**،
 *    مگر در CI (`CI=true`) که نبودنِ پایگاه خودش تست قرمز است (`guard.test.ts`): «سبزِ بی‌اجرا» برای دفتر اعتبار پذیرفتنی نیست.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { describe } from "vitest";
import { buildPgStore } from "./store";
import type { PgAccountStore } from "./types";

config({ quiet: true });

export const TEST_DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
export const HAS_DB = typeof TEST_DB_URL === "string" && TEST_DB_URL !== "";

/** `describe` که بدون پایگاه رد می‌شود. */
export const dbDescribe = HAS_DB ? describe : describe.skip;

export type TestLedgerDb = Readonly<{
  pool: Pool;
  db: ReturnType<typeof drizzle>;
  store: PgAccountStore;
  schema: string;
  /** SQL خام روی همین پایگاه (برای دور زدن عمدی فروشگاه). `{{schema}}` جایگزین می‌شود. */
  raw(text: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /** فروشگاهِ دیگر روی همان شِما و همان پایگاه (شبیه‌سازی ریستارت/فرایند دوم). */
  another(options?: Readonly<{ semanticGuards?: boolean }>): PgAccountStore;
  drop(): Promise<void>;
}>;

export type OpenOptions = Readonly<{
  /** پیش‌فرض true. */
  migrate?: boolean;
  /** پیش‌فرض true (پیکربندی محصول). false فقط برای آزمون قرارداد پورت. */
  semanticGuards?: boolean;
  /** پیش‌فرض false. فقط آزمون قرارداد پورت: قید بقا را از شِمای آزمون برمی‌دارد (حالت‌های ساختگی). */
  relaxConservation?: boolean;
  poolSize?: number;
}>;

export async function openTestLedgerDb(options: OpenOptions = {}): Promise<TestLedgerDb> {
  if (!HAS_DB) throw new Error("پایگاه آزمون تنظیم نشده است (KB_TEST_DATABASE_URL یا DATABASE_URL).");
  const schema = `ledger_test_${randomBytes(5).toString("hex")}`;
  const pool = new Pool({ connectionString: TEST_DB_URL, max: options.poolSize ?? 10 });
  const db = drizzle(pool);
  const semantic = options.semanticGuards ?? true;
  const store = buildPgStore(db, schema, semantic);
  const raw = async (text: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> =>
    (await pool.query(text.split("{{schema}}").join(`"${schema}"`), [...params])).rows;
  if (options.migrate !== false) {
    const m = await store.migrate();
    if (!m.ok) throw new Error(`migrate failed: ${m.error.code} ${m.error.message}`);
    if (options.relaxConservation === true) await raw("ALTER TABLE {{schema}}.account DROP CONSTRAINT account_conservation_ck");
  }
  return {
    pool,
    db,
    store,
    schema,
    raw,
    another: (o = {}) => buildPgStore(db, schema, o.semanticGuards ?? semantic),
    drop: async () => {
      if (!schema.startsWith("ledger_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
      await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`);
      await pool.end();
    },
  };
}
