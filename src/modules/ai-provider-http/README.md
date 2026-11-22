# ai-provider-http (لایهٔ ۴ · غیرخالص · **بازبینی انسانیِ اجباری**) — برش CT‑3c‑1

**هدف:** انتقالِ HTTP برای «گامِ ابزار» در `ai-gateway`: یک `ToolModelProvider` برای OpenAI (`openai-chat`) و Anthropic (`anthropic-messages`) که بدنهٔ **خامِ** پاسخ را به `createToolGateway` می‌دهد؛ تفسیرِ پاسخ (`decodeToolReply`)، مهلت/لغو و هزینه همان‌جا می‌ماند.
**وابستگی:** فقط `ai-gateway` (`ProviderFailure` و نوع‌ها). **شبکه را خودش برنمی‌دارد:** `fetch` پورتِ تزریقی است (`globalThis.fetch` سازگار است) و ریشهٔ برنامه تعیین می‌کند. `process.env` نمی‌خواند؛ کلید را تابعِ `getApiKey` می‌دهد.

> ⚠️ **محدودیتِ صادقانه:** تماسِ زنده با OpenAI/Anthropic **انجام نشده** (کلید و شبکهٔ بیرونی در سازهٔ آزمون نیست). آزمون‌ها با `fetch` شبیه‌سازی و با **سرورِ HTTPِ واقعیِ loopback** (`tooling/http-tool-provider-gateway.test.ts`) انجام شده‌اند؛ شکلِ بدنه/سرایند بر پایهٔ مستندات است و باید با آزمونِ قراردادِ زنده (CT‑3c‑2) تأیید شود. این ماژول به مسیرِ محصول **وصل نیست** (هیچ‌جا ساخته نمی‌شود).

## رابط عمومی
```ts
import { createHttpToolProvider } from "@/modules/ai-provider-http";
import { createToolGateway } from "@/modules/ai-gateway";

const p = createHttpToolProvider({
  format: "anthropic-messages",
  endpoint: "https://api.anthropic.com/v1/messages",
  getApiKey: () => process.env.ANTHROPIC_API_KEY ?? "", // فقط در ریشهٔ ترکیب
  fetch: globalThis.fetch,
});
if (!p.ok) throw new Error(p.error.issues.join());
const gw = createToolGateway(config, { models: { legal: { format: "anthropic-messages", provider: p.value } } });
```
`createHttpToolProvider(options: unknown)` هرگز پرتاب نمی‌کند (`{ ok:false, error:{ code:"INVALID_CONFIG", issues } }`). گزینه‌ها: `format`، `endpoint`، `getApiKey`، `fetch` (الزامی)؛ `allowInsecureLoopback`، `maxResponseBytes` (۱ KiB…۱۶ MiB؛ پیش‌فرض ۱ MiB)، `anthropicVersion` (پیش‌فرض `2023-06-01`)، `openaiMaxTokensField` (`max_tokens` | `max_completion_tokens`)، `now`.

## ضمانت‌ها
- **نشانی:** فقط `https:`؛ `http:` فقط با `allowInsecureLoopback` و فقط `localhost`/`127.0.0.1`/`[::1]`؛ بی‌userinfo و بی‌fragment؛ شکلِ `scheme://host` الزامی است (WHATWG `https:///v1` را به میزبانِ `v1` «ترمیم» می‌کند؛ این‌جا رد می‌شود).
- **کلید:** فقط در سرایندِ همان تماس؛ هر تماس دوباره خوانده می‌شود؛ ASCII چاپیِ بی‌فاصله تا ۵۱۲ نویسه (مانعِ تزریقِ سرایند)؛ نامعتبر/پرتاب ⇒ `ProviderFailure("auth")` **بی‌ارسال** و بی‌`cause`. در شیء، پیامِ خطا و پیکربندی نمی‌آید.
- **تغییرِ مسیر:** `redirect:"error"` (سرایندِ `x-api-key` را مرورگر/undici در تغییرِ مسیرِ هم‌مبدأ/غیرهم‌مبدأ یکسان حذف نمی‌کند)؛ `credentials:"omit"`، `cache:"no-store"`، `referrerPolicy:"no-referrer"`.
- **وضعیت ⇒ شکست:** ۲xx موفق؛ ۴۰۱/۴۰۳ `auth`؛ ۴۲۹ `rate_limited`؛ ۴۰۸ و ۵xx (از جمله ۵۲۹) `unavailable`؛ بقیه `rejected`. `Retry-After`/`retry-after-ms` فقط برای دو نوعِ قابل‌تلاش منتقل می‌شود. **بدنهٔ پاسخِ ناموفق هرگز خوانده/بازتاب نمی‌شود.**
- **بدنهٔ موفق:** با سقفِ بایت (پیش از خواندن با `content-length` و حین جریان)، UTF-8 سخت‌گیر؛ بزرگ/خراب/تهی/غیرJSON ⇒ `null` ⇒ دروازه `PROVIDER_BAD_RESPONSE`.
- **لغو/مهلت:** `call.signal` به `fetch` و خواندنِ بدنه می‌رسد؛ در لغو علتِ لغو پرتاب می‌شود (نه `unavailable`)؛ تصمیمِ `TIMEOUT`/`ABORTED` با دروازه است.
- بدنه فقط کلیدهای مجازِ ابزار را از `call.tools` می‌گیرد (`tools`، `tool_choice`، `parallel_tool_calls`)؛ `model`/`stream:false`/`messages` قابل‌بازنویسی نیستند. دما و سقفِ توکن «اصلاح» نمی‌شوند (ارائه‌دهنده رد کند ⇒ `PROVIDER_REJECTED`).

## محدودیت‌های شناخته‌شده
تماسِ زنده نشده؛ استریم ندارد؛ فقط `complete` با ابزار (نه `ModelProvider.complete` عادی)؛ تلاشِ دوباره/جایگزین ندارد؛ پراکسی/mTLS/سرایندِ سازمانی (`OpenAI-Organization`) و پین‌کردنِ گواهی نیست؛ محافظِ SSRF در سطحِ DNS (میزبانی که به IP خصوصی resolve شود) نیست — `endpoint` را **مالکِ استقرار** می‌دهد، نه کاربر؛ مدل‌های OpenAI که `temperature` را نمی‌پذیرند (خانوادهٔ o) هنوز گزینهٔ حذفِ دما ندارند؛ دمای Anthropic بیش از ۱ رد می‌شود.
