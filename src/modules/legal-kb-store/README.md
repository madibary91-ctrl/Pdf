# legal-kb-store (لایهٔ ۲ · غیرخالص · 🔴 مهاجرت پایگاه داده = بازبینی مالک معماری)

**هدف:** ذخیرهٔ پایگاه دانش قانون (مدل `legal-kb-schema`) در **PostgreSQL**، با نسخه‌بندی زمانی که **خودِ پایگاه** تضمین می‌کند
(نبود هم‌پوشانی بازهٔ اعتبار)، و خواندن/پرس‌وجوی زمانی که با موتور خالص **یکسان** است.
**وابستگی:** فقط `legal-kb-schema`. اتصال را از بیرون می‌گیرد (`drizzle(pool)` یا `db` برنامه)؛ هرگز `process.env` یا اتصال سراسری ندارد.

> ⚠️ این ماژول **هیچ قانون واقعی ندارد** و چیزی را خودکار در پایگاه برنامه نمی‌نویسد. هیچ مسیر/صفحه‌ای هم‌اکنون آن را صدا نمی‌زند؛
> مهاجرت و درج فقط وقتی اتفاق می‌افتد که کدی صراحتاً `migrate()` / `insertCorpus()` را فراخوانی کند.
> این **بخش ۴ب‑۱** است؛ جست‌وجوی کلمه‌ای (۴ب‑۲) و ارجاع به اسناد موجود در پایگاه هنوز نیست. طراحی: `docs/adr/0004-legal-kb-store.md`.

## رابط عمومی

```ts
const made = createKbStore(db, { schema: "legal_kb" }); // schema اختیاری؛ پیش‌فرض legal_kb
if (!made.ok) return report(made.error);
const store = made.value;

await store.migrate();                // شِما + btree_gist + جدول‌ها؛ ایدمپوتنت، اتمی، زیر قفل
await store.insertCorpus(unknown);    // فقط‌افزودنی و اتمی؛ ورودی از loadCorpus می‌گذرد
await store.readCorpus();             // کل پایگاه = Corpus متعارف و بازاعتبارسنجی‌شده
await store.resolveCitation(ref, "2016-07-15");  // همان معنای legal-kb-schema، اما از پایگاه
await store.versionsInForceAt("2016-07-15");
await store.stats(); await store.migrationStatus();
```

همهٔ توابع `Promise<StoreResult<T>>` برمی‌گردانند و **هرگز پرتاب نمی‌کنند**. کد خطا (`StoreErrorCode`):
`INVALID_INPUT` · `INVALID_CORPUS` (با `issues`) · `ALREADY_EXISTS` (با `conflicts`) · `NOT_MIGRATED` · `MIGRATION_TAMPERED` ·
`MIGRATION_UNKNOWN` · `CONSTRAINT_VIOLATION` · `CORRUPT_DATA` · `DB_ERROR`. پیام خطا هرگز متن رکورد، SQL یا رشتهٔ اتصال نمی‌آورد.

## استفاده در برنامه (نمونه؛ هنوز هیچ مسیری این را صدا نمی‌زند)

```ts
import { db } from "@/db";                       // فقط در src/app یا کد سرور؛ خودِ ماژول @/db را import نمی‌کند
import { createKbStore } from "@/modules/legal-kb-store";
const made = createKbStore(db);
if (made.ok) { const m = await made.value.migrate(); /* Result؛ خطا را گزارش کنید */ }
```

## قواعد داده

| قاعده | کجا اعمال می‌شود |
|---|---|
| بازهٔ نیم‌باز `[validFrom, validTo)` | ستون تولیدشدهٔ `valid_during = daterange(valid_from, valid_to, '[)')` |
| **نبود هم‌پوشانی** نسخه‌های یک ماده | `EXCLUDE USING gist (document_id =, article_label =, valid_during &&)` — حتی با SQL دستی |
| `validTo > validFrom`؛ سال ۱۸۰۰–۲۲۰۰ (جلالی‌به‌جای‌میلادی رد می‌شود) | `CHECK` و `DOMAIN iso_date` |
| «تأییدشده» ⇒ نام و تاریخ بازبین؛ «تأییدنشده» ⇒ هیچ‌کدام؛ پیش‌فرض تأییدنشده | `CHECK … review_consistent_ck` در هر ۴ جدول منبع‌دار |
| نویسهٔ کنترلی، Trojan‑Source، BOM، CR در متن؛ سقف‌ها | `DOMAIN line_text/body_text` |
| برچسب ماده = قالب متعارف `(شماره، مکرر)`؛ تبصره/بند فهرست‌سفید | `CHECK article_label_matches_ck` و `article_subpart_label_ck` |
| ارجاع معلق، رابطهٔ خودارجاع/تکراری | کلیدهای خارجی مرکب (MATCH SIMPLE برای «کل سند») + `CHECK` + ایندکس یکتای عبارتی |
| حذف آبشاری وجود ندارد | همهٔ FKها `NO ACTION`؛ حذف رکوردِ والدِ دارای فرزند رد می‌شود |

