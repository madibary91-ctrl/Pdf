# retrieval (لایهٔ ۳ · غیرخالص · بازبینی انسانیِ اجباری نیست)

**هدف:** پرسشِ زبان طبیعی ← بندهای قانونیِ **معتبر در تاریخِ مورد نظر**، آمادهٔ مصرف برای راستی‌آزمایی استناد و پرامپت مدل.
**وابستگی:** فقط `legal-kb-store` و `persian-text` (طبق `registry.ts`). به پایگاه، `process.env` یا ساعت سیستم دست نمی‌زند؛ جست‌وجو از یک **پورت** (`Searcher` = هر چیزی با `searchArticles`، از جمله خودِ `KbStore`) می‌آید.

> ⚠️ این ماژول **هیچ قانون یا ماده‌ای ندارد** و هیچ متنی نمی‌سازد؛ فقط آنچه ذخیره‌گاه (از جدول اصلی) می‌دهد را رتبه می‌دهد. نتیجه‌ها «ربط حقوقی» نیستند، «همخوانی واژه‌ای» هستند.
> در `registry.ts` وضعیتش «planned» مانده (تغییر وضعیت با مالک معماری). تصمیم‌ها: `docs/adr/0013-retrieval.md`.

## رابط عمومی

```ts
import { retrieve, buildContext, lookupSource } from "@/modules/retrieval";
import { createKbStore } from "@/modules/legal-kb-store";

const r = await retrieve(store, { question: "آیا فروشنده مکلف به تحویل مبیع است؟", asOf: "2024-03-01" });
if (!r.ok) return report(r.error);               // INVALID_INPUT | EMPTY_QUERY | STORE_ERROR (+ storeCode)
const { passages, plan, relaxed, incomplete } = r.value;

const ctx = buildContext(passages, { maxChars: 6000 });   // Result؛ فقط تأییدشده‌ها (پیش‌فرض)
// ctx.value.text → در پرامپت؛ مدل باید با شناسهٔ S1، S2، … ارجاع دهد
const src = lookupSource(ctx.value, modelSaidId);         // شناسهٔ جعلی ⇒ null
// src.citation = { documentId, article, subpart: null }  ← مستقیم به citation-verifier (verifyCitations)
```

| تابع | کار |
|---|---|
| `retrieve(searcher, request)` | برنامه‌ریزی پرسش ← جست‌وجوی AND کامل ← (در صورت کمبود) آرام‌سازی کنترل‌شده ← ادغام و رتبه‌بندی قطعی |
| `planQuery(question, maxTerms?)` · `planRelaxation(tokens, opts)` | خالص: واژه‌های محتوایی؛ گونه‌های آرام‌سازی |
| `buildContext(passages, opts?)` | خالص: زمینهٔ شماره‌دار با سقف نویسه |
| `lookupSource(context, id)` | شناسهٔ مدل ← ارجاع ساختاریافته، یا `null` |
| `parseRequest`، `toPassage`، `comparePassages`، `compareArticleLabels` | اجزای آزمون‌پذیر |

همه `Result` برمی‌گردانند و **هرگز پرتاب نمی‌کنند** (حتی اگر پورت پرتاب کند).

## ورودی (`RetrieveRequest`) — سخت‌گیر و بی‌حدس

`question` (≤ ۲۰۰۰ نویسه) · `asOf` **الزامی** (ISO) · `verifiedOnly` (پیش‌فرض **`true`**) · `documentId` · `limit` (۱…۱۰۰، پیش‌فرض ۱۰) · `maxTerms` (۱…۱۲، پیش‌فرض ۸) · `minCoverage` ((۰،۱]، پیش‌فرض ۰٫۶) · `maxQueries` (۱…۶۴، پیش‌فرض ۱۲).
کلید ناشناخته `INVALID_INPUT` است (غلط املایی مثل `verifiedonly` پیش‌فرضِ ایمن را بی‌صدا دور نمی‌زند). `asOf` و `verifiedOnly` **بی‌تغییر** به store می‌رسند.

## چطور کار می‌کند

1. **برنامه‌ریزی (`planQuery`):** نرمال‌سازی با همان `searchKey` نمایه؛ حذف واژه‌های دستوری/پرسشی؛ یکتاسازی؛ سقف `maxTerms` (بلندترین واژه‌ها می‌مانند).
   **هیچ واژه‌ای بی‌صدا نمی‌افتد:** `plan.stopwords`، `plan.unsearchable` (> ۶۴ نویسه) و `plan.truncated` همه را ثبت می‌کنند. فهرست واژه‌های ربطی فقط دستوری است و عمداً شامل «ماده»، «مگر»، «بدون»، «قبل/بعد»، «حق» و ارقام نیست.
