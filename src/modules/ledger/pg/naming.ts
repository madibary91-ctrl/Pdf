/**
 * نام شِما و ارجاع به جدول‌ها (داخلی).
 * نام شِما تنها «شناسه‌ای» است که در SQL قرار می‌گیرد؛ پس فهرست‌سفید سخت‌گیرانه دارد و همیشه با `sql.identifier` نقل‌قول می‌شود.
 * همهٔ مقدارهای دیگر پارامتر پیوندی‌اند، نه الحاق رشته.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AccountKey } from "../types";
import type { PgStoreResult } from "./types";

export const LEDGER_DEFAULT_SCHEMA = "ledger";

const SCHEMA_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** شِمای برنامه (drizzle-kit) و شِماهای سیستمی؛ جدول‌های دفتر هرگز با آن‌ها قاطی نمی‌شوند. */
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
  return { ok: true, value };
}

export const TABLES = ["account", "reservation", "processed", "journal", "migration_ledger"] as const;
export type TableName = (typeof TABLES)[number];

/** `"schema"."table"` — با نقل‌قول امن. */
export function tableRef(schema: string, table: TableName): SQL {
  return sql`${sql.identifier(schema)}.${sql.identifier(table)}`;
}

/**
 * متنِ قفل مشورتیِ یک حساب. شِما برای جدابودن شِماهای مستقل؛ طولِ مستأجر پیشوند است تا ('a','bc') و ('ab','c') یکی نشوند
 * (شناسه‌ها `:` دارند ولی طول، مرز را بی‌ابهام می‌کند).
 */
export function lockName(schema: string, key: AccountKey): string {
  return `ledger:${schema}:${key.tenantId.length}:${key.tenantId}:${key.accountId}`;
}
