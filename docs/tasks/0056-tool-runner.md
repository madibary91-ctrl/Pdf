# tool-runner — برش CT‑4b (مجریِ حلقهٔ ابزار)

## هدف (یک جمله)
مجریِ I/Oی حلقهٔ مدل↔ابزار که کنش‌های `tool-loop` را با دروازهٔ ابزار و یک پورتِ اجرای ابزار می‌چرخاند، بی‌آنکه سیاستِ ایست داشته باشد، و در لغو/مهلت/خطا هزینه را گم نکند.

## زمینه
ADR-0058؛ ادامهٔ ADR-0056 (CT‑4a) و ADR-0057 (CT‑3c‑1).

## ماژول و پوشه‌های مجاز
`src/modules/tool-runner/` (تازه)، `tooling/tool-runner-source.test.ts` و `tooling/tool-runner-e2e.test.ts` (تازه)، یک ردیف در `src/modules/registry.ts`، یک نام در `HIGH_RISK_MODULES` (`tooling/git-discipline.ts`)، یک ردیف در `docs/high-risk-areas.md`، `MIN_PASSED_TESTS`، ADR/یادداشت/pitfalls.

## ممنوع
هر ماژولِ دیگرِ `src/modules/*`، تغییرِ هر آزمونِ موجود، وابستگیِ خارجیِ تازه، `process.env`/شبکهٔ سراسری/ساعت/تصادف در ماژول، وابستگی به calc-tools یا ارائه‌دهندهٔ مشخص، وصل‌کردن به مسیرِ محصول.

## قرارداد
`createToolRunner`، `resolveRunnerOptions`، `RUNNER_LIMITS`، `ABORT_GRACE_MS`، `judgeExecution` و نوع‌های `ToolRunner*`، `ToolExecut*`، `RunReport`، `RunnerError*`، `ToolRunRecord`، `ToolFailureCode` (README ماژول).

## معیار پذیرش
1. آستانه‌های `totalTimeoutMs`/`toolTimeoutMs`/`maxResultChars` الزامی و بی‌پیش‌فرض؛ پیکربندیِ نامعتبر هرگز پرتاب نمی‌کند و مقدار را بازتاب نمی‌دهد.
2. `run` هرگز پرتاب نمی‌کند و از `totalTimeoutMs` نمی‌ماند (دروازهٔ بی‌توجه به لغو و ابزارِ بی‌پایان هم).
3. ابزارِ بیرون از `input.tools` هرگز به پورت نمی‌رسد.
4. خطای ابزار (پرتاب/مهلت/شکل/اندازه) متنِ ثابت می‌دهد؛ پیامِ استثنا بازتاب نمی‌شود؛ حلقه ادامه می‌یابد.
5. گامِ در-پروازِ لغوشده «هزینهٔ نامعلوم» است؛ گامِ موفقِ هم‌زمان با لغو شمرده می‌شود؛ خطای قرارداد `partial` با هزینه می‌دهد.
6. تایمر و شنوندهٔ `AbortSignal` در هر مسیر پاک می‌شود؛ ممیزی بی‌آرگومان و بی‌نتیجه است و ابزارِ لغوشده حین اجرا را نگه می‌دارد.
7. سرورِ HTTPِ واقعی + `ai-provider-http` + `ai-gateway` + `tool-loop` + `tool-runner` + `calc-tools` در هر دو قالب کار می‌کند؛ لغو/مهلت اتصالِ واقعی را می‌بندد؛ `spend` با مجموعِ `UsageEvent`ها برابر است.

## تست‌های مورد انتظار
پیکربندی/مرز، مسابقه (race)، داوریِ نتیجهٔ ابزار (جدولی)، لغو/مهلت با تایمرِ دستی و واقعی، خطای قرارداد، تصادفی (۳۰۰ بذرِ قطعی با ناوردا و پوششِ فضای حالت)، خلوص/مرزِ کد منبع، یکپارچه (HTTP واقعی).

## خارج از کار
پورتِ calc-tools و ریشهٔ ترکیب، اتصال به `metering`، `Answer.reviewPending` در ارکستراتور، اجرای هم‌زمانِ ابزار، تلاشِ دوباره، قراردادِ زنده.

## وابستگی‌ها
ADR-0055/0056/0057.

## فایل‌های مرجع برای خواندن
`docs/adr/0056-tool-loop-controller.md`، `src/modules/tool-loop/loop.ts`، `src/modules/ai-gateway/tool-step.ts`، `tooling/tool-loop-calc-tools.test.ts`.

## بازبینی و ریسک
ناحیهٔ پرریسک (`humanReview:true`): مالک امنیت + مالک پول. تگِ `pre-risk/20261202-tool-runner`.
