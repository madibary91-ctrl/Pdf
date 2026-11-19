/**
 * کمک‌تست PostgreSQL واقعی برای settlement-runtime (فقط برای تست‌ها؛ از index صادر نمی‌شود). هر اجرا دو شِمای یک‌بارمصرف
 * (`rt_ledger_<تصادفی>` و `rt_settle_<تصادفی>`) می‌سازد و در پایان `DROP SCHEMA … CASCADE` می‌کند؛ به `public` و شِمای واقعی دست نمی‌زند.
 * بودجهٔ اتصال (ADR-0024): استخرِ آزمون اتصالِ بیکار را زود پس می‌دهد.
 * بدون `KB_TEST_DATABASE_URL`/`DATABASE_URL` تست‌ها رد می‌شوند (CI را `ledger/pg/guard.test.ts` و دروازهٔ صفر-رد قرمز می‌کنند).
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";

config({ quiet: true });

export const TEST_DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
export const HAS_DB = typeof TEST_DB_URL === "string" && TEST_DB_URL !== "";
export const dbDescribe = HAS_DB ? describe : describe.skip;
export const TEST_POOL_IDLE_MS = 50;

export type TestPg = Readonly<{
  db: LedgerDatabase;
  ledgerSchema: string;
  settlementSchema: string;
  /** استخرِ تازه روی همان شِماها (فرایندِ دیگر)؛ با `dispose` بسته می‌شود. */
  another(): { db: LedgerDatabase; close(): Promise<void> };
  raw(statement: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  /** استخرِ اول را می‌بندد (شبیه‌سازیِ قطعِ پایگاه) بی‌آنکه شِما پاک شود. */
  killPrimary(): Promise<void>;
  dispose(): Promise<void>;
}>;

export async function openPg(max = 4): Promise<TestPg> {
  if (!HAS_DB) throw new Error("پایگاه آزمون تنظیم نشده است (KB_TEST_DATABASE_URL یا DATABASE_URL).");
  const tag = randomBytes(5).toString("hex");
  const ledgerSchema = `rt_ledger_${tag}`;
  const settlementSchema = `rt_settle_${tag}`;
  const pool = new Pool({ connectionString: TEST_DB_URL, max, idleTimeoutMillis: TEST_POOL_IDLE_MS });
  const extras: Pool[] = [];
  let primaryOpen = true;
  const sub = (s: string): string => s.replaceAll("{{l}}", `"${ledgerSchema}"`).replaceAll("{{s}}", `"${settlementSchema}"`);
  const raw = async (statement: string, params: readonly unknown[] = []) => {
    const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, idleTimeoutMillis: TEST_POOL_IDLE_MS });
    try {
      return (await probe.query(sub(statement), [...params])).rows as Record<string, unknown>[];
    } finally {
      await probe.end();
    }
  };
  return {
    db: drizzle(pool) as unknown as LedgerDatabase,
    ledgerSchema,
    settlementSchema,
    another() {
      const p = new Pool({ connectionString: TEST_DB_URL, max: 3, idleTimeoutMillis: TEST_POOL_IDLE_MS });
      extras.push(p);
      let closed = false;
      return {
        db: drizzle(p) as unknown as LedgerDatabase,
        close: async () => {
          if (closed) return;
          closed = true;
          await p.end();
        },
      };
    },
    raw,
    killPrimary: async () => {
      if (!primaryOpen) return;
      primaryOpen = false;
      await pool.end();
    },
    dispose: async () => {
      if (!ledgerSchema.startsWith("rt_ledger_") || !settlementSchema.startsWith("rt_settle_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
      await raw(`DROP SCHEMA IF EXISTS {{l}} CASCADE`);
      await raw(`DROP SCHEMA IF EXISTS {{s}} CASCADE`);
      if (primaryOpen) await pool.end();
      for (const p of extras) await p.end().catch(() => undefined);
    },
  };
}
