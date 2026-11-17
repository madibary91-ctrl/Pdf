# ai-gateway (لایهٔ ۳ · غیرخالص · بازبینی انسانیِ اجباری نیست) — **برش ۱: هسته**

**هدف:** واسط یکسان و ایمنِ مدل زبانی برای بقیهٔ سامانه: درخواست را روی مرز می‌سنجد، به یک **ارائه‌دهندهٔ تزریقی** می‌دهد، پاسخ را دوباره می‌سنجد، **مصرف و هزینه را با عدد صحیح** حساب می‌کند و برای هر فراخوانی یک **رویداد مصرف** می‌فرستد.
**وابستگی:** طبق `registry.ts` فقط `shared-types` (در عمل هیچ import بین‌ماژولی ندارد). به شبکه، فایل، `process.env`، ساعت سیستم و تصادف دست نمی‌زند؛ ساعت، تایمر، ارائه‌دهنده و مقصد مصرف همه **تزریق** می‌شوند (آزمونِ نگهبان این را روی کد منبع می‌سنجد).

> ⚠️ **این فقط برش ۱ از ۵ برش است.** هنوز هیچ ارائه‌دهندهٔ واقعی (HTTP)، تلاش دوباره/جایگزین، استریم یا قیمت واقعی وجود ندارد؛ پس در `registry.ts` وضعیتش «planned» می‌ماند (تغییر وضعیت با مالک معماری، پس از برش‌های بعدی).
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
5. نیاز به تلاش دوباره/جایگزین، استریم، آداپتور HTTP: برش‌های بعدی (ADR-0014).
