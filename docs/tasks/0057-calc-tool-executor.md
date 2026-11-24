# calc-tool-executor — برش CT‑5a (پورتِ اجرای ابزارِ calc-tools)

## هدف (یک جمله)
پلِ باریکِ calc-tools ⇄ tool-runner که نتیجهٔ محاسبه را با `reviewPending` شکست‌بسته به مدل می‌دهد و همان نتیجه را بی‌واسطه (برای نمایش به کاربر) به یک ناظر می‌رساند.

## زمینه
ADR-0059؛ ادامهٔ ADR-0053 و ADR-0058.

## ماژول و پوشه‌های مجاز
`src/modules/calc-tool-executor/` (تازه)، `tooling/calc-tool-executor-source.test.ts` و `tooling/calc-tool-executor-e2e.test.ts` (تازه)، یک ردیف در `src/modules/registry.ts`، یک نام در `HIGH_RISK_MODULES`، یک ردیف در `docs/high-risk-areas.md`، `MIN_PASSED_TESTS`، ADR/یادداشت/pitfalls.

## ممنوع
هر ماژولِ دیگرِ `src/modules/*`، تغییرِ هر آزمونِ موجود، وابستگیِ خارجیِ تازه، `process.env`/شبکه/ساعت/تصادف، هر عددِ حقوقی، وصل‌کردن به مسیرِ محصول.

## قرارداد
`createCalcToolExecutor(options?)`، `CALC_ABORTED_CONTENT` و نوع‌های `CalcToolExecutor*`، `CalcToolObservation` (README ماژول).

## معیار پذیرش
1. محتوای موفق `{tool,result,review,reviewPending,notes}` عیناً از calc-tools؛ `reviewPending` شکست‌بسته (فقط با دو نشانهٔ موافق `false`).
2. خطای محاسبه ⇒ `ok:false` با `{error:{code,message}}` عیناً از calc-tools؛ هر خروجی از `judgeExecution` درست می‌گذرد.
3. `onResult` پیش از بازگشت، یک بار، ژرف‌یخ‌زده؛ پرتاب‌اش بلعیده نمی‌شود و نتیجه به مدل نمی‌رسد؛ برای خطا صدا زده نمی‌شود.
4. باگِ درونیِ محاسبه پنهان نمی‌شود؛ لغوِ پیش‌ازاجرا محاسبه نمی‌کند.
5. گزینهٔ نامعتبر (کلیدِ ناشناخته، نوعِ نادرست، Proxy بدجنس) ⇒ `Result` خطا، بی‌پرتاب و بی‌بازتابِ مقدار.
6. سرتاسری با مجریِ واقعی در هر دو قالبِ سیم: ناظر نتیجهٔ بی‌واسطه می‌گیرد؛ جدولِ `legally-verified` ⇒ `reviewPending=false` تا پایانِ حلقه؛ ابزارِ بیرون از فهرست اجرا نمی‌شود.

## تست‌های مورد انتظار
گزینه‌ها، موفق/خطا (دیفرانسیلی با calc-tools)، لغو، ناظر، شکست‌بستگیِ `reviewPending` (mock)، تصادفیِ قطعی (۴۰۰ بذر با پوششِ فضای حالت)، مرزِ کد منبع، سرتاسری.

## خارج از کار
ریشهٔ ترکیب، `metering`، `Answer.reviewPending`، ابزارهای تازه (ارث، ویرایشِ سند)، قراردادِ زنده.

## وابستگی‌ها
ADR-0053/0058.

## فایل‌های مرجع برای خواندن
`src/modules/calc-tools/README.md`، `src/modules/tool-runner/tools.ts` (`judgeExecution`)، `tooling/tool-runner-e2e.test.ts`.

## بازبینی و ریسک
ناحیهٔ پرریسک (`humanReview:true`): حقوقدان + مالک امنیت. تگِ `pre-risk/20261203-calc-tool-executor`.
