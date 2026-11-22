# ai-provider-http — برش CT‑3c‑1

## هدف (یک جمله)
یک ارائه‌دهندهٔ HTTPِ امن برای گامِ ابزارِ `ai-gateway` (OpenAI و Anthropic) که کلید را نمی‌نشت، تغییرِ مسیر را دنبال نمی‌کند و بدنهٔ پاسخ را با سقفِ بایت می‌خواند.

## زمینه
ADR-0057؛ ادامهٔ ADR-0055 (CT‑3b).

## ماژول و پوشه‌های مجاز
`src/modules/ai-provider-http/` (کد، آزمون، README)، `tooling/http-tool-provider-gateway.test.ts`، `src/modules/registry.ts` (یک ردیف)، `tooling/git-discipline.ts` (فقط `HIGH_RISK_MODULES`)، `tooling/ci-tests.ts` (فقط کفِ شمار)، `docs/`.

## ممنوع
تغییرِ `ai-gateway`/`shared-types`/هر آزمونِ موجود، `process.env` و شبکهٔ سراسری در ماژول، وابستگیِ خارجیِ جدید، تماسِ زنده، وصل‌کردن به مسیرِ محصول.

## قرارداد
`createHttpToolProvider`، `HTTP_PROVIDER_LIMITS` و نوع‌های `FetchFn`، `HttpToolProviderOptions`، `HttpProviderResult`، `HttpProviderConfigError`، `OpenAiMaxTokensField` (`src/modules/ai-provider-http/index.ts`).

## معیار پذیرش
1. هیچ فایلِ موجودِ ai-gateway/shared-types تغییر نکرد؛ هیچ آزمونِ موجودی تغییر نکرد.
2. پیکربندیِ نامعتبر هرگز پرتاب نمی‌کند و مقدارِ ورودی (نشانی/کلید) را بازتاب نمی‌دهد.
3. کلید هرگز در شیء، پیامِ خطا، `cause` (برای شکستِ تأمین‌کننده) و نتیجهٔ دروازه نیست؛ کلیدِ نامعتبر بی‌ارسال `auth` می‌دهد.
4. تغییرِ مسیر (۳۰۲/۳۰۷) دنبال نمی‌شود و به میزبانِ دوم هیچ درخواستی نمی‌رسد (سرورِ واقعی).
5. بدنهٔ پاسخِ ناموفق خوانده نمی‌شود؛ بدنهٔ موفق از سقف نمی‌گذرد (حتی با `content-length` دروغ).
6. مهلتِ دروازه و لغوِ فراخواننده اتصالِ HTTPِ واقعی را می‌بندند.
7. حلقهٔ دو‌گامیِ واقعیِ `calc-tools` روی HTTPِ loopback در هر دو قالب کار می‌کند.
