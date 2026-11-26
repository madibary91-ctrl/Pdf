# tool-policy-store-pg (لایهٔ ۶ · ناخالص (پایگاه) · 🔴 بازبینی انسانیِ اجباری: مالک امنیت + مالک پایگاه داده) — برش CT‑5c‑2b‑2

**هدف:** آداپتورِ PostgreSQL پورتِ `PolicyVersionStore` (از `tool-policy-admin`): تاریخچهٔ نسخه‌های سیاستِ دروازهٔ ابزار **ماندگار، فقط‌افزودنی و بی‌شکاف** باشد و این ناوردا را **خودِ پایگاه** اجرا کند (نه فقط کد). تصمیم‌ها: `docs/adr/0070-tool-policy-store-pg.md`.
**وابستگی:** فقط رابطِ عمومیِ `tool-policy-admin` (`parsePolicyRecord`، نوع‌ها) و `drizzle-orm`. اتصال نمی‌سازد، `process.env` نمی‌خواند و رشتهٔ اتصال نمی‌شناسد: `drizzle(pool)` را از بیرون می‌گیرد.

> ⚠️ هنوز به مسیرِ محصول وصل نیست (`planned`): ریشهٔ I/O (CT‑5c‑2c) و HTTP/UI (2b‑3، پس از `identity`) ساخته نشده‌اند. بازبینیِ مالک امنیت انجام نشده.

## رابط
```ts
import { createPgPolicyVersionStore } from "@/modules/tool-policy-store-pg";
import { createToolPolicyAdmin } from "@/modules/tool-policy-admin";

const made = createPgPolicyVersionStore(drizzle(pool), { schema: "tool_policy", statementTimeoutMs: 5000 });
if (!made.ok) throw new Error(made.error.code);            // فقط INVALID_INPUT (نامِ شِما/مهلت)
const store = made.value;

await store.migrate();   // یک‌بار در استقرار؛ idempotent؛ زیرِ قفل؛ شِما باید از پیش وجود داشته باشد
await store.status();    // فقط‌خواندنی: مهاجرت‌ها، قیدها/تریگرها، شمارِ ردیف، بی‌شکافی، ready
const admin = createToolPolicyAdmin({ store, clock });   // store همان پورتِ PolicyVersionStore است
```
`latest/get/append/list` هرگز نمی‌پرتابند؛ خطا فقط `{ ok:false, error:{ code } }` با `CONFLICT | INVALID | UNAVAILABLE` است (پورت). `migrate/status` خطای ساختاریافته (`PgPolicyError`) می‌دهند: متنِ ثابتِ فارسی + SQLSTATE؛ **هرگز** متنِ خطای pg، SQL، رشتهٔ اتصال یا دادهٔ رکورد.

## چه چیزی را خودِ پایگاه اجرا می‌کند (دفاع در عمق)
- **تریگرِ `tool_policy_versions_chain`:** `INSERT` فقط وقتی `version = آخرین+۱` (۱ در جدولِ خالی)؛ شکاف و تکرار رد (`23000`).
- **تریگرِ `tool_policy_versions_immutable`:** هر `UPDATE`/`DELETE` رد؛ **`…_no_truncate`:** `TRUNCATE` رد.
- **کلیدِ اصلیِ `version` + `ON CONFLICT DO NOTHING`:** در مسابقه دقیقاً یک برنده؛ بازنده `CONFLICT` می‌گیرد (استثنا نیست).
- **قیدهای CHECK هم‌ارزِ `parsePolicyRecord`:** شکلِ `actor`، طولِ `reason` و نبودنِ کنترل‌های جهتِ دوسویه/جداکنندهٔ خط، شکلِ `source`، نوعِ jsonb‌ها، سقفِ `changes`، زمانِ نامنفی. (محتوای سیاست را پایگاه نمی‌سنجد؛ آن با `resolveToolPolicy` و کدِ جاری است.)

