# tool-runner (لایهٔ ۴ · **I/O** · 🔴 بازبینی انسانیِ اجباری) — **برش CT‑4b: مجریِ حلقهٔ ابزار**

**هدف:** چرخاندنِ حلقهٔ **مدل ← ابزار ← مدل**: کنش‌هایی را که `tool-loop` می‌دهد اجرا می‌کند (فراخوانیِ دروازهٔ ابزار، اجرای ابزار از راهِ یک پورت) و نتیجه را به `tool-loop` برمی‌گرداند. **هیچ سیاستی از خودش ندارد:** سقفِ گام/فراخوانی/هزینه، تکرار و فراخوانیِ بریده فقط در `tool-loop` تصمیم گرفته می‌شود.
**وابستگی:** فقط `ai-gateway` (نوع‌ها، `TOOL_LIMITS`) و `tool-loop`. هیچ ابزارِ مشخصی (calc-tools) و هیچ ارائه‌دهنده‌ای (HTTP) را نمی‌شناسد؛ هر دو تزریق می‌شوند.

> ⚠️ **هنوز به هیچ مسیرِ محصولی وصل نیست** (`planned`). ریشهٔ ترکیب (ساختنِ دروازه با کلیدِ واقعی، نگاشتِ calc-tools به پورتِ ابزار، آستانه‌های مالک) برشِ بعد است. پاسخ‌های مدل در آزمون‌ها شبیه‌سازی‌اند.
> ⚠️ `totalTimeoutMs`، `toolTimeoutMs` و `maxResultChars` **الزامی و بی‌پیش‌فرض‌اند**؛ عددِ مناسب را مالک تعیین می‌کند. (آستانه‌های حلقه را مالک به `createToolLoop` می‌دهد.)

## رابط عمومی

```ts
import { createToolRunner } from "@/modules/tool-runner";

const made = createToolRunner({
  gateway: toolGateway,                 // createToolGateway(...)
  loop: toolLoop,                       // createToolLoop({ maxSteps, maxToolCalls, ..., budget })
  executeTool: async (call, { signal, callId }) =>
    ({ ok: true, content: JSON.stringify(result), reviewPending: true }),   // یا { ok: false, content }
  totalTimeoutMs: 120_000, toolTimeoutMs: 15_000, maxResultChars: 20_000,
  // timers?: { setTimeout, clearTimeout }   // پیش‌فرض: تایمرِ جهانی؛ آزمون‌ها تزریق می‌کنند
});
if (!made.ok) return report(made.error);   // INVALID_CONFIG + issues

const res = await made.value.run(
  { model: "legal", messages, maxOutputTokens: 800, tools: CALC_TOOLS /*، temperature، toolChoice، requestId، … */ },
  { signal: request.signal },
);
if (!res.ok) return report(res.error);     // خطای قرارداد؛ res.error.partial = هزینهٔ تاکنون (اگر حلقه شروع شده بود)
const { outcome, abortedBy, toolRuns } = res.value;   // outcome: answered | stopped(reason) — از tool-loop
```

`run` **هرگز پرتاب نمی‌کند** و **هرگز از `totalTimeoutMs` نمی‌ماند**. `input` همان `ToolStepRequest` است بی‌`continuation` (حلقه می‌سازد)؛ `tools` هم به مدل می‌رود و هم **فهرستِ مجازِ نام** است.

## ضمانت‌ها

