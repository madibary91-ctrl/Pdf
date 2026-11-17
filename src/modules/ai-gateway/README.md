# ai-gateway (لایهٔ ۳ · غیرخالص · بازبینی انسانیِ اجباری نیست) — **برش ۱: هسته · برش ۲: تلاش دوباره و جایگزین**

**هدف:** واسط یکسان و ایمنِ مدل زبانی برای بقیهٔ سامانه: درخواست را روی مرز می‌سنجد، به یک **ارائه‌دهندهٔ تزریقی** می‌دهد، پاسخ را دوباره می‌سنجد، **مصرف و هزینه را با عدد صحیح** حساب می‌کند و برای هر فراخوانی یک **رویداد مصرف** می‌فرستد.
**وابستگی:** طبق `registry.ts` فقط `shared-types` (در عمل هیچ import بین‌ماژولی ندارد). به شبکه، فایل، `process.env`، ساعت سیستم و تصادف دست نمی‌زند؛ ساعت، تایمر، ارائه‌دهنده و مقصد مصرف همه **تزریق** می‌شوند (آزمونِ نگهبان این را روی کد منبع می‌سنجد).

> ⚠️ **این برش‌های ۱ و ۲ از ۵ برش‌اند.** هنوز هیچ ارائه‌دهندهٔ واقعی (HTTP)، استریم یا قیمت واقعی وجود ندارد؛ پس در `registry.ts` وضعیتش «planned» می‌ماند (تغییر وضعیت با مالک معماری، پس از برش‌های بعدی). برش ۲ (تلاش دوباره و جایگزین) در بخش «برش ۲» پایین‌تر است.
> **هیچ قیمت واقعیِ ارائه‌دهنده‌ای در مخزن نیست** (قیمت‌ها فقط از پیکربندی می‌آیند؛ AGENTS.md: جدول عددی از حافظه ساخته نمی‌شود). تصمیم‌ها: `docs/adr/0014-ai-gateway.md`.

## رابط عمومی

```ts
import { createGateway, ProviderFailure } from "@/modules/ai-gateway";

const g = createGateway({
  providers: { main: myProvider },                        // هر چیز با complete(call): Promise<ProviderReply>
  models: { "legal-chat": { provider: "main", providerModel: "…", maxInputChars: 60_000, maxOutputTokens: 4096,
                            price: { currency: "IRR", inputMicrosPerMTok: …, outputMicrosPerMTok: …, version: "prices-2026-01" } } },
  clock: { nowMs: () => Date.now() },                     // الزامی؛ پیش‌فرض ندارد
  usageSink: { record: (e) => ledger.append(e) },         // اختیاری؛ شکستش هشدار است نه از دست رفتن پاسخ
});
if (!g.ok) return report(g.error);                         // INVALID_CONFIG + issues

const r = await g.value.complete({ model: "legal-chat", messages: [...], maxOutputTokens: 800, requestId: "req-1" }, { signal });
if (!r.ok) return report(r.error);                         // code، message ثابت، retryable، retryAfterMs?، issues?، warnings
r.value; // { text, finishReason, usage, cost: { micros, currency, priceVersion }, servedModel, latencyMs, warnings }
```

| نام | کار |
|---|---|
| `createGateway(config)` | سنجش و «انجمادِ» پیکربندی؛ `Result<Gateway>` (هرگز پرتاب نمی‌کند) |
| `gateway.complete(input, { signal? })` | خط لولهٔ کامل؛ `Result<Completion>`؛ **هرگز پرتاب نمی‌کند** (حتی اگر ارائه‌دهنده/ساعت/مقصد مصرف پرتاب کند) |
| `gateway.limits(model)` | حدهای مدل برای اندازه‌گیری زمینه (`maxInputChars`، …) |
| `parseRequest`، `resolveConfig`، `computeCost`، `parsePrice`، `parseUsage` | اجزای آزمون‌پذیر |
| `ProviderFailure(kind, { retryAfterMs?, cause? })` | تنها چیزی که آداپتورها برای شکستِ شناخته‌شده پرتاب می‌کنند: `rate_limited`، `unavailable`، `auth`، `rejected` |

