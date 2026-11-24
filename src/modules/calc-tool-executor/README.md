# calc-tool-executor (لایهٔ ۴ · خالص · 🔴 بازبینی انسانیِ اجباری) — **برش CT‑5a: پورتِ اجرای ابزارِ calc-tools**

**هدف:** پلِ باریکِ `calc-tools` (محاسبهٔ مرزیِ خالص) ⇄ `tool-runner` (پورتِ `ToolExecutor`): همان نگاشتی که تا امروز فقط در آزمون‌ها نوشته می‌شد، حالا یک‌جا، با ضمانت‌های صریح و آزمون.
**وابستگی:** `calc-tools` و `tool-runner` (فقط رابط عمومی). بی‌I/O، بی‌ساعت، بی‌تصادف، بی‌async (آزمونِ نگهبانِ منبع: `tooling/calc-tool-executor-source.test.ts`). **هیچ عددِ حقوقی یا سیاستی ندارد.**

> ⚠️ **به هیچ مسیرِ محصولی وصل نیست.** ریشهٔ ترکیب (ساختِ دروازه با ارائه‌دهندهٔ HTTP، خواندنِ `process.env`، آستانه‌های مالک) برشِ بعد است؛ پس در `registry.ts` وضعیتش `planned` است.
> ⚠️ جدول‌های `legal-calc` هنوز **تأییدِ حقوقدان ندارند**؛ `reviewPending` تا آن زمان در هر نتیجه `true` است. مدل می‌تواند عدد را غلط نقل کند یا هشدار را جا بیندازد؛ نمایش به کاربر باید از **`onResult`** باشد، نه از متنِ مدل.

## استفاده
```ts
import { createCalcToolExecutor } from "@/modules/calc-tool-executor";
import { CALC_TOOLS } from "@/modules/calc-tools";

const made = createCalcToolExecutor({
  onResult: (o) => answerCard.push(o),   // {callId, tool, result, review, reviewPending, notes} — ژرف‌یخ‌زده، بی‌واسطهٔ legal-calc
  // deps: { courtFeeTariffs, ... }      // اختیاری؛ جدول‌های تزریقی (پیش‌فرض: داده‌های legal-calc)
});
if (!made.ok) return report(made.error);   // INVALID_OPTIONS + issues (فقط نامِ کلید)

const runner = createToolRunner({ gateway, loop, executeTool: made.value, totalTimeoutMs, toolTimeoutMs, maxResultChars });
await runner.run({ model, messages, maxOutputTokens, tools: CALC_TOOLS });   // tools هم به مدل می‌رود و هم allow-list است
```

## ضمانت‌ها
| رفتار | چرا |
|---|---|
| **نتیجهٔ موفق** = `{tool, result, review, reviewPending, notes}` (JSON، ترتیبِ کلیدها ثابت) و `reviewPending` در `ToolExecution` | مدل باید ببیند «تأییدنشده» است و هشدارها را کنار پاسخ بیاورد |
| **`reviewPending` شکست‌بسته:** `false` فقط وقتی هم پرچمِ calc-tools و هم `review.status === "legally-verified"` موافق باشند | ناسازگاریِ احتمالیِ آینده «تأییدشده» حساب نمی‌شود |
| **خطای محاسبه/اعتبارسنجی** ⇒ `{ok:false, content:{error:{code,message}}}` عیناً پیامِ فارسیِ calc-tools | مدل می‌تواند آرگومان را اصلاح کند؛ پیام کران‌دار و فقط شاملِ نامِ کلیدهای خودِ مدل است |
| **`onResult` پیش از بازگشت به مدل** صدا زده می‌شود؛ **اگر پرتاب کند نتیجه به مدل نمی‌رسد** (مجری `TOOL_FAILED` با متنِ ثابت) | نتیجه‌ای که ثبت/نمایش‌پذیر نشد (هشدارش گم می‌شود) نباید مبنای پاسخ شود |
| برای نتیجهٔ **خطا** `onResult` صدا زده نمی‌شود | چیزی برای نمایش نیست |
| **باگِ درونیِ legal-calc پنهان نمی‌شود** (بی‌try/catch؛ مجری آن را `TOOL_FAILED` می‌کند و متنِ استثنا به مدل/لاگ نمی‌رسد) | همان اصلِ calc-tools |
| **لغوِ پیش از اجرا** ⇒ هیچ محاسبه/ناظری؛ نتیجهٔ خطای ثابت | محاسبه همگام است و پس از شروع قطع‌شدنی نیست |
| **گزینه‌های نامعتبر** ⇒ `Result` خطا؛ مقدار بازتاب نمی‌شود | کلیدِ ناشناخته رد (غلطِ املایی بی‌صدا نادیده نمی‌ماند) |

## محدودیت‌های شناخته‌شده
- هنوز به ارکستراتور/مسیرِ محصول وصل نیست؛ `Answer.reviewPending` و اتصال به `metering` برش‌های بعدی‌اند.
- `notes` به مدل و ناظر می‌رسد ولی در `RunReport.toolRuns` نیست (عمداً بی‌نتیجه؛ ممیزی حریم). مصرف‌کننده باید `onResult` را وصل کند و با `callId` پیوند بزند.
- ابزارهای آینده (ارث، ویرایشِ سند) در برش‌های خودشان پورتِ خودشان را می‌گیرند؛ این پورت فقط calc-tools است.
- مدلِ زنده نیست؛ سازگاریِ ارائه‌دهنده در CT‑3c‑2 است.
