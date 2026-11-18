/**
 * نام شِما و ارجاع به جدول‌ها (داخلی). نام شِما تنها «شناسه‌ای» است که در SQL قرار می‌گیرد؛ پس فهرست‌سفید سخت‌گیرانه دارد و همیشه با
 * `sql.identifier` نقل‌قول می‌شود. همهٔ مقدارهای دیگر پارامتر پیوندی‌اند، نه الحاق رشته.
 *
 * نام جدول‌ها و دامنه‌ها پیشوند `settlement_` دارند تا این شِما بتواند (در صورت تمایل) با شِمای دفتر اعتبار مشترک باشد
 * بی‌آنکه با `migration_ledger` یا دامنه‌های ledger برخورد کند (دفتر مهاجرتِ این ماژول جدا است).
 */
import { sql, type SQL } from "drizzle-orm";
import type { PgStoreResult } from "@/modules/ledger";

export const SETTLEMENT_DEFAULT_SCHEMA = "settlement";

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
  return { ok: true, value };
}

export const TABLES = ["settlement_outbox", "settlement_migration_ledger"] as const;
export type TableName = (typeof TABLES)[number];

/** `"schema"."table"` — با نقل‌قول امن. */
export function tableRef(schema: string, table: TableName): SQL {
  return sql`${sql.identifier(schema)}.${sql.identifier(table)}`;
}