2. **AND کامل:** `searchArticles` معنای AND و بدون ریشه‌یابی دارد؛ ابتدا همین اجرا می‌شود. اگر به `limit` برسد، همین‌جا تمام.
3. **آرام‌سازی کنترل‌شده:** فقط اگر کم بود، گونه‌های «یک واژه کمتر» (افتادن کوتاه‌ترین/کم‌تمایزترین واژه زودتر)، بعد «دو کمتر»، … تا کفِ `ceil(n × minCoverage)`. سطح بعدی فقط وقتی باز می‌شود که سطح پیشین به `limit` نرسیده باشد. سقف `maxQueries` فراخوانی؛ اگر جلوی بررسی همهٔ گونه‌ها را بگیرد `budgetExhausted: true`.
4. **ادغام:** یکتا بر پایهٔ (سند، ماده، آغاز اعتبار). `coverage`، `matchedTerms/missingTerms` و `score` **محلی و روی همهٔ واژه‌های پرسش** محاسبه می‌شوند (با همان `searchKey`)، نه از امتیازِ هر فراخوانی (که میان گونه‌ها قابل‌مقایسه نیست).
   ترتیب قطعی: پوشش ↓، امتیاز ↓، سند، ماده (طبیعی: «۹» پیش از «۱۰»؛ مکرر پس از ماده)، آغاز اعتبار.

## چه چیزی هرگز اتفاق نمی‌افتد

- نتیجه‌ای بیرون از `asOf` یا (با پیش‌فرض) تأییدنشده؛ آن‌ها از جدول اصلیِ store فیلتر می‌شوند و این ماژول چیزی اضافه نمی‌کند.
- پنهان ماندنِ ناقص‌بودن: نمایهٔ کهنه ⇒ `staleSkipped`/`incomplete: true` (راه‌حل: `reindexSearch()`)؛ بودجه ⇒ `budgetExhausted`؛ سقف ⇒ `hasMore`.
- نشتِ جزئیات پورت (پرتابِ خطا ⇒ پیام ثابت؛ رشتهٔ اتصال هرگز در خروجی نیست).

## زمینهٔ مدل (`buildContext`)

هر بند `[S1] <سند> — ماده <برچسب> (معتبر از … تا …)` + متن + `تبصره/بند <برچسب>: …`. **دفاع دوم:** بندِ تأییدنشده به‌طور پیش‌فرض وارد زمینه نمی‌شود (`allowUnverified: true` با علامت «تأییدنشده»).
سقف `maxChars` (۲۰۰…۲۰۰٬۰۰۰، پیش‌فرض ۶۰۰۰) **هرگز** رد نمی‌شود: نخستین بندِ بزرگ با علامتِ صریحِ برش می‌آید؛ از بند دوم، بندی که جا نشود و همهٔ پس از آن حذف و در `omitted` شمرده می‌شود (ترتیب رتبه عوض نمی‌شود). برش، جفت‌جانشین Unicode را نمی‌شکند.

## پیوند با citation-verifier (پل)

`passage.citation` همان شکل `CitationRef` است؛ لایهٔ بالاتر (ارکستراتور) این‌طور می‌بندد (قرارداد با پایگاه واقعی در `tooling/retrieval-verifier-pipeline.test.ts` آزموده شده):

```ts
const corpus = await store.readCorpus();                       // Corpus متعارف از پایگاه
const index = buildCorpusIndex(loadCorpus(corpus.value).value);
const report = verifyCitations(index, passages.map((p) => ({ ref: p.citation })), asOf);
```

راستی‌آزمایی مستقل می‌ماند: حتی اگر بازیابی یا مدل بند تأییدنشده/تاریخ دیگر/شناسهٔ جعلی بیاورد، حکم `valid` نمی‌گیرد.

## محدودیت‌های شناخته‌شده (صادقانه)

- **ریشه‌یابی/هم‌معنایی نداریم:** «تحویل» ≠ «تحویل‌دهی»؛ آرام‌سازی فقط واژه کم می‌کند، چیزی اضافه نمی‌کند. بازیابیِ برداری/معنایی (حوزهٔ `legal-kb-store` در آینده) این را بهتر می‌کند.
- هر گونه فقط **۱۰ نتیجهٔ بالای خودش** را از store می‌گیرد (`limit`)؛ اگر `hasMore` باشد ممکن است نتیجهٔ بهتری در تهِ یک گونه مانده باشد. برای پوشش بیشتر `limit` را بالا ببرید.
- پرسش‌های بلند (> `maxTerms` واژهٔ محتوایی) کوتاه‌ترین واژه‌ها را از دست می‌دهند (در `plan.truncated`)؛ پرسش را بشکنید یا `maxTerms` را تا ۱۲ بالا ببرید.
- `coverage` شباهتِ واژه‌ای است، نه ربط حقوقی؛ ربط را حقوقدان/مدل می‌سنجد.

## تست

- `query.test.ts`، `context.test.ts`، `retrieve.test.ts` — **بدون پایگاه:** مرزها، خاصیتی/تصادفی، و **تفاضلی** (۱۲۰ بذر) با اوراکلِ مستقلِ «همهٔ مواد با دست‌کم minTerms واژهٔ مطابق» روی ذخیره‌گاه ساختگیِ هم‌معنا با store (`fake-searcher.ts`، فقط تست).
- `retrieval.db.test.ts` — **پایگاه واقعی** (شِمای یک‌بارمصرف): مرز نیم‌باز، تأییدنشده، نمایهٔ کهنه، مهاجرت‌نشده، و هم‌ارزیِ ذخیره‌گاه ساختگی با store واقعی (۶۰ پرسش).
- `tooling/retrieval-verifier-pipeline.test.ts` — قرارداد میان‌ماژولی با citation-verifier.
- آزمون جهشی: `python3 tooling/mutation/retrieval.py [از تا]` (۴۰ جهش، ۰ زنده؛ دو جهشِ هم‌ارزِ مستند در سرایند اسکریپت).
