# ai-gateway — برش CT‑3b (گامِ ابزار)

## هدف (یک جمله)
یک گامِ «مدل با ابزار» با همان ضمانت‌های دروازهٔ اصلی (مرزِ سخت، مهلت/لغو، مصرفِ صحیح، رویدادِ مصرف، هرگز پرتاب) و حسابداریِ درستِ هزینهٔ چندگامی، بدونِ شکستنِ هیچ قراردادِ موجود.

## زمینه
ADR-0055؛ ادامهٔ ADR-0054 (CT‑3a).

## ماژول و پوشه‌های مجاز
`src/modules/ai-gateway/` (فایل‌های تازهٔ `tool-step*.ts`، یک کلمه در `gateway.ts` برای صادراتِ `emit`، `index.ts` برای صادرات، README)، `tooling/tool-step-calc-tools.test.ts`، `tooling/ci-tests.ts` (فقط کفِ شمار)، `docs/`.
ویرایشِ تک‌نوع‌سازیِ یک تستِ موجود (فقط `as unknown as`) در کامیتِ جدا با `Test-Change-Approved` (رک. یادداشت ۰۰۵۵).

## ممنوع
`registry.ts`، `shared-types`، `calc-tools`/`legal-calc`، تغییرِ `ModelProvider`/`CompletionRequest`/`Completion`/`Gateway`/`GatewayErrorCode`/`resilience.ts`، شبکه/env/ساعتِ سیستم، وابستگیِ خارجیِ جدید، ویرایشِ هر آزمونِ موجود (جز استثنای بالا).

## قرارداد
`createToolGateway`، `sumStepSpend`، `TOOL_STEP_LIMITS`، `TRUNCATED_TOOL_CALL_ISSUE` و نوع‌های `ToolGateway`، `ToolModelProvider`، `ToolProviderCall`، `ToolStepRequest`، `ToolStepCompletion`، `ToolStepError`، `StepSpend` (`src/modules/ai-gateway/index.ts`).

## معیار پذیرش
1. هیچ نوع/تابعِ موجودِ ai-gateway تغییر نکرد؛ فقط افزودن.
2. بخشِ پایهٔ درخواست با همان `parseRequest` سنجیده می‌شود؛ `continuation` هرگز `system` یا نقشِ غیرمجاز نمی‌پذیرد و کپیِ ژرفِ یخ‌زده است.
3. پاسخِ ارائه‌دهنده فقط با `decodeToolReply` تفسیر می‌شود؛ فراخوانیِ بریده ⇒ `PROVIDER_BAD_RESPONSE` با نشانهٔ ثابت و مصرفِ هزینه‌شده در `error.usage/cost`.
4. برای هر فراخوانیِ رسیده به ارائه‌دهنده (حتی ناموفق) دقیقاً یک `UsageEvent`؛ برای درخواستِ نامعتبر هیچ.
5. `sumStepSpend`: نامعلوم صفر نمی‌شود، نسخه/ارزِ قیمت ادغام نمی‌شود، سرریز ⇒ `null`.
6. حلقهٔ دو‌گامیِ واقعیِ `calc-tools` در هر دو قالب کار می‌کند و هزینهٔ دو گام درست جمع می‌شود.
7. دروازهٔ کامل سبز، `tsc` و `eslint` سبز، `MIN_PASSED_TESTS` بالا رفت.

## خارج از کار
حلقه/سقفِ گامِ ابزار و رزروِ هزینه (CT‑4)، HTTP (CT‑3c)، تلاش/جایگزین برای گامِ ابزار، `inheritance`.

## وابستگی‌ها
هیچ (فقط داخلِ ماژول).

## بازبینی و ریسک
مرزِ امنیتی (`continuation` و پاسخِ نامطمئن) + پول (هزینهٔ چندگامی) ⇒ بازبینیِ پیشنهادی در ADR-0055.
