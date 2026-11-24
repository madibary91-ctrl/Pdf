# metered-tool-gateway (لایهٔ ۴ · غیرخالص (دفتر و دروازه تزریق می‌شوند) · **بازبینی انسانیِ اجباری: مالک امنیت**) — برش MT-1

**هدف:** دروازه‌ای که **خودش یک `ToolGateway`** است و پیش از هر گامِ «مدل با ابزار» بدترین‌هزینه را در دفتر اعتبار رزرو می‌کند و پس از گام هزینهٔ واقعی را مصرف و باقیمانده را آزاد یا صریحاً سوخت می‌کند. تصمیم‌ها و دلیل‌ها: `docs/adr/0062-metered-tool-gateway.md`.
**چرا لازم بود:** `createMeteredGateway` فقط `Gateway.complete` را می‌پیچد؛ حلقهٔ ابزار `ToolGateway.completeStep` را صدا می‌زند، پس هر گامِ ابزار **بی‌رزرو و بی‌ثبت** می‌رفت.
**وابستگی:** فقط رابط عمومی `ai-gateway`، `ledger` و `metering` (طبق `registry.ts`). به شبکه، فایل، `process.env`، ساعت، تصادف و پایگاه دست نمی‌زند (آزمونِ منبع در `tooling/` می‌سنجد).

> ⚠️ **MT-1 از چند برش است.** به مسیرِ محصول وصل نیست؛ رفتگرِ رزروهای معلق/outbox (settlement) به آن سیم نشده؛ احراز هویت/مستأجر لایهٔ هویت است؛ بازبینیِ مالک امنیت انجام نشده. با پولِ واقعی وصل نکنید.

## رابط
```ts
const made = createMeteredToolGateway({
  gateway,                    // createToolGateway(...)؛ باید completeStep/toolFormat/limits داشته باشد
  ledger,                     // createLedger({ store, clock }) — حساب باید با واحد "IRR_MICROS" باز باشد
  account: { tenantId, accountId },
  currency: "IRR",
  models,                     // همان جدولِ مدل‌های دروازه (price و maxOutputTokens)؛ ناهمخوانی با gateway.limits در ساخت رد می‌شود
  scopeId,                    // برای هر پرسش یک شناسهٔ تازه؛ رزرو `<scopeId>.r<n>`؛ استفادهٔ دوباره ⇒ SCOPE_REUSED
  reservationTtlMs,           // باید از زمانِ کلِ یک گام بیشتر باشد
  perMessageOverheadTokens,   // صریح و بی‌پیش‌فرض؛ برای ابزارها گشاده‌دستانه
  onUnknownCost,              // "forfeit" | "release"؛ صریح و بی‌پیش‌فرض
});                           // MeteringResult؛ هرگز نمی‌پرتابد
const g = made.value;         // ToolGateway + receipts() + summary()
const service = createCalcAnswerService({ gateway: g, loop, model, ... });   // بی‌تغییر
```
کلیدهای `fallbacks` و `maxProviderCalls` **نیستند**: دروازهٔ ابزار تلاش دوباره و جایگزین ندارد؛ هر گام دقیقاً یک تماس است.

## قواعد (خلاصه)
- **بی‌رزرو، بی‌تماس.** هر ردّ (درخواست نامعتبر، مدل ناشناخته/بی‌قیمت/ارزِ دیگر، سرریز، اعتبار ناکافی، حساب ناموجود، `SCOPE_REUSED`، شکستِ دفتر) پیش از دروازهٔ درونی است و `INTERNAL_ERROR` با `retryable:false` می‌دهد؛ علتِ دقیق در `error.metering.refusal`.
- **رزرو** = `max(۱, بدترین‌هزینهٔ یک گام)`؛ ورودی = بایت‌های UTF‑8 + سربارِ هر بخش، روی **همهٔ بخش‌های ارسالی**: پیام‌ها، بدنهٔ ابزارها (`encodeTools`) و هر پیامِ `continuation`.
- **عکسِ یک‌بارهٔ درخواست** (JSON رفت‌وبرگشتی): همان چیزی که برآورد می‌شود عیناً به دروازه می‌رسد (بستنِ TOCTOU).
- **تسویه:** هزینهٔ معلوم ⇒ `charge` + `close(release)`؛ اثباتاً بی‌تماس (`INVALID_REQUEST`/`UNKNOWN_MODEL`/`INVALID_CONFIG`) ⇒ `release`؛ نامعلوم ⇒ کفِ معلوم `charge` و باقیمانده طبق `onUnknownCost` با زنگ `COST_UNKNOWN`. **گامِ شکست‌خورده با `error.cost` معتبر هزینهٔ معلوم است** (پاسخِ بریده/خراب هزینه شده).
- **شکست تسویه هرگز بی‌نشان نیست:** تا ۳ تلاش فوری (idempotent)؛ سپس `SETTLEMENT_PENDING`/`CLOSE_PENDING`/`UNBILLED`.
- `summary()`: جمعِ رسیدهای همین نمونه (= یک پرسش) با `needsAttention`؛ `receipts()`: تا ۲۵۶ رسیدِ بی‌متن.

## محدودیت‌ها (صادقانه)
- برآوردِ ورودی کرانِ بایتی است؛ قالبِ پنهانِ ابزارِ ارائه‌دهنده دیده نمی‌شود ⇒ `perMessageOverheadTokens` را مالک تعیین می‌کند؛ کمبود = `SHORTFALL` با زنگ (مازاد وصول نمی‌شود).
- منطقِ تسویه **بازنویسیِ** `metering` است (آن ماژول داخلی است)؛ انحراف را `parity.test.ts` می‌گیرد.
- جدولِ `models` را باید فراخواننده همان جدولِ دروازه بدهد؛ فقط `priced` و `maxOutputTokens` با `gateway.limits` سنجیده می‌شود (قیمتِ عددی از دروازه خوانده نمی‌شود).
- پرسش‌ها مستقل‌اند: بودجهٔ **تجمعیِ** چندپرسش و رفتگرِ رزروِ معلق این‌جا نیست.

## آزمون
`gateway` (رفتاری)، `config`، `units` (estimate/observe)، `parity` (همسانی با metering)، `property` (۳۰۰ بذرِ قطعی با داورِ مستقل و ادعای پوشش)، و در `tooling/`: `metered-tool-gateway-source.test.ts` (نگهبان منبع) و `metered-tool-gateway-e2e.test.ts` (زنجیرهٔ کامل با دفتر اعتبارِ واقعی و `calc-answer-service`، هر دو قالبِ سیم).
