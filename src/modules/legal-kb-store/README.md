# legal-kb-store (لایهٔ ۲ · غیرخالص · 🔴 مهاجرت پایگاه داده = بازبینی مالک معماری)

**هدف:** ذخیرهٔ پایگاه دانش قانون (مدل `legal-kb-schema`) در **PostgreSQL**، با نسخه‌بندی زمانی که **خودِ پایگاه** تضمین می‌کند
(نبود هم‌پوشانی بازهٔ اعتبار)، و خواندن/پرس‌وجوی زمانی که با موتور خالص **یکسان** است.
**وابستگی:** `legal-kb-schema` و (از ۴ب‑۳) `persian-text`. اتصال را از بیرون می‌گیرد (`drizzle(pool)` یا `db` برنامه)؛ هرگز `process.env` یا اتصال سراسری ندارد.

> ⚠️ این ماژول **هیچ قانون واقعی ندارد** و چیزی را خودکار در پایگاه برنامه نمی‌نویسد. هیچ مسیر/صفحه‌ای هم‌اکنون آن را صدا نمی‌زند؛
> مهاجرت و درج فقط وقتی اتفاق می‌افتد که کدی صراحتاً `migrate()` / `insertCorpus()` را فراخوانی کند.
> **بخش ۴ب‑۱** (ذخیره و خواندن): `docs/adr/0004-legal-kb-store.md`. **بخش ۴ب‑۲** (مسیر اعتماد، ممیزی، درج افزایشی): `docs/adr/0005-legal-kb-trust-and-incremental.md`.
> **بخش ۴ب‑۳** (جست‌وجوی کلمه‌ای، نمایهٔ مشتق): `docs/adr/0009-legal-kb-keyword-search.md`. ⚠️ `markVerified`/`correctVersion` هویت را نمی‌سنجند؛ فقط پشت لایهٔ احراز هویت و نقش صدا زده شوند.

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

