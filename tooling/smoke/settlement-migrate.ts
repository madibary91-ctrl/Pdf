/**
 * مهاجرتِ صریحِ زمانِ استقرارِ شِماهای تسویه (ADR-0022/0031: `start` هرگز مهاجرت نمی‌کند). فعلاً فقط برای smoke و استقرارِ دستی؛
 * اجرا: DATABASE_URL=… SETTLEMENT_LEDGER_SCHEMA=… SETTLEMENT_OUTBOX_SCHEMA=… npx vite-node -c vitest.config.ts tooling/smoke/settlement-migrate.ts
 * (شِماها اختیاری‌اند؛ پیش‌فرضِ ماژول‌ها). CLIِ رسمی با آزمون کارِ برشِ بعدی است.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPgSettlementRuntime } from "@/modules/settlement-runtime";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL لازم است");
const pool = new Pool({ connectionString: url, max: 1 });
try {
  const cfg: Record<string, unknown> = { db: drizzle(pool), graceMs: 1000, deadLetters: false };
  if (process.env["SETTLEMENT_LEDGER_SCHEMA"]) cfg["ledgerSchema"] = process.env["SETTLEMENT_LEDGER_SCHEMA"];
  if (process.env["SETTLEMENT_OUTBOX_SCHEMA"]) cfg["settlementSchema"] = process.env["SETTLEMENT_OUTBOX_SCHEMA"];
  const rt = createPgSettlementRuntime(cfg);
  if (!rt.ok) throw new Error(`پیکربندی نامعتبر: ${rt.error.issues.join("; ")}`);
  const r = await rt.value.migrate();
  console.log(JSON.stringify(r));
  if (!r.ok) process.exitCode = 1;
} finally {
  await pool.end();
}