## ورودی — سخت‌گیر و بی‌حدس

- کلید ناشناخته رد (غلط املایی مثل `temprature` پیش‌فرض را بی‌صدا نمی‌گذارد)؛ **بیرون از بازه = رد، نه کوتاه‌کردن**.
- `maxOutputTokens` **الزامی** (۱…سقف مدل)؛ `temperature` پیش‌فرض **۰** و همیشه صریحاً به ارائه‌دهنده می‌رسد؛ `stopSequences` ≤۴ یکتا.
- پیام‌ها: ۱…۶۴؛ `system` فقط اول؛ آخرین `user`؛ تهی/فقط‌فاصله، NUL و جفت‌جانشینِ تنهای Unicode رد؛ مجموع نویسه‌ها ≤ سقف مدل (نویسه = واحد UTF-16؛ کران بالای محافظه‌کارانه).
- مدل ناشناخته `UNKNOWN_MODEL` (نام‌هایی مثل `constructor`/`__proto__` هم ناشناخته‌اند).
- همهٔ مشکل‌ها یک‌جا در `issues` می‌آیند و **فقط نام فیلد و محدودیت‌اند، هرگز محتوای پیام**.

## خطا و هشدار

خطا: `INVALID_CONFIG`، `INVALID_REQUEST`، `UNKNOWN_MODEL`، `TIMEOUT`(قابل‌تلاش)، `ABORTED`، `PROVIDER_RATE_LIMITED`(قابل‌تلاش)، `PROVIDER_UNAVAILABLE`(قابل‌تلاش)، `PROVIDER_AUTH`، `PROVIDER_REJECTED`، `PROVIDER_ERROR`، `PROVIDER_BAD_RESPONSE`، `INTERNAL_ERROR`.
پیام‌ها **ثابت**‌اند: پیام خامِ ارائه‌دهنده (که ممکن است کلید/نشانی/متن پرسش را بازتاب دهد) و استثنای داخلی هرگز در خروجی نیست. **هر استثنای ناشناخته `PROVIDER_ERROR` و غیرقابل‌تلاش است** (ممکن است هزینه شده باشد؛ پرهیز از دوباره‌خرجی).

هشدار (روی موفقیت، پنهان نمی‌ماند): `USAGE_MISSING` (ارائه‌دهنده مصرف نداد ⇒ `usage`/`cost` برابر `null`، نه ۰)، `UNPRICED`، `OUTPUT_TRUNCATED` (پاسخ بریده؛ برای متن حقوقی نباید کامل فرض شود)، `EMPTY_OUTPUT`، `USAGE_SINK_FAILED`، `USAGE_SINK_TIMEOUT` (روی شکست هم می‌آیند).

## مصرف و هزینه

`هزینه = ⌈(ورودی × قیمتِ‌ورودی + خروجی × قیمتِ‌خروجی) / ۱٬۰۰۰٬۰۰۰⌉` خرد-واحد (۱۰⁻⁶ واحد پول)، با BigInt؛ **گرد به بالا روی جمع** تا هیچ‌گاه کمتر از واقع نشود. سقف‌های اعتبارسنجی (۱۰⁹ توکن، ۱۰¹² قیمت) سرریز را ناممکن می‌کنند. هر هزینه `currency` و `priceVersion` دارد. مدلِ بی‌قیمت باید **صریحاً** `price: null` بگیرد (نبودن کلید خطاست).

