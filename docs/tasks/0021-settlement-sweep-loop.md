# settlement: برش م۳‑ج — حلقهٔ رفتگر

## هدف (یک جمله)
زمان‌بندیِ ایمن و بی‌هم‌پوشانیِ `sweep()` با زمان‌سنجِ تزریقی، به‌طوری که رزروهای یتیم پیش از انقضا بسته شوند و هر خرابی (رفتگر، زمان‌سنج، ساعت، مشاهده‌گر، پایگاه) علنی و بی‌خاموشیِ ساکت باشد.

## زمینه
ADR-0022 «محدودیت‌های صادقانه» و تحویل ۰۰۲۲ «گام بعد». ADR-0023 تصمیم‌ها را ثبت کرده است.

## ماژول و پوشه‌های مجاز
`src/modules/settlement/`: فایل‌های جدید `sweep-loop.ts`، `loop-policy.ts` و تست‌های `loop-policy.test.ts`، `sweep-loop.test.ts`، `sweep-loop.integration.test.ts`، `sweep-loop.pg.test.ts`؛ ویرایشِ افزایشیِ `types.ts`، `config.ts`، `index.ts`، `test-kit.ts`، `README.md`؛ `purity.test.ts` (**فقط** دو ادعای ناگزیر، `Test-Change-Approved`)؛ `tooling/mutation/settlement-loop.py`؛ `tooling/ci-tests.ts` (فقط بالا بردن کف، کامیت جدا، `Risk-Tag`)؛ `docs/`.

## ممنوع
تغییر `ledger`، `metering`، `ai-gateway`، `ai-orchestrator`، `shared-types`، `src/db/`، `registry.ts`، outbox PostgreSQL (`settlement/pg/`)؛ **تغییر یا حذف هر تستِ موجود جز دو ادعای بالا**؛ وابستگی خارجی؛ ساعت سیستم/تصادف/محیط/تایمرِ سراسری در کد منبع؛ ذخیره یا پژواکِ پیامِ خامِ رفتگر/مشاهده‌گر/زمان‌سنج.

## قرارداد
`createSweepLoop(config)` ⇒ `SettlementResult<SweepLoop>`؛ `SweepLoop = { start(), stop(), status() }` (هرگز نمی‌پرتابد). `LoopTimer = { after(fn, ms), cancel(handle) }`. پیکربندی: `sweeper، timer، clock، graceMs، intervalMs` الزامی؛ `maxBackoffMs، maxDrainRuns، stopTimeoutMs، observer` اختیاری. ناورداها: تک‌پرواز، `interval ≤ backoff ≤ ⌊grace/2⌋`، بی‌پرتاب/بی‌نشت، زنگِ مرگ پس از stop هم می‌رسد، خاموشیِ ساکت نیست، هر تایمر یک بار.

## معیار پذیرش
1. پیکربندیِ نامعتبر ⇒ `INVALID_CONFIG` با نامِ مشکل (نه مقدار)؛ مرزها آزموده.
2. تک‌پرواز و یک تایمرِ آویزان در هر لحظه؛ تایمرِ کهنه/دوباره‌صدا/همگام زنجیرِ دوم نمی‌سازد.
3. هیچ تأخیری از `⌊grace/2⌋` بیشتر نیست (خاصیتی)؛ ریاضیِ تأخیر در برابر مرجعِ مستقل.
4. هر خرابیِ رفتگر/ساعت/زمان‌سنج/مشاهده‌گر ⇒ حلقه نمی‌شکند، بی‌نشت، و علنی (`onFault`/`status`).
5. `stop`: صبر، مهلت، هم‌زمان، بی‌آویزان؛ گذرِ رهاشده زمان‌بندی نمی‌کند ولی زنگِ مرگ می‌دهد.
6. روی دفتر و outbox واقعی (حافظه‌ای و PostgreSQL): رزروِ یتیم و نیمه‌تمام بی‌`sweep` دستی بسته می‌شود؛ مرگِ فرایند، دو حلقهٔ هم‌زمان و قطعِ پایگاه آزموده.
7. جهشیِ بی‌زندهٔ توضیح‌نشده؛ هیچ تستِ موجودی ضعیف نشد؛ دروازهٔ صفر-رد سبز؛ کف `MIN_PASSED_TESTS` بالا رفت.
