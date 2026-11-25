# durable-tool-gateway (لایهٔ ۵ · غیرخالص (دفتر، outbox و دروازه تزریق می‌شوند) · **بازبینی انسانیِ اجباری: مالک امنیت**) — برش MT-2

**هدف:** `metered-tool-gateway` را روی دفتر تسویهٔ ماندگار (`settlement`) می‌نشاند: هر گامِ ابزار **پیش از تماس** هم رزرو و هم در outbox ثبت می‌شود؛ مرگِ فرایند وسط تماس، شکستِ مصرف/بستن و شکستِ ثبتِ قصد را رفتگرِ `settlement` با تکرارِ idempotent می‌بندد. تصمیم‌ها: `docs/adr/0063-durable-tool-gateway.md`.
**چرا لازم بود:** `metered-tool-gateway` تنها روی دفترِ خام، شکستِ تسویه را فقط با «رسیدِ معلق» نشان می‌داد و رزروِ بی‌ردّ ماندگار با سررسید آزاد می‌شد (= کاربر مجانی). برای `metering` کارخانهٔ ماندگار بود، برای گامِ ابزار نبود.
**وابستگی:** در کدِ منبع فقط رابط عمومی `metered-tool-gateway` و `settlement`؛ `ledger`/`ai-gateway` فقط در ابزارِ آزمون. منطقِ پول بازنویسی **نمی‌شود**.

> ⚠️ به مسیرِ محصول وصل نیست؛ رفتگر را کسی باید روی همان outbox و **دفترِ خام** بالا بیاورد (settlement-runtime/host). بازبینیِ مالک امنیت انجام نشده. با پولِ واقعی وصل نکنید.

## رابط
```ts
const made = createDurableToolGateway({
  gateway, ledger /* دفترِ خام */, account, currency, models, scopeId, reservationTtlMs, perMessageOverheadTokens, onUnknownCost, // همان گزینه‌های createMeteredToolGateway
  outbox,    // SettlementOutbox (حافظه‌ای یا PostgreSQL)
  clock,     // همان ساعتِ دفتر
  graceMs,   // مهلتِ تماس پیش از آنکه رفتگر رکورد را سررسیده بداند
});                                   // SettlementResult<MeteredToolGateway>؛ هرگز نمی‌پرتابد
const sweeper = createSettlementSweeper({ ledger /* همان دفترِ خام */, outbox, clock });
const service = createCalcAnswerService({ gateway: made.value, ... });   // بی‌تغییر
```
## قواعد (خلاصه)
- `onUnknownCost` یک بار داده می‌شود و هم برای دروازه هم برای رزروِ یتیمِ outbox است.
- `reservationTtlMs ≥ 2 × graceMs` (وگرنه ساخت رد می‌شود).
- `ledger` دفترِ **خام** است؛ دفترِ دکوراته (ماندگار) رد می‌شود. رفتگر هم باید روی همان دفترِ خام ساخته شود.
- رکوردِ outbox ناموفق ⇒ بی‌تماس و رزرو برمی‌گردد (`RESERVE_FAILED`). بقیهٔ قواعدِ رزرو/تسویه/ردّ همان `metered-tool-gateway`.
- خطاهای پیکربندی یک‌جا، بی‌تکرار، فقط نامِ فیلد؛ هرگز مقدار.

## محدودیت‌ها (صادقانه)
- آزمون‌های **داخلِ ماژول** روی ذخیرهٔ حافظه‌ای‌اند. ترکیب روی **PostgreSQL واقعی** (دفترِ PG + outbox PG در یک شِما) در `tooling/durable-tool-gateway-pg.test.ts` آزموده می‌شود (ADR-0064): ماندگاری بین فرایندها، ۱۲ گامِ هم‌زمان، مرگِ وسط تماس × دو سیاست، دو رفتگرِ زنده، ناپدید شدنِ جدولِ outbox (پیش از گام و وسطِ تماس) بی‌نشتِ متنِ خطای PG، و ۶ بذرِ ویژگی‌آزمایی. این آزمون ماژول را تغییر نمی‌دهد و بدونِ پایگاه رد می‌شود (دروازهٔ صفر-ردِ CI آن را قرمز می‌کند). هنوز **نیست**: رفتگرِ حلقه‌ایِ واقعی (`settlement-runtime`) روی این ترکیب و قطعِ اتصالِ TCP وسط تراکنش.
- با `onUnknownCost:"release"` گامی که هزینه شد ولی قصدِ مصرفش ثبت نشد (outbox خراب) رایگان می‌شود؛ تصمیمِ محصولیِ مالک.
- رفتگر، چرخهٔ عمر و پایشِ رسیدهای معلق در این ماژول نیست.

## آزمون
`config` (پیکربندی)، `gateway` (رفتاری روی outbox/دفتر/رفتگر)، `property` (۳۰۰ بذرِ قطعی با داورِ مستقل و ادعای پوشش)، و در `tooling/`: `durable-tool-gateway-source.test.ts` (نگهبان منبع) و `durable-tool-gateway-e2e.test.ts` (زنجیرهٔ کامل با `calc-answer-service`، هر دو قالبِ سیم).
