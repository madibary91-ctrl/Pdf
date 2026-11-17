/**
 * مهاجرت‌های شِمای پایگاه دانش — SQL دست‌نویس (🔴 ناحیهٔ پرریسک: بازبینی مالک معماری).
 *
 * چرا SQL دست‌نویس و نه `drizzle-kit push`؟ قیدهای اصلیِ این مدل را drizzle-kit نمی‌تواند بیان کند:
 *   • `EXCLUDE USING gist` (نبودِ هم‌پوشانی بازهٔ اعتبار نسخه‌ها — خودِ پایگاه، نه فقط برنامه)،
 *   • ستون تولیدشدهٔ `daterange` نیم‌باز، DOMAINهای بازبینی نویسه، و ایندکس یکتای عبارتی.
 * همچنین همهٔ جدول‌ها در **شِمای جدا** (`legal_kb`) هستند تا `drizzle-kit push` (که فقط `public` را می‌بیند) هرگز
 * آن‌ها را «اضافی» نداند و حذف نکند.
 *
 * قواعد:
 *  1. مهاجرتِ اعمال‌شده **هرگز ویرایش نمی‌شود**؛ تغییر = مهاجرت تازه (`0002_…`). تست، checksum را قفل کرده است.
 *  2. هر مهاجرت فهرستی از دستورهای جدا است (نه یک رشتهٔ چنددستوری) و در **یک تراکنش** اجرا می‌شود.
 *  3. `{{schema}}` هنگام اجرا با نام نقل‌قول‌شدهٔ شِما (پس از اعتبارسنجی فهرست‌سفید) جایگزین می‌شود.
 *  4. قیدهای پایگاه **هم‌ارز یا ملایم‌تر** از `loadCorpus` هستند و هرگز سخت‌گیرتر نیستند؛ دادهٔ معتبر هرگز به‌خاطر قید رد نمی‌شود،
 *     ولی دادهٔ نامعتبری که از مسیر دیگر (psql، اسکریپت) بیاید، باز هم رد می‌شود (دفاع در عمق).
 */
import { createHash } from "node:crypto";

export type Migration = Readonly<{ name: string; statements: readonly string[] }>;

const S = "{{schema}}";

/** نویسهٔ کنترلی، علامت‌های جهت‌دهی Trojan-Source و BOM — همان فهرست `reader.ts` در legal-kb-schema (NUL در متن پستگرس ممکن نیست). */
const FORBIDDEN = String.raw`[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]`;

/** ستون‌های منبع و بازبینی (هر رکورد حقوقی منبع و وضعیت بازبینی دارد). */
const provenanceColumns = `
  source_name ${S}.line_text NOT NULL,
  source_url text,
  source_kind text NOT NULL,
  retrieved_on ${S}.iso_date,
  review_status text NOT NULL DEFAULT 'pending-legal-review',
  reviewed_by ${S}.line_text,
  reviewed_on ${S}.iso_date`;

const provenanceConstraints = (t: string) => `
  CONSTRAINT ${t}_source_name_len_ck CHECK (char_length(source_name) <= 300),
  CONSTRAINT ${t}_source_url_ck CHECK (source_url IS NULL OR (char_length(source_url) <= 2048 AND source_url ~* ${String.raw`'^https?://[^ \t\r\n\f\v<>"'']+$'`})),
  CONSTRAINT ${t}_source_kind_ck CHECK (source_kind IN ('official', 'secondary')),
  CONSTRAINT ${t}_review_status_ck CHECK (review_status IN ('pending-legal-review', 'legally-verified')),
  CONSTRAINT ${t}_reviewed_by_len_ck CHECK (char_length(reviewed_by) <= 200),
  CONSTRAINT ${t}_review_consistent_ck CHECK (
    (review_status = 'pending-legal-review' AND reviewed_by IS NULL AND reviewed_on IS NULL)
    OR (review_status = 'legally-verified' AND reviewed_by IS NOT NULL AND reviewed_on IS NOT NULL))`;