// ── ۴ب‑۲ ──
await store.insertIncremental(unknown); // مثل insertCorpus ولی رابطه/رأی می‌تواند به اسناد و مواد موجود در پایگاه ارجاع دهد
const ref = { documentId: "sample-law", article: "2", validFrom: "2001-01-01" };
// متنی که حقوقدان دیده → هش آن؛ تأیید فقط روی همان متن می‌نشیند (وگرنه CONFLICT)
const expectedHash = versionContentHash(versionTheLawyerSaw);
await store.markVerified(ref, { expectedHash, reviewedBy: "…", reviewedOn: "2025-03-01" });
await store.revokeVerification(ref, { expectedHash, revokedBy: "…", revokedOn: "…", reason: "…" });
await store.correctVersion(ref, { expectedHash, text, subparts, correctedBy: "…", correctedOn: "…", reason: "…" }); // تأیید پاک می‌شود
await store.listAudit(ref /* یا null */, { limit: 100 });   // فقط‌افزودنی؛ قبل/بعد هر تغییر
```

همهٔ توابع `Promise<StoreResult<T>>` برمی‌گردانند و **هرگز پرتاب نمی‌کنند**. کد خطا (`StoreErrorCode`):
`INVALID_INPUT` · `INVALID_CORPUS` (با `issues`) · `ALREADY_EXISTS` (با `conflicts`) · `NOT_MIGRATED` · `MIGRATION_TAMPERED` ·
`MIGRATION_UNKNOWN` · `CONSTRAINT_VIOLATION` · `CORRUPT_DATA` · `DB_ERROR` · `NOT_FOUND` · `CONFLICT` (هش کهنه یا وضعیت نادرست برای کنش). پیام خطا هرگز متن رکورد، SQL یا رشتهٔ اتصال نمی‌آورد.

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

## مسیر اعتماد و ممیزی (۴ب‑۲)
- **هر تغییر یک رکورد ممیزی فقط‌افزودنی دارد، در همان تراکنش** (`<schema>_audit.version_audit`، تریگر ضد UPDATE/DELETE/TRUNCATE، بدون FK). ممیزی از ردیف مرجع بیشتر عمر می‌کند.
- **compare-and-set با `versionContentHash`:** کنشگر هشِ متنِ دیده‌شده را می‌دهد؛ ناهمخوان ⇒ `CONFLICT`؛ قفل ردیف (`FOR UPDATE`).
- **تأیید:** فقط `pending → verified`؛ تأییدِ دوباره `CONFLICT`. **پس‌گرفتن:** فقط `verified → pending` با دلیل. **اصلاح:** متن/تبصره‌ها عوض می‌شود، **تأیید پاک می‌شود**، متن پیشین در ممیزی می‌ماند؛ بازه و منبع هرگز عوض نمی‌شود؛ اصلاح بی‌تغییر رد می‌شود.
- ورودی‌ها از قواعد `loadCorpus` می‌گذرند و **شکل متعارف** نوشته می‌شود (مثلاً CRLF ⇒ LF).
- **درج افزایشی:** از پایگاه فقط «اسکلت» سندهای ارجاع‌شده خوانده می‌شود و با ورودی یک‌جا اعتبارسنجی می‌شود (مسیر مسائل به ایندکس ورودی)؛ فقط بخش نو درج می‌شود؛ سقف ۲۰۰ سند بیرونی.
- محدودیت‌ها: `actor` خوداظهار است؛ تأیید فقط روی نسخهٔ ماده؛ تناقض فقط میان سندهای درگیرِ اسکلت سنجیده می‌شود.

## مهاجرت‌ها (`migrations.ts`) — 🔴

- **هرگز مهاجرتِ اعمال‌شده را ویرایش نکنید.** تغییر = مهاجرت تازه (`0002_…`) به انتهای `MIGRATIONS`. checksum در `unit.test.ts` قفل است و دفتر هر پایگاه هم checksum را نگه می‌دارد.
- SQL دست‌نویس است چون `drizzle-kit` قید `EXCLUDE`، ستون تولیدشده و DOMAIN را نمی‌تواند؛ و جدول‌ها در **شِمای جدا** هستند تا `drizzle-kit push` (که فقط `public` را می‌بیند) هرگز حذفشان نکند.
- نیاز: افزونهٔ `btree_gist` (در PG ≥ 13 «trusted»؛ مالک پایگاه کافی است).

## جست‌وجوی کلمه‌ای (بخش ۴ب‑۳)

```ts
await store.migrateSearch();   // یک‌بار: شِمای <schema>_search + دفتر مستقل (migrate() آن را نمی‌سازد)
await store.reindexSearch();   // پس از هر درج/اصلاح: افزایشی و ایدمپوتنت → { indexed, updated, unchanged, removed, totalVersions }
const r = await store.searchArticles({ text: "تحویل مبیع", asOf: "2024-03-01" });
// ok ⇒ { tokens, asOf, verifiedOnly: true, hits: [{ ref, documentTitle, validTo, text, subparts, provenance, verified, contentHash, matches }], hasMore, staleSkipped }
await store.searchStatus();    // { totalVersions, indexed, missing, stale, orphans, upToDate, keyFingerprint, migrations }
```

- **معنا:** همهٔ واژه‌ها (AND) به‌صورت **واژهٔ کامل** (نه زیررشته) در متن یا تبصره/بندها؛ نوشته‌های هم‌ارز (ی/ک عربی، ارقام فارسی/عربی/لاتین، «مادهٔ»، اعراب، کشیده، نیم‌فاصله) یکی‌اند چون هر دو سمت از `searchKey` ماژول `persian-text` می‌گذرند. نیم‌فاصله واژه را می‌شکند (`کتاب‌ها` ⇒ `کتاب`، `ها`)؛ ریشه‌یابی/جمع/پیشوند نداریم.
- **`asOf` الزامی است** (ساعت سیستم پیش‌فرض ندارد)؛ فقط نسخهٔ معتبر در آن روز (بازهٔ نیم‌باز).
- **پیش‌فرض ایمن: `verifiedOnly: true`.** `false` «در انتظار بازبینی» را هم می‌آورد و هر نتیجه `verified` دارد. کلید ناشناخته (مثل `verifiedonly`) `INVALID_INPUT` است تا پیش‌فرض ایمن بی‌صدا دور زده نشود.
- **رتبه:** `matches` = جمع دفعات ظاهر شدن واژه‌ها؛ هم‌امتیاز ⇒ ترتیب سند و ماده (قطعی). معیار «ربط حقوقی» نیست.
- **نمایه فقط مکان‌یاب است:** متن/منبع/تأیید همیشه از جدول‌های اصلی‌اند. هر نتیجه با متن واقعی بازبینی می‌شود؛ نمایهٔ کهنه (متن اصلاح‌شده، قاعدهٔ نرمال‌سازیِ عوض‌شده، دست‌کاری) نتیجه را **حذف و در `staleSkipped` می‌شمارد**، هرگز متن کهنه یا مثبتِ کاذب برنمی‌گرداند. اگر `staleSkipped > 0` یا `searchStatus().upToDate === false`: `reindexSearch()`.
- تأیید/پس‌گرفتنِ تأیید بی‌درنگ در جست‌وجو اثر می‌کند (بدون reindex)؛ اصلاح متن و درج تازه تا `reindexSearch` در نمایه نیستند (جدید ⇒ دیده نمی‌شود؛ اصلاح‌شده ⇒ حذف تا بازسازی).
- حدها: ≤ ۵۰۰ نویسه، ≤ ۱۲ واژهٔ متمایز (بی‌صدا برش نمی‌خورد)، هر واژه ≤ ۶۴ نویسه، `limit` ۱…۱۰۰ (پیش‌فرض ۲۰).

تست: `search-text.test.ts` (بدون پایگاه)، `search.test.ts` (پایگاه واقعی + **تفاضلی** با اوراکل خالص روی ۲۵ بذر × ۴۰۰ پرسش). آزمون جهشی: `python3 tooling/mutation/legal-kb-store-search.py [از تا]`.

## تست

- `unit.test.ts` — بدون پایگاه: نام شِما (فازی)، نگاشت خطا، تخت‌سازی، قفل checksum، منطق دفتر.
- `migrate.test.ts`، `constraints.test.ts`، `store.test.ts`، `temporal.test.ts` — **پایگاه واقعی**؛ هر فایل شِمای یک‌بارمصرف `legal_kb_test_<تصادفی>` می‌سازد و پاک می‌کند (به `public` و شِمای واقعی دست نمی‌زند).
  نشانی: `KB_TEST_DATABASE_URL` یا `DATABASE_URL` (یا `.env`). بدون آن، تست‌های پایگاه **رد می‌شوند**؛ در `CI=true` نبودنِ پایگاه خودش تست قرمز است.
- تفاضلی: بیش از ۴۰۰۰ بررسی `resolveCitation` (با assertion) روی ۴۱ Corpus (نمونه + ۴۰ بذر تصادفی) × روزهای مرزی، و ۲۵۰ روز `versionsInForceAt`، در برابر موتور خالص — همه‌ی وضعیت‌ها دیده می‌شوند.
- ۴ب‑۲: `trust.unit.test.ts` (بدون پایگاه: هش محتوا با مقدار طلایی، اعتبارسنجی ورودی، اسکلت زمینه، قفل checksum ۰۰۰۲)،
  `trust.test.ts` (تأیید/پس‌گرفتن/اصلاح، ممیزی فقط‌افزودنی، مسابقه‌ها، قفل ردیفِ قطعی، ارتقا از ۰۰۰۱)،
  `incremental.test.ts` (**تفاضلی:** «A سپس افزایشیِ B ≡ درج یک‌جای A∪B» روی نمونه و ۲۵ بذر تصادفی؛ اعتبارسنجی ترکیبی؛ اتمی و هم‌زمانی).
  هر تست store خودش را همان‌جا می‌بندد (`afterEach`) چون شمار اتصال پستگرس محدود است.
- آزمون جهشی: `python3 tooling/mutation/legal-kb-store.py [از تا]` (نیاز به پایگاه؛ نتیجه در یادداشت‌های ۰۰۰۶ و ۰۰۰۷). تست‌های «ویرایش‌ناپذیر» (قفل checksum) عمداً کنار گذاشته می‌شوند.

## وقتی چیزی را تغییر می‌دهید
- ستون/قید/جدول تازه در شِمای دانش: مهاجرت جدید (در `migrations.ts`، پس از هماهنگی با تست‌هایی که فهرست را قفل کرده‌اند) + تست قید در `constraints.test.ts` + (اگر معنا دارد) جهش در اسکریپت جهشی + بازبینی مالک معماری.
- قرارداد (`index.ts`) را بدون کار جدا عوض نکنید؛ `retrieval` و `citation-verifier` به آن تکیه می‌کنند.
- هر کد جدیدی که به پایگاه می‌نویسد باید از `insertCorpus` (یا مسیر هم‌ارزِ تست‌شده) بگذرد؛ `INSERT` مستقیم در کد برنامه ممنوع است.
