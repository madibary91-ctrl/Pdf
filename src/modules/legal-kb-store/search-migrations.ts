/**
 * مهاجرت‌های نمایهٔ جست‌وجو (🔴 ناحیهٔ پرریسک: مهاجرت پایگاه). **دفتر مستقل از `migrations.ts`**.
 *
 * چرا جدا؟
 *  - `MIGRATIONS` (۰۰۰۱، ۰۰۰۲) را تست‌های موجود دقیقاً قفل کرده‌اند (نام‌ها، checksum، «معلق» بودن ۰۰۰۲)؛ مهاجرت ۰۰۰۳ در همان فهرست = شکستن
 *    تست‌های قدیمی، و «تغییر تست قبلی» ممنوع است. شِمای دانش هم فهرست دقیق ۸ جدول دارد.
 *  - نمایه **مشتق و بازسازی‌پذیر** است (از `article_version` هر لحظه ساخته می‌شود)؛ از دست رفتنش داده نیست، پس چرخهٔ عمرِ جدا طبیعی است
 *    و می‌شود برای نقش جست‌وجو فقط SELECT داد و برای بازسازی جداگانه حق نوشتن.
 *  - مثل ممیزی (`<schema>_audit`) در شِمای خودش است: `<schema>_search`.
 *
 * قواعد همان‌هاست: مهاجرتِ اعمال‌شده هرگز ویرایش نمی‌شود (checksum در دفتر `search_ledger`)؛ هر مهاجرت در یک تراکنش.
 *
 * **عمداً بدون کلید خارجی به `article_version`:** نمایه باید بتواند کهنه/یتیم باشد و **تشخیص داده شود** (`searchStatus`) و
 * با `reindexSearch` درست شود؛ FK فقط یتیم‌ها را پنهان می‌کرد و اصلاحِ متن را به‌روزرسانی هم‌زمان ملزم می‌کرد (وابستگیِ نوشتن به نمایه).
 * **عمداً `text[]` و نه `tsvector`:** تجزیه‌گر پیش‌فرض `tsvector` به locale پایگاه وابسته است (در پایگاه `C` حروف فارسی را حرف نمی‌داند)؛
 * واژه‌ها را خودمان با `searchKey` می‌شکنیم و `GIN` روی آرایه با `@>` دقیقاً «همهٔ واژه‌ها» را می‌دهد.
 */
import type { Migration } from "./migrations";

const SS = "{{search_schema}}";

const s0001: Migration = {
  name: "0001_article_search",
  statements: [
    `CREATE TABLE ${SS}.article_search (
       document_id text NOT NULL,
       article_label text NOT NULL,
       valid_from date NOT NULL,
       content_hash text NOT NULL,
       key_fingerprint text NOT NULL,
       tokens text[] NOT NULL,
       indexed_at timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT article_search_pk PRIMARY KEY (document_id, article_label, valid_from),
       CONSTRAINT article_search_hash_ck CHECK (content_hash ~ '^[0-9a-f]{64}$'),
       CONSTRAINT article_search_fp_ck CHECK (key_fingerprint ~ '^[0-9a-f]{64}$'),
       CONSTRAINT article_search_tokens_ck CHECK (cardinality(tokens) <= 100000 AND array_position(tokens, NULL::text) IS NULL)
     )`,
    `CREATE INDEX article_search_tokens_gin ON ${SS}.article_search USING gin (tokens)`,
  ],
};

/** فهرست مرتب؛ فقط به انتها افزوده می‌شود. */
export const SEARCH_MIGRATIONS: readonly Migration[] = [s0001];

/** جایگزینی `{{search_schema}}`. `schema` باید پیشتر با `parseSchemaName` تأیید شده باشد. */
export function renderSearchStatement(statement: string, schema: string): string {
  return statement.split(SS).join(`"${schema}_search"`);
}