const m0001: Migration = {
  name: "0001_init",
  statements: [
    // ───────── DOMAINها: قید نویسه و تاریخ یک‌بار و برای همهٔ ستون‌ها ─────────
    `CREATE DOMAIN ${S}.iso_date AS date
       CONSTRAINT iso_date_range_ck CHECK (VALUE BETWEEN DATE '1800-01-01' AND DATE '2200-12-31')`,
    `CREATE DOMAIN ${S}.line_text AS text
       CONSTRAINT line_text_ck CHECK (
         VALUE <> '' AND char_length(VALUE) <= 500 AND position(E'\\n' in VALUE) = 0 AND VALUE !~ '${FORBIDDEN}')`,
    `CREATE DOMAIN ${S}.body_text AS text
       CONSTRAINT body_text_ck CHECK (
         VALUE <> '' AND char_length(VALUE) <= 200000 AND position(E'\\r' in VALUE) = 0 AND VALUE !~ '${FORBIDDEN}')`,

    // ───────── سند ─────────
    `CREATE TABLE ${S}.document (
       seq bigint NOT NULL,
       id text NOT NULL,
       kind text NOT NULL,
       title ${S}.line_text NOT NULL,
       short_title ${S}.line_text,
       enacted_on ${S}.iso_date,${provenanceColumns},
       CONSTRAINT document_pk PRIMARY KEY (id),
       CONSTRAINT document_seq_uq UNIQUE (seq),
       CONSTRAINT document_seq_ck CHECK (seq > 0),
       CONSTRAINT document_id_ck CHECK (char_length(id) <= 64 AND id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
       CONSTRAINT document_kind_ck CHECK (kind IN ('constitution', 'statute', 'regulation', 'directive', 'approval')),
       CONSTRAINT document_title_len_ck CHECK (char_length(title) <= 300),
       CONSTRAINT document_short_title_len_ck CHECK (char_length(short_title) <= 100),${provenanceConstraints("document")}
     )`,

    // ───────── ماده: شناسه = (سند، برچسب متعارف)؛ برچسب باید با (شماره، مکرر) بخواند ─────────
    // article_number: ۰ = «واحده»، ۱…۹۹۹۹۹ = شماره؛ article_repeat: ۰ = بدون مکرر، ۱ = «مکرر»، n≥۲ = «مکرر n».
    `CREATE TABLE ${S}.article (
       document_id text NOT NULL,
       label text NOT NULL,
       article_number integer NOT NULL,
       article_repeat integer NOT NULL DEFAULT 0,
       CONSTRAINT article_pk PRIMARY KEY (document_id, label),
       CONSTRAINT article_order_uq UNIQUE (document_id, article_number, article_repeat),
       CONSTRAINT article_document_fk FOREIGN KEY (document_id) REFERENCES ${S}.document (id),
       CONSTRAINT article_number_ck CHECK (article_number BETWEEN 0 AND 99999),
       CONSTRAINT article_repeat_ck CHECK (article_repeat BETWEEN 0 AND 99 AND (article_number > 0 OR article_repeat = 0)),
       CONSTRAINT article_label_matches_ck CHECK (
         label = CASE
           WHEN article_number = 0 THEN 'واحده'
           WHEN article_repeat = 0 THEN article_number::text
           WHEN article_repeat = 1 THEN article_number::text || ' مکرر'
           ELSE article_number::text || ' مکرر ' || article_repeat::text
         END)
     )`,

    // ───────── نسخهٔ زمانی: بازهٔ نیم‌باز [valid_from, valid_to) و قید نبود هم‌پوشانی در خودِ پایگاه ─────────
    `CREATE TABLE ${S}.article_version (
       document_id text NOT NULL,
       article_label text NOT NULL,
       valid_from ${S}.iso_date NOT NULL,
       valid_to ${S}.iso_date,
       valid_during daterange GENERATED ALWAYS AS (daterange(valid_from, valid_to, '[)')) STORED,
       body ${S}.body_text NOT NULL,${provenanceColumns},
       CONSTRAINT article_version_pk PRIMARY KEY (document_id, article_label, valid_from),
       CONSTRAINT article_version_article_fk FOREIGN KEY (document_id, article_label) REFERENCES ${S}.article (document_id, label),
       CONSTRAINT article_version_interval_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
       CONSTRAINT article_version_no_overlap EXCLUDE USING gist (document_id WITH =, article_label WITH =, valid_during WITH &&),${provenanceConstraints("article_version")}
     )`,

    // ───────── تبصره/بند ─────────
    `CREATE TABLE ${S}.article_subpart (
       document_id text NOT NULL,
       article_label text NOT NULL,
       valid_from ${S}.iso_date NOT NULL,
       ordinal integer NOT NULL,
       kind text NOT NULL,
       label text NOT NULL,
       body ${S}.body_text NOT NULL,
       CONSTRAINT article_subpart_pk PRIMARY KEY (document_id, article_label, valid_from, kind, label),
       CONSTRAINT article_subpart_order_uq UNIQUE (document_id, article_label, valid_from, ordinal),
       CONSTRAINT article_subpart_version_fk FOREIGN KEY (document_id, article_label, valid_from)
         REFERENCES ${S}.article_version (document_id, article_label, valid_from),
       CONSTRAINT article_subpart_kind_ck CHECK (kind IN ('note', 'clause')),
       CONSTRAINT article_subpart_label_ck CHECK (label ~ '^([1-9][0-9]{0,2}|[آابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی]{1,6})$'),
       CONSTRAINT article_subpart_ordinal_ck CHECK (ordinal BETWEEN 0 AND 99)
     )`,

    // ───────── رابطه ─────────
    // کلید ارجاع مرکب با MATCH SIMPLE: وقتی ماده تهی است (رابطه با کل سند) فقط FK سند اعمال می‌شود.
    `CREATE TABLE ${S}.relation (
       seq bigint NOT NULL,
       type text NOT NULL,
       from_document_id text NOT NULL,
       from_article text,
       to_document_id text NOT NULL,
       to_article text,
       effective_from ${S}.iso_date,
       note ${S}.body_text,${provenanceColumns},
       CONSTRAINT relation_pk PRIMARY KEY (seq),
       CONSTRAINT relation_seq_ck CHECK (seq > 0),
       CONSTRAINT relation_type_ck CHECK (type IN ('amends', 'repeals', 'replaces', 'refers-to', 'implements', 'interprets')),
       CONSTRAINT relation_from_document_fk FOREIGN KEY (from_document_id) REFERENCES ${S}.document (id),
       CONSTRAINT relation_from_article_fk FOREIGN KEY (from_document_id, from_article) REFERENCES ${S}.article (document_id, label),
       CONSTRAINT relation_to_document_fk FOREIGN KEY (to_document_id) REFERENCES ${S}.document (id),
       CONSTRAINT relation_to_article_fk FOREIGN KEY (to_document_id, to_article) REFERENCES ${S}.article (document_id, label),
       CONSTRAINT relation_not_self_ck CHECK (NOT (from_document_id = to_document_id AND from_article IS NOT DISTINCT FROM to_article)),
       CONSTRAINT relation_note_len_ck CHECK (char_length(note) <= 2000),${provenanceConstraints("relation")}
     )`,
    `CREATE UNIQUE INDEX relation_dedupe_uq ON ${S}.relation
       (type, from_document_id, coalesce(from_article, ''), to_document_id, coalesce(to_article, ''), coalesce(effective_from, DATE '9999-12-31'))`,
    `CREATE INDEX relation_from_ix ON ${S}.relation (from_document_id, from_article)`,
    `CREATE INDEX relation_to_ix ON ${S}.relation (to_document_id, to_article)`,

    // ───────── رأی ─────────
    `CREATE TABLE ${S}.ruling (
       seq bigint NOT NULL,
       id text NOT NULL,
       kind text NOT NULL,
       number ${S}.line_text NOT NULL,
       issuer ${S}.line_text NOT NULL,
       issued_on ${S}.iso_date NOT NULL,
       title ${S}.line_text,
       body ${S}.body_text NOT NULL,${provenanceColumns},
       CONSTRAINT ruling_pk PRIMARY KEY (id),
       CONSTRAINT ruling_seq_uq UNIQUE (seq),
       CONSTRAINT ruling_seq_ck CHECK (seq > 0),
       CONSTRAINT ruling_id_ck CHECK (char_length(id) <= 64 AND id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
       CONSTRAINT ruling_kind_ck CHECK (kind IN ('unity-ruling', 'constitutional-opinion', 'advisory-opinion', 'judgment')),
       CONSTRAINT ruling_number_len_ck CHECK (char_length(number) <= 100),
       CONSTRAINT ruling_issuer_len_ck CHECK (char_length(issuer) <= 300),
       CONSTRAINT ruling_title_len_ck CHECK (char_length(title) <= 300),${provenanceConstraints("ruling")}
     )`,
    `CREATE TABLE ${S}.ruling_cite (
       ruling_id text NOT NULL,
       ordinal integer NOT NULL,
       document_id text NOT NULL,
       article_label text,
       CONSTRAINT ruling_cite_pk PRIMARY KEY (ruling_id, ordinal),
       CONSTRAINT ruling_cite_ruling_fk FOREIGN KEY (ruling_id) REFERENCES ${S}.ruling (id),
       CONSTRAINT ruling_cite_document_fk FOREIGN KEY (document_id) REFERENCES ${S}.document (id),
       CONSTRAINT ruling_cite_article_fk FOREIGN KEY (document_id, article_label) REFERENCES ${S}.article (document_id, label),
       CONSTRAINT ruling_cite_ordinal_ck CHECK (ordinal BETWEEN 0 AND 199)
     )`,
    `CREATE UNIQUE INDEX ruling_cite_dedupe_uq ON ${S}.ruling_cite (ruling_id, document_id, coalesce(article_label, ''))`,
    `CREATE INDEX ruling_cite_target_ix ON ${S}.ruling_cite (document_id, article_label)`,
  ],
};

/** فهرست مرتب مهاجرت‌ها؛ فقط به انتها افزوده می‌شود. */
export const MIGRATIONS: readonly Migration[] = [m0001];

/** SHA-256 نام و دستورها؛ هر تغییر (حتی یک فاصله) در مهاجرتِ اعمال‌شده با «MIGRATION_TAMPERED» دیده می‌شود. */
export function migrationChecksum(m: Migration): string {
  return createHash("sha256").update(JSON.stringify([m.name, m.statements])).digest("hex");
}

/** جایگزینی `{{schema}}` با نام نقل‌قول‌شده. `schema` باید پیشتر با `parseSchemaName` تأیید شده باشد. */
export function renderStatement(statement: string, schema: string): string {
  return statement.split(S).join(`"${schema}"`);
}