| ضمانت | چگونه |
|---|---|
| ابزارِ بیرون از `tools` اجرا نمی‌شود | مدل نامِ دلخواه می‌فرستد؛ نام باید عیناً در `input.tools` باشد، وگرنه نتیجهٔ خطای `UNKNOWN_TOOL` به مدل می‌رود و پورت **صدا زده نمی‌شود** |
| ابزار ترتیبی اجرا می‌شود | به ترتیبِ مدل، یکی‌یکی (قطعی و ممیزی‌پذیر). هم‌زمانی عمداً نیست |
| ابزارِ معیوب حلقه را نمی‌شکند | پرتاب ⇒ `TOOL_FAILED`؛ مهلت ⇒ `TOOL_TIMEOUT`؛ شکلِ نادرست/تهی/NUL/جفت‌جانشینِ تنها ⇒ `TOOL_RESULT_INVALID`؛ بزرگ‌تر از `maxResultChars` ⇒ `TOOL_RESULT_TOO_LARGE`. به مدل **متنِ ثابت** می‌رسد؛ **پیامِ استثنا و نتیجهٔ نامعتبر هرگز بازتاب نمی‌شود** (ممکن است دادهٔ پرونده باشد) |
| `reviewPending` بی‌پیش‌فرض است | نتیجهٔ موفقِ بی‌`reviewPending` بولی ⇒ `TOOL_RESULT_INVALID` («تأییدشده» حدس زده نمی‌شود) |
| لغو و مهلتِ کل | `signal` فراخواننده + `totalTimeoutMs`؛ ابزارِ در-حال‌اجرا (حتی اگر `signal` را نادیده بگیرد) رها و `signal`اش لغو می‌شود؛ ابزارِ بعدی شروع نمی‌شود؛ حلقه با `CANCELLED` بسته می‌شود |
| **هزینه در لغو گم نمی‌شود** | گامِ در-پروازِ لغوشده «هزینهٔ **نامعلوم**» است نه صفر (`spend.complete=false`): دروازه تا `ABORT_GRACE_MS` (۲ ثانیه) فرصت دارد نتیجه/مصرف را برگرداند، وگرنه شکستِ مصنوعیِ `ABORTED` با مصرفِ `null` ثبت می‌شود. گامِ موفقی که هم‌زمان با لغو رسید شمرده می‌شود و ابزارهایش اجرا **نمی‌شوند** |
| خطای قرارداد میانِ اجرا | `CONTRACT_VIOLATION` با `error.partial` = نتیجهٔ `CANCELLED` (هزینهٔ تاکنون)؛ پیش از شروعِ حلقه `partial: null` |
| ممیزی بی‌حریم | `toolRuns[]`: `{id, name, status, code, reviewPending}` — **بی‌آرگومان و بی‌نتیجه**. ابزارِ لغوشده حین اجرا با `TOOL_ABORTED` می‌ماند (ممکن است اثرِ جانبی کرده باشد) |
| تایمر و شنونده نمی‌ماند | در هر مسیر (موفق/خطا/مهلت/لغو) پاک/برداشته می‌شود (آزمون با تایمرِ دستی) |

## `abortedBy` و `outcome`
`abortedBy` (`caller` / `deadline` / `null`) اولین علتِ لغو است و با `outcome.reason` یکی نیست: لغو **حینِ گام** ⇒ `STEP_FAILED` با `errorCode: "ABORTED"` (چون هزینه‌اش نامعلوم است)؛ لغو **حینِ ابزار یا بینِ کنش‌ها** ⇒ `CANCELLED`. مصرف‌کننده برای نمایشِ «لغو شد/مهلت گذشت» باید `abortedBy` را بخواند.

## محدودیت‌های شناخته‌شده
به هیچ مسیرِ محصولی وصل نیست؛ فقط ابزارِ ترتیبی؛ هیچ تلاشِ دوبارهٔ شبکه‌ای (سیاستِ آن جای دیگر)؛ اتصال به `metering` (رزرو/تسویه) و `Answer.reviewPending` در ارکستراتور برشِ بعد؛ پورتِ ابزارِ calc-tools هنوز نوشته نشده (فقط در آزمونِ `tooling/tool-runner-e2e.test.ts`)؛ مدل با سرورِ loopback شبیه‌سازی شده، نه ارائه‌دهندهٔ زنده (CT‑3c‑2). ابزارِ بی‌توجه به `signal` در پس‌زمینه ادامه می‌دهد (JS راهِ کشتنِ کار ندارد)؛ پورتِ ابزارِ واقعی باید `signal` را رعایت کند.
