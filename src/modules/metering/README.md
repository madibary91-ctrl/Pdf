# metering (لایهٔ ۴ · غیرخالص (دفتر و دروازه تزریق می‌شوند) · **بازبینی انسانیِ اجباری: مالک امنیت**) — برش م۱

**هدف:** دروازه‌ای که **خودش یک `Gateway`** است و پیش از هر تماس مدل بدترین‌هزینه را در دفتر اعتبار رزرو می‌کند، پس از تماس هزینهٔ واقعی را مصرف و باقیمانده را آزاد یا صریحاً سوخت می‌کند. تصمیم‌ها و دلیل‌ها: `docs/adr/0020-metering.md`.
**وابستگی:** فقط رابط عمومی `ai-gateway` و `ledger` (طبق `registry.ts`). به شبکه، فایل، `process.env`، ساعت سیستم، تصادف و پایگاه دست نمی‌زند (آزمونِ نگهبان روی کد منبع می‌سنجد؛ دفتر و دروازه تزریق می‌شوند).

> ⚠️ **م۱ از ۴ برش است.** هنوز به کاربر/پول واقعی وصل نکنید: احراز هویت/مستأجر (م۲)، رفتگر رزروهای معلق و outbox (م۳) و خرید (م۴) نیست؛ بازبینی مالک امنیت انجام نشده.

## رابط
```ts
const made = createMeteredGateway({
  gateway,                       // createGateway / createResilientGateway
  ledger,                        // createLedger({ store, clock }) — حساب باید با واحد "IRR_MICROS" باز باشد
  account: { tenantId, accountId },
  currency: "IRR",               // واحد حساب = `${currency}_MICROS` (ADR-0020 تصمیم ۲)
  models,                        // همان GatewayConfig.models (فقط price و maxOutputTokens خوانده می‌شود)
  fallbacks,                     // همان سیاست دروازهٔ تاب‌آور
  scopeId,                       // دامنهٔ یکتایی؛ رزرو `<scopeId>.r<n>`؛ استفادهٔ دوباره ⇒ SCOPE_REUSED
  reservationTtlMs,              // باید از زمان کل یک complete بیشتر باشد
  maxProviderCalls,              // = maxTotalAttempts دروازهٔ تاب‌آور (ساده: ۱)
  perMessageOverheadTokens,      // صریح و بی‌پیش‌فرض
  onUnknownCost,                 // "forfeit" | "release"؛ صریح و بی‌پیش‌فرض
});                              // MeteringResult<MeteredGateway>؛ هرگز نمی‌پرتابد
const r = await made.value.complete(request);   // GatewayResult + `metering` روی موفقیت و خطا
```
`MeteredGateway` ساختاراً `Gateway` است؛ ارکستراتور بی‌تغییر آن را می‌گیرد. `metering` رسیدی بی‌متن است: `outcome` (`billed | released | forfeited | refused | unbilled | settlement-failed`)، `reservationId`، `reserved`، `charged`، `shortfall`، `refusal?` و `alarms`.

## قواعد (خلاصه)
- **بی‌رزرو، بی‌تماس.** هر رد (درخواست نامعتبر، مدل ناشناخته/بی‌قیمت/ارز دیگر، سرریز، اعتبار ناکافی، حساب ناموجود، `SCOPE_REUSED`، شکست دفتر) پیش از دروازهٔ درونی است و به `GatewayError` با کد `INTERNAL_ERROR` و `retryable: false` می‌رسد؛ علتِ دقیق در `error.metering.refusal`.
- **رزرو** = `max(۱, بدترین‌هزینهٔ‌یک‌تماس × maxProviderCalls)`؛ ورودی = بایت‌های UTF‑8 + سربار هر پیام؛ بیشینه روی زنجیرهٔ جایگزین‌ها.
- **تسویه:** هزینهٔ معلوم ⇒ `charge` + `close(release)`؛ اثباتاً بی‌تماس ⇒ `release`؛ نامعلوم ⇒ کفِ معلوم `charge` و باقیمانده طبق `onUnknownCost` با زنگ `COST_UNKNOWN`.
- **شکست تسویه هرگز بی‌نشان نیست:** تا ۳ تلاش فوری (idempotent)؛ سپس `SETTLEMENT_PENDING`/`CLOSE_PENDING`/`UNBILLED` (رزرو معلق با سررسید آزاد می‌شود؛ رفتگر = م۳).
- `SHORTFALL` = مصرف از رزرو بیشتر شد (کران ورودی کم بود): مازاد وصول‌نشده و **زنگ عملیاتی** است.

## آزمون
`estimate`/`cost`/`config` (خالص)، `metered-gateway` (رفتاری)، `metering.integration` (دروازهٔ تاب‌آور واقعی + دفتر حافظه‌ای و PostgreSQL)، `metering.property` (تصادفی + خطای تزریقی + ادعای پوشش)، `purity` (نگهبان منبع). جهشی: `python3 tooling/mutation/metering.py`.
