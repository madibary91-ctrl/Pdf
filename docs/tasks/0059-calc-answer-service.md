# calc-answer-service — برش CT‑5c‑1 (سرویسِ پاسخِ محاسبه)

## هدف (یک جمله)
سیم‌کشیِ «پرسش ← مدل/ابزار ← کارت ← پاسخِ قابل‌نمایش + هزینه» را یک بار، بی‌I/O و کاملاً آزموده بنویسد تا ریشهٔ I/O فقط دروازه و آستانه‌ها را تزریق کند.

## زمینه
ADR-0061؛ ادامهٔ ADR-0060 (ریشهٔ ترکیب، نیمهٔ دوم).

## ماژول و پوشه‌های مجاز
`src/modules/calc-answer-service/` (تازه)، `tooling/calc-answer-service-source.test.ts` و `tooling/calc-answer-service-e2e.test.ts` (تازه)، یک ردیف در `src/modules/registry.ts`، یک نام در `HIGH_RISK_MODULES` (`tooling/git-discipline.ts`)، یک ردیف در `docs/high-risk-areas.md`، `known-pitfalls.md`، `MIN_PASSED_TESTS`، ADR/یادداشت.

## ممنوع
هر ماژولِ دیگرِ `src/modules/*`، تغییرِ هر آزمونِ موجود، وابستگیِ خارجیِ تازه، `process.env`/شبکه/ساعت/تصادف در کدِ ماژول، هر عددِ حقوقی/قیمت، وصل‌کردن به مسیرِ محصول.

## قرارداد
`createCalcAnswerService(options)` ⇒ `Result<{answer(input, {signal?})}>`؛ `answer` ⇒ `Result<{answer, spend, steps, toolCalls}, {code, message, issues, cause, spend}>` (README ماژول).

## معیار پذیرش
1. آستانه‌ها الزامی/بی‌پیش‌فرض و در ساخت سنجیده؛ خطای پیکربندیِ مدل در ساخت رد.
2. ورودی فقط `messages`/`requestId`؛ فهرستِ ابزار/مدل/سقف فقط از سرویس؛ شکلِ پیام پیش از تماس؛ بی‌بازتابِ محتوا.
3. هر اجرا حالتِ تازه؛ هم‌زمان و پی‌درپی قاطی نمی‌شود.
4. ناهمخوانیِ کارت/گزارش ⇒ `NOT_DISPLAYABLE` بی‌متنِ مدل؛ هزینه در همهٔ مسیرها حفظ و ژرف‌یخ‌زده؛ هزینهٔ ناخوانا شکست‌بسته.
5. بی‌پرتاب/بی‌نشت (دروازه، getter، Proxy، سازنده).
6. سرتاسری با زنجیرهٔ واقعی (fetch درون‌حافظه) در هر دو قالبِ سیم؛ `spend` برابرِ جمعِ رویدادهای مصرفِ دروازه.

## تست‌های مورد انتظار
گزینه‌ها، مسیرِ شاد، ورودی، ایست/لغو/شکست، مسیرهای دفاعی، تصادفیِ قطعیِ ۳۰۰ بذر با داورِ مستقل و پوششِ فضای حالت، مرزِ کد منبع، سرتاسری.

## خارج از کار
ریشهٔ I/O (CT‑5c‑2)، `metering`، `Answer.reviewPending`، تطبیقِ عدد، قراردادِ زنده.

## وابستگی‌ها
ADR-0060/0059/0058.

## فایل‌های مرجع برای خواندن
`src/modules/calc-answer-cards/README.md`، `src/modules/tool-runner/types.ts`، `tooling/calc-answer-cards-e2e.test.ts`.

## بازبینی و ریسک
ناحیهٔ پرریسک (`humanReview:true`): مالک امنیت + حقوقدان. تگِ `pre-risk/20261205-calc-answer-service`.
