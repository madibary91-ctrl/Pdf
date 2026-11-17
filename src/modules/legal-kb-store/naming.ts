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
  if (value.endsWith(AUDIT_SUFFIX)) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: `نام شِما نمی‌تواند به «${AUDIT_SUFFIX}» ختم شود؛ این پسوند برای شِمای ممیزی (<نام>${AUDIT_SUFFIX}) رزرو است.` },
    };
  }
  if (value.endsWith(SEARCH_SUFFIX)) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: `نام شِما نمی‌تواند به «${SEARCH_SUFFIX}» ختم شود؛ این پسوند برای شِمای نمایهٔ جست‌وجو (<نام>${SEARCH_SUFFIX}) رزرو است.` },
    };
  }
  return { ok: true, value };
}

/** پسوند شِمای نمایهٔ جست‌وجو (بخش ۴ب‑۳، ADR-0009). نمایه مشتق و بازسازی‌پذیر است و در شِمای خودش می‌ماند. */
export const SEARCH_SUFFIX = "_search";

/** نام شِمای نمایهٔ جست‌وجو؛ `schema` باید پیشتر با `parseSchemaName` تأیید شده باشد (≤ ۴۰ نویسه ⇒ ≤ ۴۷، زیر سقف ۶۳ پستگرس). */
export function searchSchemaName(schema: string): string {
  return `${schema}${SEARCH_SUFFIX}`;
}

/** `"<schema>_search"."<table>"` — با نقل‌قول امن. */
export function searchTableRef(schema: string, table: "article_search" | "search_ledger"): SQL {
  return sql`${sql.identifier(searchSchemaName(schema))}.${sql.identifier(table)}`;
}

/** پسوند شِمای ممیزی. شِمای ممیزی جدا است تا فهرست جدول‌های شِمای دانش ثابت بماند و بشود دسترسی‌ها را جدا داد (ADR-0005). */
export const AUDIT_SUFFIX = "_audit";

/** نام شِمای ممیزیِ یک store؛ `schema` باید پیشتر با `parseSchemaName` تأیید شده باشد (≤ ۴۰ نویسه ⇒ ≤ ۴۶، زیر سقف ۶۳ پستگرس). */
export function auditSchemaName(schema: string): string {
  return `${schema}${AUDIT_SUFFIX}`;
}

/** `"<schema>_audit"."version_audit"` — با نقل‌قول امن. */
export function auditRef(schema: string): SQL {
  return sql`${sql.identifier(auditSchemaName(schema))}.${sql.identifier("version_audit")}`;
}

export const TABLES = ["document", "article", "article_version", "article_subpart", "relation", "ruling", "ruling_cite", "migration_ledger"] as const;
export type TableName = (typeof TABLES)[number];

/** `"schema"."table"` — با نقل‌قول امن. */
export function tableRef(schema: string, table: TableName): SQL {
  return sql`${sql.identifier(schema)}.${sql.identifier(table)}`;
}
