# tool-loop (لایهٔ ۴ · **خالص** · 🔴 بازبینی انسانیِ اجباری) — **برش CT‑4a: کنترل‌گرِ خالصِ حلقهٔ ابزار**

**هدف:** تصمیم‌گیریِ «ادامه بده یا بایست» برای حلقهٔ **مدل ← ابزار ← مدل**، به‌صورت یک **ماشینِ حالتِ خالص و تغییرناپذیر**. هیچ مدلی را صدا نمی‌زند، هیچ ابزاری را اجرا نمی‌کند، به شبکه/فایل/ساعت/تصادف/محیط دست نمی‌زند (آزمونِ نگهبانِ کد منبع: `tooling/tool-loop-source.test.ts`) و **هرگز پرتاب نمی‌کند**.
**وابستگی:** فقط `ai-gateway` (نوع‌ها، `sumStepSpend`، `encodeToolResults`، `TOOL_STEP_LIMITS`، `TRUNCATED_TOOL_CALL_ISSUE`).

> ⚠️ **این ماژول فقط سیاست است، نه مجری.** هنوز هیچ کدی «حلقه را می‌چرخاند» (مجریِ واقعی = برشِ بعد، CT‑4b)؛ پس در `registry.ts` وضعیتش `planned` است. پاسخ‌های مدل در آزمون‌ها **شبیه‌سازی**اند و هیچ تماسِ زنده‌ای نشده است.
> ⚠️ همهٔ آستانه‌ها (`maxSteps`، `maxToolCalls`، `maxIdenticalCalls`، `truncationRetries`، `budget`) **الزامی و بی‌پیش‌فرض‌اند**؛ عددِ مناسب را مالکِ پول/امنیت تعیین می‌کند، نه این کد.

## رابط عمومی

```ts
import { createToolLoop } from "@/modules/tool-loop";

const made = createToolLoop({
  maxSteps: 5, maxToolCalls: 8, maxIdenticalCalls: 2, truncationRetries: 1,
  budget: { kind: "cap", currency: "IRR", maxMicros: 50_000, estimateStepMicros: (i) => meteringWorstCase(i) },  // یا { kind: "none" } (صریحاً)
});
if (!made.ok) return report(made.error);            // INVALID_CONFIG + issues
const loop = made.value;

let t = loop.start({ format: toolGateway.toolFormat(model)!, maxOutputTokens: 800, modelMaxOutputTokens: toolGateway.limits(model)!.maxOutputTokens });
for (;;) {
  const a = t.action;
  if (a.kind === "done") return a.outcome;          // answered | stopped(reason)
  const r = a.kind === "call-model"
    ? loop.onStep(t.state, await toolGateway.completeStep({ ...base, maxOutputTokens: a.maxOutputTokens, continuation: a.continuation }))
    : loop.onToolResults(t.state, await runTools(a.calls));   // [{ id, content, isError?, reviewPending }]
  if (!r.ok) throw/report(r.error);                 // خطای قرارداد (مجری باگ دارد)، نه ایستِ حلقه
  t = r.value;
}
```

| نام | کار |
|---|---|
| `createToolLoop(config)` | سنجشِ پیکربندی؛ `Result<ToolLoop>` |
| `loop.start(input)` | `{format, maxOutputTokens, modelMaxOutputTokens}` ← `call-model` گامِ ۱ (یا ایست اگر برآوردِ هزینه از همان آغاز نمی‌گنجد) |
| `loop.onStep(state, toolStepResult)` | نتیجهٔ `completeStep` (هر دو شاخهٔ `ok`) ← `run-tools` / `call-model` (ادامه یا تلاشِ دوباره) / `done` |
| `loop.onToolResults(state, results)` | نتیجهٔ اجرای ابزارها ← `call-model` / `done` |
| `loop.cancel(state)` | لغوِ مجری ← `done{CANCELLED}` با هزینهٔ تاکنون |
| `resolveToolLoopConfig`، `LOOP_LIMITS`، `budgetVerdict`، `canonicalCallKey` | اجزای قابل‌آزمونِ جدا |

