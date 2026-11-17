/**
 * نام شِما و ارجاع به جدول‌ها (داخلی).
 *
 * نام شِما تنها «شناسه‌ای» است که در SQL قرار می‌گیرد؛ پس **فهرست‌سفید** سخت‌گیرانه دارد و همیشه با `sql.identifier` نقل‌قول می‌شود.
 * همهٔ مقدارهای دیگر پارامتر پیوندی‌اند، نه الحاق رشته.
 */
import { sql, type SQL } from "drizzle-orm";
import type { StoreResult } from "./types";

export const DEFAULT_SCHEMA = "legal_kb";

const SCHEMA_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** شِمای برنامه (drizzle-kit) و شِماهای سیستمی؛ جدول‌های دانش هرگز با آن‌ها قاطی نمی‌شوند. */
const RESERVED = new Set(["public", "information_schema"]);

export function parseSchemaName(value: unknown): StoreResult<string> {
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

export const TABLES = ["document", "article", "article_version", "article_subpart", "relation", "ruling", "ruling_cite", "migration_ledger"] as const;
export type TableName = (typeof TABLES)[number];

/** `"schema"."table"` — با نقل‌قول امن. */
export function tableRef(schema: string, table: TableName): SQL {
  return sql`${sql.identifier(schema)}.${sql.identifier(table)}`;
}