**رویداد مصرف** برای **هر فراخوانیِ انجام‌شده به ارائه‌دهنده** (حتی ناموفق/مهلت/لغو) فرستاده می‌شود و **هرگز متن پیام/پاسخ ندارد**؛ اعتبارسنجی‌نشده و لغوِ پیش از فراخوانی رویداد ندارند (چیزی مصرف نشده). مصرفِ معتبر در پاسخِ خراب «نجات» داده و ثبت می‌شود.

## محدودیت‌های صادقانه

1. **مهلت یا لغو یعنی مصرفِ ناشناخته:** ارائه‌دهنده ممکن است پس از مهلت هم هزینه کرده باشد؛ رویداد `usage: null` دارد. تطبیق با صورتحساب ارائه‌دهنده کار دفتر اعتبار/گزارش است.
2. `record` با مهلت `sinkTimeoutMs` (پیش‌فرض ۵۰۰۰) منتظر می‌ماند؛ **ماندگاریِ تضمینی** (outbox) کار `ledger` است نه این هسته.
3. ساعتِ خراب (پرتاب/NaN) `INTERNAL_ERROR` می‌دهد؛ اگر پس از فراخوانی رخ دهد رویدادِ آن فراخوانی ثبت نمی‌شود. ساعتِ تزریقی باید ساده و بی‌خطا باشد.
4. ساعتِ دیواری ناهمواره (پس‌رفتن) تأخیر را `۰` می‌کند.
5. تلاش دوباره/جایگزین: برش ۲ (پایین‌تر). استریم و آداپتور HTTP: برش‌های بعدی (ADR-0014). خودِ `createGateway` هرگز تلاش دوباره نمی‌کند؛ هر فراخوانی یک‌بار است.

---

# برش ۲ — تاب‌آوری: تلاش دوباره و جایگزین (ADR-0015)

لایهٔ **بی‌حالت و بی‌I/O** روی همان هسته: `createResilientGateway(gatewayConfig, policy)`. هر تلاش یک فراخوانیِ کاملِ هسته است، پس **هر تلاشِ رسیده به ارائه‌دهنده رویداد مصرفِ خودش را دارد** و هیچ هزینه‌ای پنهان نمی‌ماند. نتیجه ساختاراً زیرنوعِ `Gateway` است (هر جا `Gateway` می‌خواهند می‌نشیند). ساعت، تایمر و تصادف همه تزریق می‌شوند.

```ts
import { createResilientGateway, RETRYABLE_CODES, FALLBACK_ELIGIBLE_CODES } from "@/modules/ai-gateway";

const g = createResilientGateway(gatewayConfig /* همان پیکربندی هسته */, {
  maxAttemptsPerModel: 3,           // ۱…۱۰ (۱ = بدون تلاش دوباره)
  maxTotalAttempts: 5,              // ۱…۲۰: سقف کلِ فراخوانی‌های رسیده به ارائه‌دهنده (همهٔ مدل‌ها)
  totalTimeoutMs: 45_000,           // ۱…۳٬۶۰۰٬۰۰۰: سقف کل زمان، شامل انتظارها
  backoff: { baseDelayMs: 500, maxDelayMs: 8_000, jitter: "full" },   // none | full | equal
  random: { next: () => rng() },    // الزامی با jitter؛ هسته Math.random ندارد
  retryOn: RETRYABLE_CODES,         // صریح: TIMEOUT، PROVIDER_RATE_LIMITED، PROVIDER_UNAVAILABLE (زیرمجموعه)
  fallbackOn: FALLBACK_ELIGIBLE_CODES,
  fallbacks: { "legal-chat": ["legal-chat-b"] },  // مدل اصلی ← جایگزین‌های مرتب (≤۵، غیرتراگذر)
});
if (!g.ok) return report(g.error);   // INVALID_CONFIG + issues (هستهٔ پیکربندی و سیاست با هم)

const r = await g.value.complete(request, { signal });
if (r.ok) { r.value.warnings; r.value.report; }   // Completion + report
else      { r.error.code; r.error.report; }       // GatewayError + report
```

## رفتار