**کنش‌ها:** `call-model{step, continuation, maxOutputTokens}` · `run-tools{calls}` · `done{outcome}`.
**نتیجه:** `answered{text}` یا `stopped{reason, errorCode}`؛ هر دو `steps`، `toolCalls`، `spend` (`StepSpend`) و `reviewPending` دارند. **ایست هیچ متنی نمی‌دهد** (پاسخِ ناتمام/نامطمئن عبور نمی‌کند).

## سیاستِ ایست (ترتیبِ ثابت پیش از هر «گامِ بعد»: سقفِ گام ← هزینه)

| دلیل | وقتی |
|---|---|
| `MAX_STEPS` | تعدادِ فراخوانیِ مدل (شاملِ تلاشِ دوبارهٔ بریدگی) به سقف رسید. **پیش از اجرای ابزارها** سنجیده می‌شود: ابزاری که نتیجه‌اش هرگز به مدل نمی‌رسد اجرا نمی‌شود |
| `MAX_TOOL_CALLS` | مجموعِ فراخوانی‌ها در کلِ حلقه از سقف گذشت؛ هیچ‌کدامِ آن گام اجرا نمی‌شود |
| `REPEATED_CALL` | همان ابزار با آرگومانِ هم‌ارز (ترتیبِ کلید/فاصله بی‌اثر) بیش از `maxIdenticalCalls` بار |
| `DUPLICATE_CALL_ID` | شناسهٔ فراخوانی تکراری (در یک گام یا میانِ گام‌ها) |
| `BUDGET_EXCEEDED` | «هزینهٔ معلومِ تاکنون + برآوردِ بدترین هزینهٔ گامِ بعد» > `maxMicros` (برابر مجاز است) |
| `SPEND_UNKNOWN` | **شکست‌بسته**: هزینهٔ یک گام نامعلوم، ارزِ دیگر، یا برآوردگر پرتاب کرد/عددِ نامعتبر داد. نامعلوم صفر نیست |
| `TRUNCATED_TOOL_CALL` | فراخوانیِ بریده و تلاشِ دوباره ممکن/مجاز نیست (سقفِ خروجی دوبرابر تا سقفِ مدل؛ پاسخِ بریده هرگز به مدل برنمی‌گردد) |
| `OUTPUT_TRUNCATED` / `MODEL_FILTERED` / `UNEXPECTED_FINISH` / `EMPTY_ANSWER` | پایانِ غیرعادیِ بی‌ابزار؛ متنی عبور نمی‌کند |
| `STEP_FAILED` | خطای دروازه (`errorCode` از فهرستِ بسته؛ ناشناخته ⇒ `UNKNOWN`) |
| `CONTINUATION_LIMIT` | `continuation` از سقفِ دروازه می‌گذرد (پیش از آن‌که دروازه `INVALID_REQUEST` بدهد) |
| `CANCELLED` | `cancel` |

## `reviewPending` (نمایشِ اجباری)
مجری برای **هر نتیجهٔ موفقِ ابزار** `reviewPending: boolean` را صریحاً می‌دهد (نگفتن = `INVALID_RESULTS`؛ «تأییدشده» هرگز پیش‌فرض نیست). اگر دست‌کم یکی `true` بود `outcome.reviewPending=true` است، **در پاسخ و در ایست**؛ مصرف‌کننده باید آن را کنارِ پاسخ نشان دهد (جدول‌های `legal-calc` هنوز تأییدِ حقوقدان ندارند). نتیجهٔ خطا (`isError`) اثری ندارد.

## چه چیزی عمداً نیست
اجرای مدل/ابزار و `AbortSignal`/مهلت (CT‑4b)؛ رزرو/تسویهٔ `metering` (برآوردگر تزریقی است و قیمت نمی‌شناسد)؛ تلاشِ دوباره/جایگزین برای خطاهای دروازه (`STEP_FAILED` می‌ایستد)؛ سنجشِ محتوای نتیجهٔ ابزار؛ سریال‌سازیِ حالت (حالت **داخلِ فرایند و مات** است: فقط حالتِ ساخته‌شدهٔ همین ماژول پذیرفته می‌شود، کپی/JSON رد می‌شود)؛ ثبت در `ai-orchestrator`.
