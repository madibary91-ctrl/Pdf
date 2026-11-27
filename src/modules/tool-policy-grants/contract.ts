/**
 * قراردادِ حقوقِ نقشِ زمانِ اجرای سیاستِ ابزار (ADR-0081) — منبعِ حقیقتِ یگانهٔ «برنامه چه می‌تواند».
 *
 * اشتقاق (نه از حافظه): همان دستورهایی که `tool-policy-store-pg` در زمانِ اجرا می‌زند و آزمونِ PostgreSQLِ واقعی (با نقشِ بی‌امتیاز) کفایتشان را
 * و ضرورتِ تک‌تکشان را (حذفِ هر حق ⇒ شکستِ یک عملیات) ثابت می‌کند:
 *  - شِما: `USAGE` (حلِ نامِ جدول‌ها، `to_regclass`). `CREATE` هرگز: برنامه DDL نمی‌زند.
 *  - `tool_policy_versions`: `SELECT` (latest/get/list/status، و تریگرِ زنجیره `max(version)` می‌خواند) و `INSERT` (append). `UPDATE`/`DELETE`/`TRUNCATE` هرگز:
 *    فقط‌افزودنی بودن علاوه بر تریگر با **نبودنِ حق** هم اجرا می‌شود (دو لایه).
 *  - `tool_policy_migration_ledger`: فقط `SELECT` (`assertCurrent` دفتر را می‌خواند). نوشتنِ دفتر کارِ نقشِ مهاجرت است.
 * نام‌ها نسخهٔ ایستای نامِ ذخیره‌ساز است؛ آزمونِ همارزیِ tooling آن‌ها را با متنِ مهاجرت و شِمای واقعی (کاملیت: هر جدولِ شِما در قرارداد است) قفل می‌کند.
 */

export const DEFAULT_POLICY_SCHEMA = "tool_policy";
export const VERSIONS_TABLE = "tool_policy_versions";
export const LEDGER_TABLE = "tool_policy_migration_ledger";

export type TableName = typeof VERSIONS_TABLE | typeof LEDGER_TABLE;
export type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE" | "REFERENCES" | "TRIGGER";
export type SchemaPrivilege = "USAGE" | "CREATE";

/** همهٔ حق‌های جدولی که روی PostgreSQL ۱۴–۱۶ پرس‌وجو می‌شوند (`MAINTAIN` از ۱۷ است و عمداً بیرون است؛ README). */
export const TABLE_PRIVILEGES: readonly TablePrivilege[] = Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]);
export const SCHEMA_PRIVILEGES: readonly SchemaPrivilege[] = Object.freeze(["USAGE", "CREATE"]);

/** قراردادِ زمانِ اجرا: دقیقاً همین حق‌ها، نه کمتر و نه بیشتر. */
export const RUNTIME_CONTRACT = Object.freeze({
  schema: Object.freeze<readonly SchemaPrivilege[]>(["USAGE"]),
  tables: Object.freeze<Readonly<Record<TableName, readonly TablePrivilege[]>>>({
    [VERSIONS_TABLE]: Object.freeze<readonly TablePrivilege[]>(["SELECT", "INSERT"]),
    [LEDGER_TABLE]: Object.freeze<readonly TablePrivilege[]>(["SELECT"]),
  }),
});

export const CONTRACT_TABLES: readonly TableName[] = Object.freeze([VERSIONS_TABLE, LEDGER_TABLE]);

type Parsed<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

const SCHEMA_RE = /^[a-z][a-z0-9_]{0,39}$/;
const SCHEMA_RESERVED = new Set(["public", "information_schema"]);

/** همان فهرست‌سفیدِ `parseSchemaName` ذخیره‌ساز (آزمونِ همارزیِ ۲۰۰۰ نام در tooling). */
export function parseSchema(value: unknown): Parsed<string> {
  if (typeof value !== "string" || !SCHEMA_RE.test(value) || SCHEMA_RESERVED.has(value) || value.startsWith("pg_")) return { ok: false };
  return { ok: true, value };
}

const ROLE_RE = /^[a-z][a-z0-9_]{0,62}$/;
/** نقش‌های رزروشده: pseudo-roleها و `postgres` (ابَرکاربرِ پیش‌فرض)؛ نام همیشه نقل‌قول می‌شود ولی این‌ها هرگز نقشِ زمانِ اجرا نیستند. */
const ROLE_RESERVED = new Set(["public", "postgres", "none", "user", "current_user", "current_role", "session_user"]);

/** نامِ نقش فقط حروفِ کوچکِ لاتین، رقم و `_` (حداکثر ۶۳ نویسه)، نه `pg_*` و نه رزروشده؛ پس نقل‌قول‌کردنِ `"…"` تزریق‌ناپذیر است. */
export function parseRole(value: unknown): Parsed<string> {
  if (typeof value !== "string" || !ROLE_RE.test(value) || ROLE_RESERVED.has(value) || value.startsWith("pg_")) return { ok: false };
  return { ok: true, value };
}
