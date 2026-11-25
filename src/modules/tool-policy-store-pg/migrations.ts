/**
 * مهاجرت‌های شِمای نسخه‌های سیاست — SQL دست‌نویس (🔴 ناحیهٔ پرریسک: پول/ممیزی؛ بازبینی مالک امنیت؛ ADR-0070).
 *
 * قواعد (همان ledger/settlement):
 *  1. مهاجرتِ اعمال‌شده **هرگز ویرایش نمی‌شود**؛ تغییر = مهاجرت تازه (`0002_…`). تست، checksum را قفل کرده است.
 *  2. هر مهاجرت فهرستی از دستورها است و در **یک تراکنش** اجرا می‌شود.
 *  3. `{{schema}}` هنگام اجرا با نامِ نقل‌قول‌شدهٔ شِما (پس از فهرست‌سفید) جایگزین می‌شود. **هیچ `CREATE SCHEMA` اینجا نیست** (ADR-0070 بند ۳).
 *  4. قیدهای پایگاه **هم‌ارزِ** `parsePolicyRecord` هستند (دفاع در عمق): دادهٔ معتبر هرگز به‌خاطر قید رد نمی‌شود، ولی دادهٔ نامعتبر از هر
 *     مسیرِ دیگری (psql، اسکریپت) هم رد می‌شود. قیدِ پایگاه فقط کران و شکل را می‌سنجد؛ محتوای سیاست با `resolveToolPolicy` و کدِ جاری است.
 *  3. پیام‌های RAISE عمداً ASCII و بی‌دادهٔ رکورد هستند.
 *  6. در CHECK، `NULL` «قبول» حساب می‌شود؛ پس شرطِ روی ستونِ nullable با `IS [NOT] NULL` صریح بسته می‌شود.
 *  7. `actor` با `COLLATE "C"` تا مقایسه به locale پایگاه وابسته نباشد.
 *  8. زنجیرهٔ بی‌شکاف و فقط‌افزودنی را **خودِ پایگاه** اجرا می‌کند (تریگر): INSERT فقط با «آخرین+۱»، UPDATE/DELETE/TRUNCATE هرگز.
 *     (مالکِ جدول یا ابَرکاربر می‌تواند تریگر را بردارد؛ برای همین `status()` وجودِ تریگرها را می‌سنجد و `append` در جلسهٔ ناامن بسته می‌شود
 *     و برنامه باید فقط `INSERT`/`SELECT` بگیرد (README).)
 */
import { createHash } from "node:crypto";

export type Migration = Readonly<{ name: string; statements: readonly string[] }>;

const S = "{{schema}}";
const T = `${S}.tool_policy_versions`;

/** کنترل‌ها، جداکننده‌های خط/بند و کنترل‌های جهتِ دوسویه (همان FORBIDDEN_REASON_CHARS مدیر)؛ نیم‌فاصلهٔ فارسی U+200C مجاز است. */
const REASON_FORBIDDEN = "[\\u0001-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]";

const m0001: Migration = {
  name: "0001_init",
  statements: [
    `CREATE TABLE ${T} (
       version bigint NOT NULL,
       overrides jsonb NOT NULL,
       policy jsonb NOT NULL,
       changes jsonb NOT NULL,
       source_kind text NOT NULL,
       source_to_version bigint,
       actor text COLLATE "C" NOT NULL,
       reason text NOT NULL,
       created_at_ms bigint NOT NULL,
       CONSTRAINT tool_policy_versions_pk PRIMARY KEY (version),
       CONSTRAINT tool_policy_versions_version_ck CHECK (version >= 1 AND version <= 9007199254740991),
       CONSTRAINT tool_policy_versions_overrides_ck CHECK (jsonb_typeof(overrides) = 'object'),
       CONSTRAINT tool_policy_versions_policy_ck CHECK (jsonb_typeof(policy) = 'object'),
       CONSTRAINT tool_policy_versions_changes_ck CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) <= 64),
       CONSTRAINT tool_policy_versions_source_ck CHECK (
         (source_kind = 'set' AND source_to_version IS NULL)
         OR (source_kind = 'rollback' AND source_to_version IS NOT NULL AND source_to_version >= 1 AND source_to_version <= version)
       ),
       CONSTRAINT tool_policy_versions_actor_ck CHECK (actor ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
       CONSTRAINT tool_policy_versions_reason_ck CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '${REASON_FORBIDDEN}'),
       CONSTRAINT tool_policy_versions_time_ck CHECK (created_at_ms >= 0 AND created_at_ms <= 9007199254740991)
     )`,

    `CREATE FUNCTION ${S}.tool_policy_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       IF TG_OP = 'INSERT' THEN
         IF NEW.version <> COALESCE((SELECT max(version) FROM ${T}), 0) + 1 THEN
           RAISE EXCEPTION 'tool_policy: a version must be exactly the latest plus one' USING ERRCODE = 'integrity_constraint_violation';
         END IF;
         RETURN NEW;
       END IF;
       RAISE EXCEPTION 'tool_policy: versions are append-only' USING ERRCODE = 'integrity_constraint_violation';
     END
     $fn$`,
    `CREATE TRIGGER tool_policy_versions_chain BEFORE INSERT ON ${T}
       FOR EACH ROW EXECUTE FUNCTION ${S}.tool_policy_versions_guard()`,
    `CREATE TRIGGER tool_policy_versions_immutable BEFORE UPDATE OR DELETE ON ${T}
       FOR EACH ROW EXECUTE FUNCTION ${S}.tool_policy_versions_guard()`,

    `CREATE FUNCTION ${S}.tool_policy_versions_forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN
       RAISE EXCEPTION 'tool_policy: the version history is never truncated' USING ERRCODE = 'integrity_constraint_violation';
     END
     $fn$`,
    `CREATE TRIGGER tool_policy_versions_no_truncate BEFORE TRUNCATE ON ${T}
       FOR EACH STATEMENT EXECUTE FUNCTION ${S}.tool_policy_versions_forbid_truncate()`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [m0001];

/** نام‌های مورد انتظار (برای `status()` و نگهبانِ نوشتن)؛ منبعِ واحدش همین فایل است و آزمون با متنِ مهاجرت تطبیقشان می‌دهد. */
export const EXPECTED_TRIGGERS: readonly string[] = ["tool_policy_versions_chain", "tool_policy_versions_immutable", "tool_policy_versions_no_truncate"];
export const EXPECTED_CONSTRAINTS: readonly string[] = [
  "tool_policy_versions_pk",
  "tool_policy_versions_version_ck",
  "tool_policy_versions_overrides_ck",
  "tool_policy_versions_policy_ck",
  "tool_policy_versions_changes_ck",
  "tool_policy_versions_source_ck",
  "tool_policy_versions_actor_ck",
  "tool_policy_versions_reason_ck",
  "tool_policy_versions_time_ck",
];

export function migrationChecksum(m: Migration): string {
  return createHash("sha256").update(m.name).update("\u0000").update(m.statements.join("\u0000")).digest("hex");
}

/** `{{schema}}` ← نامِ نقل‌قول‌شده؛ نام پیش‌تر با `parseSchemaName` سنجیده شده (فقط `[a-z0-9_]`)، پس تزریق ممکن نیست. */
export function renderStatement(statement: string, schema: string): string {
  return statement.split("{{schema}}").join(`"${schema}"`);
}