| موضوع | قاعده |
|---|---|
| **چه چیزی تلاش می‌شود** | فقط کدی که **هم** در `retryOn` باشد **هم** هسته `retryable` برچسب زده باشد. `PROVIDER_ERROR` (ناشناخته؛ ممکن است هزینه شده باشد)، `PROVIDER_AUTH`، `PROVIDER_REJECTED`، `PROVIDER_BAD_RESPONSE` و خطاهای ورودی **هرگز**. |
| **backoff** | `min(maxDelayMs, baseDelayMs × 2^(k-1))` + jitter (`full`: `⌊raw·u⌋`؛ `equal`: `⌊raw/2 + raw/2·u⌋`). `u` از `random.next()`؛ نامعتبر/پرتاب‌کننده ⇒ `u = 1` (بی‌کاهش؛ هرگز تلاشِ زودتر). |
| **`retryAfterMs`** | کفِ انتظار: `max(backoff, retryAfterMs)`؛ **هرگز زودتر**. بزرگ‌تر از `maxDelayMs` یا از زمان باقی‌مانده ⇒ بر همان مدل تلاش نمی‌شود (جایگزین، وگرنه خطا همراه `retryAfterMs`). |
| **بودجه** | `maxAttemptsPerModel`، `maxTotalAttempts` (فقط تلاش‌های رسیده به ارائه‌دهنده)، `totalTimeoutMs`. مهلت هر تلاش = `min(مهلتِ درخواست یا مدل، زمانِ باقی‌مانده)`. |
| **جایگزین** | فقط برای کدهای `fallbackOn`، بی‌انتظار، پس از تمام‌شدن تلاش‌های همان مدل. هر جایگزین درخواست را دوباره از مرزِ هسته می‌گذراند: سقف ورودی/خروجیِ کوچک‌تر ⇒ `INVALID_REQUEST` ⇒ آن جایگزین **بی‌هزینه رد** می‌شود (درخواست هرگز کوتاه نمی‌شود). مهلتِ هر مدل از خودش (مگر مهلتِ صریحِ درخواست). |
| **لغو** | در هر نقطه (پیش از تلاش، حین تلاش، حین انتظار) فوراً `ABORTED`؛ هیچ تلاشِ تازه‌ای پس از آن؛ تایمر/شنونده نشتی ندارد. |
| **خطای نهایی** | خطای **آخرین تلاشِ رسیده به ارائه‌دهنده** (کد، `retryable`، `retryAfterMs` واقعی)؛ نه کد ساختگی (`ERROR_CODES` همچنان ۱۲ عضو). `INVALID_REQUEST`/`UNKNOWN_MODEL` بر مدل اصلی هرگز تلاش/جایگزین ندارد. |

## `report` — شفافیت، نه حدس

`report = { requestedModel, attempts[], spend[], costUnknownAttempts, stoppedBecause }` روی موفقیت **و** شکست:

- `attempts[]`: برای هر تلاش `index`، `model`، `modelAttempt`، `waitedMs`، `outcome`، `reachedProvider`، `usage`، `cost`، `latencyMs` (بی‌متن؛ بی‌پیام خام).
- `spend[]`: جمعِ هزینهٔ **همهٔ** تلاش‌های دارای هزینه (نه فقط موفق) **به‌تفکیک ارز** (ارزها هرگز جمع نمی‌شوند)، با BigInt و **هرگز کمتر از واقع**: اگر جمع از `2⁵³−1` بگذرد `micros: null` می‌شود، نه عددِ گردشده. `Completion.cost` فقط هزینهٔ **تلاشِ موفق** است؛ پس کل هزینه را از `report.spend` بخوانید.
- `costUnknownAttempts`: شمار تلاش‌های رسیده به ارائه‌دهنده که هزینه‌شان **نامعلوم** است (مهلت، لغو، مصرف‌نداده، بی‌قیمت). نامعلوم هرگز صفر نیست.
- `stoppedBecause`: `success`، `aborted`، `non_retryable`، `attempts_exhausted`، `chain_exhausted`، `retry_after_too_long`، `budget_exhausted`، `deadline`.
- هشدارهای `RETRIED` و `FELL_BACK` (روی موفقیت و شکست): یعنی هزینه/مصرفِ نتیجه کلِ ماجرا نیست، و (برای `FELL_BACK`) **داده به ارائه‌دهندهٔ دیگری رفته**. هشدارهای تلاش‌های پیشین (مثلاً `USAGE_SINK_FAILED` = رویدادِ یک تلاش ثبت نشد) روی نتیجهٔ نهایی ادغام می‌شوند.

