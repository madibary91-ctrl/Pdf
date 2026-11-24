# calc-answer-cards (لایهٔ ۴ · خالص · 🔴 بازبینی انسانیِ اجباری) — **برش CT‑5b: کارتِ پاسخِ محاسبه**

**هدف:** آنچه کاربر از نتیجهٔ محاسبهٔ حقوقی می‌بیند (عدد، هشدار، برچسبِ بازبینی) **از رویدادِ بی‌واسطهٔ legal-calc** (`onResult` در `calc-tool-executor`) ساخته شود، نه از متنِ مدل. این ماژول رویدادها را به کارتِ ژرف‌یخ‌زده جمع می‌کند و با گزارشِ `ToolRunner.run` ترکیب می‌کند تا پاسخِ نهاییِ قابل‌نمایش بسازد.
**وابستگی:** فقط `calc-tools` (نوع‌ها و `isCalcToolName`)، `calc-tool-executor` (نوعِ رویداد) و `tool-runner` (نوعِ گزارش). همگام، بی‌I/O، بی‌ساعت، بی‌تصادف.

> ⚠️ **هنوز به هیچ مسیرِ محصولی وصل نیست** (`planned`). ریشهٔ ترکیب (ساختنِ دروازه با کلیدِ واقعی، آستانه‌های مالک، وصلِ `observe` به `onResult`) برشِ بعد است.
> ⚠️ هیچ عدد، قالب‌بندیِ عددی (جداکننده، ارز، رقمِ فارسی) یا سیاستِ حقوقی در این ماژول نیست؛ `result` عیناً از legal-calc است و رابط آن را نمایش می‌دهد. متن‌های ثابتِ فارسی (عنوان‌ها، برچسب، اعلان‌ها) **باید حقوقدان بازبینی کند**.

## رابط عمومی

```ts
import { createCardCollector } from "@/modules/calc-answer-cards";
import { createCalcToolExecutor } from "@/modules/calc-tool-executor";

const cards = createCardCollector({ maxCards: 6 });         // برای «هر اجرا» یکی؛ maxCards الزامی و بی‌پیش‌فرض (۱ تا ۵۰)
if (!cards.ok) return report(cards.error);                   // INVALID_OPTIONS

const exec = createCalcToolExecutor({ onResult: cards.value.observe });   // ← کارت از رویدادِ legal-calc
// ... createToolRunner({ executeTool: exec.value, ... }); const run = await runner.run(input, { signal });
if (!run.ok) return fail(run.error);

const composed = cards.value.compose(run.value);             // هرگز پرتاب نمی‌کند
if (!composed.ok) return fail(composed.error);               // پاسخِ مدل را نمایش نده!
const { text, cards: shown, reviewPending, notices } = composed.value;
```

## ضمانت‌ها

| ضمانت | چگونه |
|---|---|
| عدد و هشدار از legal-calc است، نه از مدل | کارت از `observe` ساخته می‌شود؛ `compose` متنِ مدل را **دست‌نخورده** برمی‌گرداند و کارت را کنارش می‌گذارد؛ اعلانِ ثابتِ «اگر متن با کارت اختلاف داشت، کارت معتبر است» |
| کارت از منبع جداست و تغییر نمی‌کند | `result` با رفت‌وبرگشتِ JSON کپی و **ژرف‌یخ‌زده** می‌شود؛ مقدارِ غیرِ JSON (چرخه، BigInt، `undefined`) رد می‌شود |
| «تأییدشده» فقط شکست‌بسته | `reviewPending = پرچمِ ناظر ∨ status≠"legally-verified" ∨ بازبینِ تهی ∨ تاریخِ تهی`؛ سپس در `compose` با رکوردِ اجرا و `outcome.reviewPending` **یا** می‌شود: تأییدنشدگی فقط بالا می‌رود |
| پاسخی که بر نتیجه‌ای بنا شده که کاربر نمی‌بیند نمایش داده نمی‌شود | اجرای **موفقِ** ابزار بی‌کارت ⇒ `CARD_MISSING`؛ نامِ ابزارِ ناهمخوان ⇒ `TOOL_MISMATCH`؛ شناسهٔ تکراری ⇒ `DUPLICATE_CALL_ID` |
| کارتِ نتیجه‌ای که به مدل نرسید نمایش داده نمی‌شود | ناظر پیش از مجری صدا زده می‌شود (مثلاً نتیجهٔ بزرگ‌تر از `maxResultChars` ⇒ `TOOL_RESULT_TOO_LARGE`)؛ چنین کارتی در `droppedCards` می‌شمارد و نمایش داده نمی‌شود |
| ناظرِ شکست‌خورده بلعیده نمی‌شود | `observe` **عمداً پرتاب می‌کند** (رویداد نامعتبر، `callId` تکراری، سقف پر) ⇒ مجری `TOOL_FAILED` می‌کند و نتیجه به مدل نمی‌رسد (ADR-0059 بند ۵). پیامِ استثنا **ثابت** است؛ استثنای بومی (JSON/getter) هم به آن تبدیل می‌شود تا نامِ فیلد یا دادهٔ پرونده نشت نکند |
| ترتیبِ قطعی | کارت‌ها به ترتیبِ **اجرا** (`toolRuns`)؛ اعلان‌ها: تأییدنشدگی، سپس اولویتِ کارت |
| بی‌پرتاب در ترکیب | گزارشِ نامعتبر/Proxy بدجنس ⇒ `INVALID_REPORT` با نامِ فیلد (بی‌بازتابِ مقدار) |

## `ComposedAnswer`
`{status: "answered"|"stopped", text|null, stopReason|null, abortedBy, cards[], reviewPending, notices[], droppedCards}`. برای `stopped` متن `null` است (پاسخِ ناتمام هرگز پاسخ حساب نمی‌شود) ولی کارت‌های اجراشده می‌مانند (محاسبه انجام و هزینه‌اش پرداخت شده است).

## محدودیت‌های شناخته‌شده
- به مسیرِ محصول وصل نیست؛ فقط ابزارهای `calc-tools` (اجرای موفقِ ابزارِ دیگر بی‌کارت ⇒ `CARD_MISSING`؛ ابزارِ آینده جمع‌آورندهٔ خودش را می‌گیرد).
- **تطبیقِ عددِ متنِ مدل با کارت انجام نمی‌شود** (مثلاً هشدار وقتی مدل عددی می‌نویسد که در هیچ کارتی نیست)؛ فقط اولویتِ کارت اعلان می‌شود. برشِ بعدی/باز.
- جمع‌آورنده **یک‌اجرایی** است؛ استفادهٔ دوباره ⇒ `callId` تکراری ⇒ `TOOL_FAILED` (شکست‌بسته).
- برچسب‌ها فقط فارسی‌اند و در انتظارِ بازبینیِ حقوقدان؛ تاریخِ `reviewedOn` عیناً از legal-calc (جلالی) نمایش داده می‌شود، بی‌تبدیل.
- `Answer.reviewPending` در `ai-orchestrator` و `metering` برشِ بعد.
