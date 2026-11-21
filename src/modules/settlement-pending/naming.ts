/**
 * نام شِما و ارجاع به جدول‌ها (داخلی؛ ADR-0046). همان فهرست‌سفیدِ `settlement/pg/naming.ts` است، **عمداً کپی** (قاعدهٔ ۳ AGENTS.md: به داخلیِ ماژولِ دیگر
 * import نمی‌شود) و آزمونِ `naming.test.ts` هم‌ارزیِ رفتاریِ آن با آداپتورِ settlement را روی ورودی‌های مرزی می‌سنجد.
 * نام شِما تنها «شناسه‌ای» است که در SQL می‌نشیند و با `sql.identifier` نقل‌قول می‌شود؛ همهٔ مقدارهای دیگر پارامتر پیوندی‌اند.
 */
import { sql, type SQL } from "drizzle-orm";
import type { PgStoreResult } from "@/modules/ledger";

const SCHEMA_RE = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(["public", "information_schema"]);

export function parseSchemaName(value: unknown): PgStoreResult<string> {
  if (typeof value !== "string" || !SCHEMA_RE.test(value) || RESERVED.has(value) || value.startsWith("pg_")) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "نام شِما نامعتبر است؛ فقط حروف کوچک لاتین، عدد و _ (با حرف شروع، حداکثر ۴۰ نویسه) و نه public، information_schema یا pg_*.",
      },
    };
  }
  return { ok: true, value: value };
}

/** جدول‌های همین ماژول + دو جدولِ settlement که می‌خواند (نه می‌نویسد). نام‌ها پیشوند `settlement_` دارند و با شِمای مشترک برخورد نمی‌کنند. */
export const TABLES = ["settlement_dead_pending", "settlement_pending_migration_ledger", "settlement_outbox", "settlement_dead_ack"] as const;
export type TableName = (typeof TABLES)[number];

/** `"schema"."table"` با نقل‌قولِ امن. */
export function tableRef(schema: string, table: TableName): SQL {
  return sql`${sql.identifier(schema)}.${sql.identifier(table)}`;
}