## سیاست: بدون پیش‌فرض

همهٔ حدها و فهرست‌های `retryOn`/`fallbackOn`/`jitter` **الزامی**‌اند؛ کلید ناشناخته رد؛ ارجاع به مدلِ تعریف‌نشده رد؛ ناسازگاریِ بی‌اثر رد (مثلاً `maxAttemptsPerModel > 1` با `retryOn` تهی، یا `fallbacks` با `fallbackOn` تهی). `retryOn` فقط زیرمجموعهٔ `RETRYABLE_CODES` می‌تواند باشد. سیاست هنگام ساخت «گرفته» می‌شود.

## محدودیت‌های صادقانه (برش ۲)

1. **فراخواننده تلاش دوبارهٔ دیگری روی این لایه نگذارد** (ضرب‌شدن تلاش‌ها): مالکیت تلاش دوباره فقط اینجاست؛ `retryable: true` روی خطای نهایی یعنی «بعداً شاید»، نه «همین حالا».
2. **`TIMEOUT` = مصرفِ نامعلوم:** تلاش دوباره روی آن ممکن است دوباره‌خرجی باشد؛ انتخابش با اپراتور است (`retryOn`) و در `costUnknownAttempts` شمرده می‌شود.
3. **جایگزین = ارسال همان پیام‌ها به ارائه‌دهندهٔ دیگر.** کد اقامت داده/قرارداد را نمی‌سنجد؛ کدام ارائه‌دهنده‌ها مجازند تصمیم مالک امنیت است. `PROVIDER_ERROR` در `fallbackOn` یعنی تلاشِ پولیِ دیگر پس از شکستی که شاید هزینه شده بود.
4. **همهٔ تلاش‌های یک فراخوانی همان `requestId` را دارند** (شناسهٔ همبستگی است، نه یکتا): رویدادها با `(requestId, model, startedAtMs)` متمایزند. **`ledger` نباید فقط بر پایهٔ `requestId` تکراری‌زدایی کند.**
5. **بی‌حالت:** قطع‌کنندهٔ مدار نیست؛ هر فراخوانی از مدل اصلی شروع می‌کند، پس مدلِ از کارافتاده هر بار یک تلاشِ بی‌فایده می‌خورد تا به جایگزین برسد.
6. ساعتِ خراب (پرتاب/NaN) در میانه `INTERNAL_ERROR` می‌دهد؛ تلاش‌های انجام‌شده در `report` می‌مانند و رویدادِ همان تلاشِ آسیب‌دیده ممکن است ثبت نشده باشد. ساعتِ تزریقی باید ساده و بی‌خطا باشد. ساعتِ ناهمواره (پس‌رفتن) زمانِ باقی‌مانده را بزرگ‌تر می‌بیند؛ `maxTotalAttempts` همچنان نگهبان است.
7. انتظارِ backoff با تایمر تزریقی و مهلتِ کل با ساعتِ تزریقی سنجیده می‌شود؛ در محیط واقعی هر دو زمانِ دیواری‌اند.
8. جایگزین روی **همان ارائه‌دهنده** (مثلاً مدلِ ارزان‌تر) محدودیت نرخ را دور نمی‌زند.
