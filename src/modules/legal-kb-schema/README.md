# legal-kb-schema (لایهٔ ۲ · خالص · 🔴 بازبینی حقوقدان)

**هدف:** مدل داده‌ی پایگاه دانش قانون (قانون ← ماده ← نسخهٔ زمانی؛ رابطه؛ رأی) + اعتبارسنجی سخت‌گیرانه + جست‌وجوی «کدام متن در این تاریخ معتبر بود؟». بدون I/O.
**وابستگی:** فقط `shared-types`.

> ⚠️ **این ماژول هیچ قانون واقعی ندارد.** تنها داده‌اش `FICTIONAL_SAMPLE_CORPUS` است و کاملاً ساختگی (برای تست و میز آزمایش).
> بارگذاری قانون واقعی بخش ۴ج است و منبع رسمی + تأیید حقوقدان می‌خواهد.
> در `registry.ts` وضعیتش «planned» مانده (بازبینی انسانی باز است؛ تغییر وضعیت با مالک معماری).
> طراحی و دلیل‌ها: `docs/adr/0003-legal-kb-schema.md`.

## رابط عمومی

| تابع | کار |
|---|---|
| `loadCorpus(unknown)` / `loadCorpusFromJson(text)` | **تنها دروازهٔ ورود داده.** `Result<Corpus, CorpusIssue[]>`؛ همهٔ مسائل با مسیر و پیام فارسی؛ خروجی متعارف و خودتوان |
| `buildCorpusIndex(corpus)` | شاخص خواندنی (فقط روی خروجی `loadCorpus` درست است) |
| `resolveCitation(index, ref, isoDate)` | `VersionLookup` صریح؛ `Result` فقط برای ورودی بد |
| `versionsInForceAt(index, isoDate)` | همهٔ مواد معتبر در تاریخ (برای فیلتر تاریخ بازیابی) |
| `relationsFor` · `rulingsCiting` · `findDocument` · `findArticle` | جست‌وجوهای کمکی |
| `parseArticleLabel` · `canonicalArticleLabel` · `canonicalSubpartLabel` | نرمال‌سازی برچسب |
| `formatCitationKey` / `parseCitationKey` | کلید پایدار ارجاع: `doc/10-bis/note/2` |
| `isValidIsoDate` · `parseIsoDate` · `isValidDocumentId` | اعتبارسنجی‌های کوچک |

## قواعد داده (خلاصه)

- **تاریخ:** فقط میلادی ISO `YYYY-MM-DD`، سال ۱۸۰۰–۲۲۰۰. جلالی در مرز تبدیل می‌شود، نه در این مدل.
- **نسخه:** بازهٔ نیم‌باز `[validFrom, validTo)`؛ `validTo` صریح (`null` = بی‌پایان)؛ هم‌پوشانی و `validFrom` تکراری خطا؛ شکاف مجاز.
- **ماده:** برچسب متعارف `10` · `10 مکرر` · `10 مکرر 2` · `واحده`. شناسه‌ها محاسبه می‌شوند؛ `۱۰` و `10` یک ماده‌اند.
- **بازبینی:** پیش‌فرض `pending-legal-review`؛ `legally-verified` فقط با `reviewedBy` و `reviewedOn`.
- **متن:** نویسهٔ کنترلی و علامت‌های جهت‌دهی (U+202A–202E، U+2066–2069) و BOM ممنوع؛ نیم‌فاصله و LRM/RLM مجاز؛ CRLF → LF.

## مثال

```ts
const loaded = loadCorpusFromJson(text);
if (!loaded.ok) return report(loaded.error); // [{code, path, message}, …]
const index = buildCorpusIndex(loaded.value);
const r = resolveCitation(index, { documentId: "sample-law", article: "۱۰ مکرر", subpart: null }, "2016-07-15");
if (r.ok && r.value.status === "found" && r.value.verified) { /* قابل استناد */ }
```

## وقتی چیزی را تغییر می‌دهید
- نوع سند/رأی/رابطهٔ تازه: فقط `types.ts` + تست‌ها + ADR (تصمیم مالک).
- قاعدهٔ تازهٔ یکپارچگی: `integrity.ts` + تست «سخت‌گیری/یکپارچگی» + یک جهش در `tooling/mutation/legal-kb-schema.py`.
- قرارداد (`index.ts`) را بدون کار جدا تغییر ندهید؛ `citation-verifier` و `legal-kb-store` به آن تکیه می‌کنند.

## آزمون جهشی
`python3 tooling/mutation/legal-kb-schema.py` — هر جهش باید تست را قرمز کند (۳۳ جهش؛ نتیجه در یادداشت ۰۰۰۵).
