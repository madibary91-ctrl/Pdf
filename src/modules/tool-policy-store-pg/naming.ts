/**
 * نام شِما و ارجاع به جدول‌ها (داخلی). نام شِما تنها «شناسه‌ای» است که در SQL می‌نشیند؛ فهرست‌سفیدِ سخت‌گیرانه دارد و همیشه نقل‌قول می‌شود.
 * همهٔ مقدارهای دیگر پارامتر پیوندی‌اند، نه الحاقِ رشته.
 */
import { sql, type SQL } from "drizzle-orm";
import type { PgPolicyResult } from "./types";

export const TOOL_POLICY_DEFAULT_SCHEMA = "tool_policy";
export const VERSIONS_TABLE = "tool_policy_versions";
export const LEDGER_TABLE = "tool_policy_migration_ledger";

const SCHEMA_RE = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(["public", "information_schema"]);

export function parseSchemaName(value: unknown): PgPolicyResult<string> {
  if (typeof value !== "string" || !SCHEMA_RE.test(value) || RESERVED.has(value) || value.startsWith("pg_")) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "نام شِما نامعتبر است؛ فقط حروف کوچک لاتین، عدد و _ (با حرف شروع، حداکثر ۴۰ نویسه) و نه public، information_schema یا pg_*." },
    };
  }
  return { ok: true, value };
}

export type TableName = typeof VERSIONS_TABLE | typeof LEDGER_TABLE;

/** `"schema"."table"` با نقل‌قولِ امن. */
export function tableRef(schema: string, table: TableName): SQL {
  return sql`${sql.identifier(schema)}.${sql.identifier(table)}`;
}

/** نامِ نقل‌قول‌شده برای `to_regclass` (شِما پیش‌تر با فهرست‌سفید اعتبارسنجی شده است). */
export const regclassName = (schema: string, table: TableName): string => `${JSON.stringify(schema)}.${table}`;