## قواعد
- هر ردیفِ خوانده‌شده دوباره با `parsePolicyRecord` ساخته می‌شود (ذخیره‌ساز یک مرزِ ورودی است). ردیفِ خراب ⇒ `INVALID` (مدیر آن را `STORE_FAILURE` می‌کند)؛ **هرگز** نادیده گرفته نمی‌شود و `list` با یک ردیفِ خراب کامل شکست می‌خورد.
- هر عملیات **و `status()`** (ADR‑0074) یک تراکنشِ کوتاه با `statement_timeout`/`lock_timeout` (پیش‌فرض ۵ ثانیه؛ `SET LOCAL` معادل، پس به اتصالِ استخر نشت نمی‌کند) و `read only` برای خواندن. ذخیره‌سازِ پشتِ نویسندهٔ تأییدنشدهٔ هم‌نسخه معلق نمی‌ماند: `UNAVAILABLE`.
- پیش از هر عملیات checksumِ مهاجرت‌ها با کد سنجیده می‌شود؛ ناهمخوان/معلق/ناشناخته ⇒ `UNAVAILABLE`. پیش از هر **نوشتن** تریگرها باید فعال و `session_replication_role = origin` باشد وگرنه `UNAVAILABLE` (نوشتن بسته می‌شود، نه بی‌نگهبان).
- `list`: `limit` ≤ ۱۰۰۰ (`STORE_LIMITS.maxListLimit`)؛ بیشتر `INVALID` (صفحهٔ کوتاه در مدیر «پایان» است، پس بریدنِ بی‌صدا ممنوع).
- مهاجرتِ اعمال‌شده **هرگز ویرایش نمی‌شود**؛ تغییر = مهاجرتِ تازه. آزمون checksum را قفل کرده است.

## استقرار (اقدامِ مالک پایگاه)
1. **شِما را خودتان بسازید** (این ماژول `CREATE SCHEMA` نمی‌زند؛ ADR‑0070 بند ۳): `CREATE SCHEMA tool_policy;`
2. با نقشِ مدیر `store.migrate()` را یک‌بار اجرا کنید (CLI و بوت‌استرپ برشِ 2c است؛ تا آن زمان از اسکریپتِ استقرارِ خودتان).
3. **نقشِ برنامه فقط `SELECT` و `INSERT`** روی `tool_policy_versions` و `SELECT` روی `tool_policy_migration_ledger` بگیرد، و `USAGE` روی شِما؛ مالکِ جدول یا ابَرکاربر می‌تواند تریگر را بردارد (`status()` و نگهبانِ نوشتن آن را می‌بینند، ولی جلوی مالک را نمی‌گیرند).
4. `status()` را در پایشِ استقرار بزنید؛ `ready:false` یا `problems` غیرتهی ⇒ مداخلهٔ انسانی.

## محدودیت‌های شناخته‌شده (صادقانه)
- **شِما ساخته نمی‌شود** و CLIِ مهاجرت ندارد (2c)؛ تا آن‌جا استقرار دستی است.
- **ابَرکاربر/مالک جدول** می‌تواند تاریخچه را دست‌کاری کند؛ دفاعِ ما فقط تشخیص (`status`) و بسته‌شدنِ نوشتن است، نه جلوگیری. زنجیرهٔ هش‌دار (ضدِ دست‌کاریِ مالک) انجام نشده.
- `created_at_ms` را مدیر از ساعتِ تزریقی می‌دهد؛ پایگاه یکنوایی‌اش را نمی‌سنجد (چندنمونه‌ای با ساعتِ ناهمگام ممکن است زمانِ نزولی بنویسد).
- نگهبانِ نوشتن یک رفت‌وبرگشتِ اضافه به ازای هر `append` است (ترافیکِ ادمین کم است؛ عمداً).
- قیدِ `reason` با `char_length` (نقطه‌کد) می‌سنجد و مدیر با طولِ UTF‑16؛ پایگاه کمی آزادتر است (دفاع در عمق، نه مرزِ اصلی). فرض: پایگاه UTF8 است.
- چندنمونه‌ای: اعلانِ تغییر نیست؛ هر نمونه باید `current()` را دوره‌ای بخواند (2c).
- `status()` شمارش (`count(*)`) می‌کند؛ برای جدولِ ادمین (ده‌ها ردیف) ارزان است.
- `status()` پشتِ جدولِ قفل‌شده پس از ≈ `statementTimeoutMs` با `DB_ERROR` (`pgCode` ‏`57014` یا `55P03`) برمی‌گردد، نه آویزان؛ **`migrate()` عمداً بی‌سقف است** (DDL؛ قفلِ مشورتی و `CREATE/ALTER` پشتِ قفلِ دیگران می‌مانند — تصمیمِ مهلتِ مهاجرت با CLIِ 2c‑3). انتظارِ گرفتنِ اتصال از استخر هم زیرِ این سقف نیست (`connectionTimeoutMillis` استخرِ میزبان).
