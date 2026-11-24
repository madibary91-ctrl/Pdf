# metered-tool-gateway — برش MT-1 (اندازه‌گیریِ مصرفِ گامِ ابزار)

## هدف (یک جمله)
هر گامِ `ToolGateway` پیش از تماس بدترین‌هزینه را در دفتر اعتبار رزرو و پس از آن هزینهٔ واقعی را تسویه کند، بی‌آنکه `metering`، `ai-gateway` یا `calc-answer-service` تغییر کنند.

## زمینه
ADR-0062؛ ادامهٔ ADR-0061 («اتصال spend به metering»).

## ماژول و پوشه‌های مجاز
`src/modules/metered-tool-gateway/` (تازه)، `tooling/metered-tool-gateway-source.test.ts` و `tooling/metered-tool-gateway-e2e.test.ts` (تازه)، یک ردیف در `src/modules/registry.ts`، یک نام در `HIGH_RISK_MODULES` (`tooling/git-discipline.ts`)، یک ردیف در `docs/high-risk-areas.md`، `known-pitfalls.md`، `MIN_PASSED_TESTS`، ADR/یادداشت.

## ممنوع
هر ماژولِ دیگرِ `src/modules/*`، تغییرِ هر آزمونِ موجود، وابستگیِ خارجیِ تازه، `process.env`/شبکه/ساعت/تصادف در کد، هر قیمت/عددِ پولی، وصل‌کردن به مسیرِ محصول.

## قرارداد
`createMeteredToolGateway(options)` ⇒ `Result<ToolGateway & {receipts(), summary()}>`؛ `completeStep` نتیجه را با `metering` برمی‌گرداند (README ماژول).

## معیار پذیرش
1. بی‌رزرو، بی‌تماس؛ رزرو روی پیام‌ها + ابزارها + ادامه؛ عکسِ یک‌بارهٔ درخواست.
2. هزینهٔ معلوم مصرف می‌شود (حتی در گامِ شکست‌خورده)؛ نامعلوم هرگز صفر نیست؛ بی‌تماسِ اثبات‌شده آزاد می‌شود.
3. شکستِ تسویه بی‌نشان نیست؛ همسانی با `metering` در همهٔ سناریوها.
4. جدولِ پول با دروازه در ساخت هم‌خوان سنجیده می‌شود.
5. بی‌پرتاب/بی‌نشت؛ رسیدها بی‌متن.
6. سرتاسری با دفتر اعتبارِ واقعی و `calc-answer-service`: مصرفِ دفتر = هزینهٔ سرویس = جمعِ رویدادهای مصرف؛ هر دو قالبِ سیم.

## خارج از کار
ریشهٔ I/O (CT‑5c‑2)، رفتگرِ رزروِ معلق، بودجهٔ تجمعیِ چندپرسش، استخراجِ تسویهٔ مشترک، `Answer.reviewPending`.

## وابستگی‌ها
ADR-0020/0055/0061.

## بازبینی و ریسک
ناحیهٔ پرریسک (`humanReview:true`): مالک امنیت. تگِ `pre-risk/20261206-metered-tool-gateway`.