**نشان‌دار بودن اتمی:** `insertCorpus` در یک تراکنش، زیر قفل مشورتیِ هر شِما؛ یا همه ثبت می‌شود یا هیچ. شناسهٔ تکراری بازنویسی **نمی‌شود**.
**خواندن:** تراکنش `REPEATABLE READ` فقط‌خواندنی (تصویر یکدست)؛ `readCorpus` دوباره از `loadCorpus` می‌گذرد (دادهٔ خراب = `CORRUPT_DATA`، نه خروجی نادرست).
**سپر نسخهٔ شِما:** هر عملیات ابتدا دفتر مهاجرت را با کد می‌سنجد؛ ناهمخوان/معلق = خطا، نه اجرای بی‌صدا روی شمای قدیمی.

## مهاجرت‌ها (`migrations.ts`) — 🔴

- **هرگز مهاجرتِ اعمال‌شده را ویرایش نکنید.** تغییر = مهاجرت تازه (`0002_…`) به انتهای `MIGRATIONS`. checksum در `unit.test.ts` قفل است و دفتر هر پایگاه هم checksum را نگه می‌دارد.
- SQL دست‌نویس است چون `drizzle-kit` قید `EXCLUDE`، ستون تولیدشده و DOMAIN را نمی‌تواند؛ و جدول‌ها در **شِمای جدا** هستند تا `drizzle-kit push` (که فقط `public` را می‌بیند) هرگز حذفشان نکند.
- نیاز: افزونهٔ `btree_gist` (در PG ≥ 13 «trusted»؛ مالک پایگاه کافی است).

## تست

- `unit.test.ts` — بدون پایگاه: نام شِما (فازی)، نگاشت خطا، تخت‌سازی، قفل checksum، منطق دفتر.
- `migrate.test.ts`، `constraints.test.ts`، `store.test.ts`، `temporal.test.ts` — **پایگاه واقعی**؛ هر فایل شِمای یک‌بارمصرف `legal_kb_test_<تصادفی>` می‌سازد و پاک می‌کند (به `public` و شِمای واقعی دست نمی‌زند).
  نشانی: `KB_TEST_DATABASE_URL` یا `DATABASE_URL` (یا `.env`). بدون آن، تست‌های پایگاه **رد می‌شوند**؛ در `CI=true` نبودنِ پایگاه خودش تست قرمز است.
- تفاضلی: بیش از ۴۰۰۰ بررسی `resolveCitation` (با assertion) روی ۴۱ Corpus (نمونه + ۴۰ بذر تصادفی) × روزهای مرزی، و ۲۵۰ روز `versionsInForceAt`، در برابر موتور خالص — همه‌ی وضعیت‌ها دیده می‌شوند.
- آزمون جهشی: `python3 tooling/mutation/legal-kb-store.py` (نیاز به پایگاه؛ نتیجه در یادداشت ۰۰۰۶).

## وقتی چیزی را تغییر می‌دهید
- ستون/قید/جدول تازه: مهاجرت جدید + تست قید در `constraints.test.ts` + (اگر معنا دارد) جهش در اسکریپت جهشی + بازبینی مالک معماری.
- قرارداد (`index.ts`) را بدون کار جدا عوض نکنید؛ `retrieval` و `citation-verifier` به آن تکیه می‌کنند.
- هر کد جدیدی که به پایگاه می‌نویسد باید از `insertCorpus` (یا مسیر هم‌ارزِ تست‌شده) بگذرد؛ `INSERT` مستقیم در کد برنامه ممنوع است.
