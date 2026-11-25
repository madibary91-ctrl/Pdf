# durable-tool-gateway — برش MT-2 (دروازهٔ ابزارِ ماندگار)

## هدف (یک جمله)
هر گامِ `ToolGateway` پیش از تماس هم رزرو و هم در outbox ثبت شود تا مرگِ فرایند یا شکستِ تسویه را رفتگرِ `settlement` ببندد، بی‌آنکه `metered-tool-gateway`، `settlement` یا `metering` تغییر کنند.

## زمینه
ADR-0063؛ ادامهٔ ADR-0062 (باز «رفتگرِ رزروِ معلق»).

## ماژول و پوشه‌های مجاز
`src/modules/durable-tool-gateway/` (تازه)، `tooling/durable-tool-gateway-source.test.ts` و `tooling/durable-tool-gateway-e2e.test.ts` (تازه)، یک ردیف در `src/modules/registry.ts`، یک نام در `HIGH_RISK_MODULES` (`tooling/git-discipline.ts`)، یک ردیف در `docs/high-risk-areas.md`، چهار ردیف در `docs/known-pitfalls.md`، کفِ دروازه، ADR/task/handoff.

## ممنوع
هر ماژولِ دیگرِ `src/modules/*`، تغییرِ هر آزمونِ موجود، وابستگیِ خارجیِ تازه، `process.env`/شبکه/ساعت/تصادف در کد، هر قیمت/عددِ پولی، بازنویسیِ منطقِ رزرو/تسویه، وصل‌کردن به مسیرِ محصول.

## قرارداد
`createDurableToolGateway(raw)` ⇒ `SettlementResult<MeteredToolGateway>`؛ `raw` = گزینه‌های `createMeteredToolGateway` (با `ledger` خام) + `outbox` + `clock` + `graceMs` (README ماژول).

## معیار پذیرش
1. هر گام پیش از تماس رکوردِ outbox دارد؛ رکوردِ ناموفق ⇒ بی‌تماس و رزروِ برگشته.
2. مرگِ فرایند وسط تماس، شکستِ `charge`/`close` و شکستِ ثبتِ قصد با رفتگر و بدونِ دوباره‌کاری بسته می‌شود؛ پول حفظ می‌شود.
3. `onUnknownCost` یک منبع؛ `ttl ≥ ۲×graceMs` و دفترِ دکوراته در ساخت رد می‌شود؛ خطاها یک‌جا و بی‌نشت.
4. ۳۰۰ بذرِ قطعی با داورِ مستقل؛ سرتاسری با `calc-answer-service` و هر دو قالبِ سیم.
5. بی‌پرتاب/بی‌نشت؛ کدِ منبع منطقِ پول را بازنویسی نمی‌کند.

## خارج از کار
ریشهٔ I/O (CT‑5c‑2)، ساختنِ رفتگر در برنامه، آزمونِ PostgreSQL برای ترکیب، `Answer.reviewPending`، بودجهٔ تجمعیِ چندپرسش.

## وابستگی‌ها
ADR-0021/0022/0062.

## بازبینی و ریسک
ناحیهٔ پرریسک (`humanReview:true`): مالک امنیت. تگِ `pre-risk/20261207-durable-tool-gateway`.
