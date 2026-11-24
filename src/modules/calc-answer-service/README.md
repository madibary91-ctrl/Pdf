# calc-answer-service (لایهٔ ۴ · ناخالص‌ترین حدِ «بی‌I/O» · 🔴 بازبینی انسانیِ اجباری) — **برش CT‑5c‑1: سرویسِ پاسخِ محاسبه**

**هدف:** یک نقطهٔ ورودیِ واحد و امن برای «پرسش ← مدل/ابزار ← کارت ← پاسخِ قابل‌نمایش + هزینه». این ماژول `createToolRunner` + `createCalcToolExecutor` + `createCardCollector` را برای **هر پرسش** تازه می‌سازد و به‌هم وصل می‌کند، تا مصرف‌کننده (API/UI) هیچ‌گاه خودش `observe` ← `onResult` را سیم‌کشی نکند (چهار خطای ADR-0060).
**وابستگی:** `ai-gateway` (نوعِ دروازه/تایمر)، `tool-loop` (نوعِ حلقه/هزینه)، `calc-tools` (`CALC_TOOLS`)، `calc-tool-executor`، `calc-answer-cards`، `tool-runner`.
**I/O ندارد:** `process.env`، کلید، نقطهٔ پایانی، شبکه و آستانه‌های مالک **اینجا نیست**؛ دروازه و حلقه را مصرف‌کننده می‌سازد و تزریق می‌کند (برشِ CT‑5c‑2).

> ⚠️ **هنوز به هیچ مسیرِ محصولی وصل نیست** (`planned`). فقط آزمون و ریشهٔ I/O آینده آن را صدا می‌زند.
> ⚠️ هیچ عدد، قیمت، نرخ یا متنِ حقوقیِ تازه‌ای ندارد؛ فقط دو دسته پیامِ ثابتِ خطا (فارسی) که حقوقدان/محصول باید ببیند.

## رابط عمومی
```ts
import { createCalcAnswerService } from "@/modules/calc-answer-service";

const svc = createCalcAnswerService({ gateway, loop, model, maxOutputTokens, maxCards, totalTimeoutMs, toolTimeoutMs, maxResultChars /*, deps?, timers? */ });
if (!svc.ok) return report(svc.error);            // INVALID_OPTIONS: issues فقط نامِ کلید/محدودیت
const r = await svc.value.answer({ messages: [{ role: "user", content: "…" }] }, { signal });
if (!r.ok) return fail(r.error);                  // INVALID_INPUT | RUN_FAILED | NOT_DISPLAYABLE — هرگز پاسخِ مدل را نشان نده
const { answer, spend } = r.value;                // answer: ComposedAnswer (calc-answer-cards)؛ spend برای metering
```

## ضمانت‌ها
| ضمانت | چگونه |
|---|---|
| هر آستانه الزامی و بی‌پیش‌فرض | `model`، `maxOutputTokens`، `maxCards`، سه سقف/مهلت، `gateway`، `loop`؛ نبودن/نامعتبر ⇒ `INVALID_OPTIONS` **در زمانِ ساخت** (با ساختنِ آزمایشیِ سازنده‌های واقعی؛ issues فقط نامِ کلید با پیشوندِ ماژول) |
| خطای پیکربندیِ مدل به‌نامِ کاربر گزارش نمی‌شود | مدلِ بی‌پشتیبانیِ ابزار، مدلِ ناشناخته در دروازه، و `maxOutputTokens` بیش از سقفِ مدل در **ساخت** رد می‌شود (یافتهٔ آزمون: پیش‌تر `INVALID_INPUT` می‌شد) |
| فراخواننده فهرستِ ابزار/مدل/سقفِ توکن را عوض نمی‌کند | ورودی فقط `messages` و `requestId`؛ هر کلیدِ دیگر ⇒ `INVALID_INPUT` پیش از هر تماس؛ `tools: CALC_TOOLS`، `model`، `maxOutputTokens` فقط از سرویس |
| شکلِ پیام‌ها پیش از تماس سنجیده می‌شود | فهرستِ ناتهی، نقشِ مجاز، محتوای رشتهٔ ناتهی، آخرین پیام `user`؛ **محتوا بازتاب نمی‌شود**؛ سقفِ طول/تعداد با دروازه است |
| هر پرسش حالتِ تازه دارد | جمع‌آورنده/مجری/اجراگر در هر `answer` ساخته می‌شود؛ هیچ حالتِ سطحِ ماژول نیست؛ اجراهای هم‌زمان و پی‌درپی (با `callId` یکسان) قاطی نمی‌شوند |
| ناهمخوانیِ کارت و گزارش ⇒ پاسخ نمایش داده نمی‌شود | `NOT_DISPLAYABLE` با `cause` ∈ `CARD_MISSING/TOOL_MISMATCH/DUPLICATE_CALL_ID/INVALID_REPORT`؛ بی‌متنِ مدل و بی‌شناسهٔ فراخوانی |
| **هزینه هرگز گم نمی‌شود** | `spend` (کپیِ JSONِ ژرف‌یخ‌زده) در موفقیت، در `NOT_DISPLAYABLE` و در `RUN_FAILED` میانِ اجرا (از `partial`) می‌آید؛ پیش از هر تماس `null`. هزینهٔ ناخوانا ⇒ شکست‌بسته (`SPEND_INVALID`) |
| بی‌پرتاب و بی‌نشت | همهٔ مسیرها `Result`؛ متنِ استثنا (دروازه، getter، Proxy، سازنده) هرگز بازتاب نمی‌شود؛ `issues` حداکثر ۱۰ |
| تأییدنشدگی را این ماژول دست نمی‌زند | آزمونِ منبع: هیچ `reviewPending = …`؛ مقدار فقط از `compose` |

## محدودیت‌های شناخته‌شده
- به مسیرِ محصول وصل نیست؛ ساخت دروازه/ارائه‌دهندهٔ HTTP، خواندنِ `process.env`، آستانه‌های مالک: **CT‑5c‑2**.
- `metering` هنوز `spend` را نمی‌گیرد (برشِ بعد)؛ این ماژول فقط آن را سالم نگه می‌دارد و به اندازهٔ رویدادهای مصرفِ دروازه می‌رساند (آزمونِ سرتاسری).
- فقط ابزارهای `calc-tools`؛ پیامِ `system` را فراخواننده می‌دهد (متنِ سیاستِ سیستمیِ حقوقی را حقوقدان باید بنویسد، نه این ماژول).
- تطبیقِ عددِ متنِ مدل با کارت انجام نمی‌شود (باز؛ ADR-0060 بند ۸).
- پیام‌های خطای فارسی (دو دسته) در انتظارِ بازبینیِ محصول/حقوقدان است.
