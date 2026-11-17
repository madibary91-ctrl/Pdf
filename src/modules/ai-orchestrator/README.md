# ai-orchestrator (لایهٔ ۴ · غیرخالص · 🔴 بازبینی انسانیِ اجباری) — **برش ۱: ستون فقراتِ پرسش‌وپاسخِ مستند**

**هدف:** خط لولهٔ تک‌نوبتیِ «پرسش ← بازیابی ← پرامپت ← مدل ← مستندسازی و راستی‌آزمایی ← پاسخ» که **هیچ ارجاع نامعتبری را خروجی نمی‌کند**، بی‌منبع مدل را فراخوانی نمی‌کند و هزینهٔ خرج‌شده را گم نمی‌کند.
**وابستگی (در عمل):** فقط `ai-gateway`، `retrieval` و `citation-verifier` از فهرست `registry.ts` (`calc-tools`، `doc-templates-core` و `ledger` هنوز ساخته نشده‌اند). به شبکه، فایل، `process.env`، ساعت سیستم و تصادف دست نمی‌زند؛ همه‌چیز از **پورت** می‌آید (آزمونِ نگهبانِ کد منبع: `purity.test.ts`).

> ⚠️ **این برش ۱ از ۶ برش است** (ADR-0016). هنوز: چندنوبتی، ترمیم/بازتولید، ابزار، دفتر اعتبار، فرمان خط و آداپتور HTTP نیست؛ پس در `registry.ts` وضعیتش «planned» می‌ماند (تغییر با مالک معماری).
> این ماژول **هیچ قانون، عدد، قیمت یا نام ارائه‌دهنده‌ای** ندارد. متن پرامپت (`prompt.ts`) یک **سیاست رفتاری حقوقی** است؛ ویرایشش بازبینی انسانی می‌خواهد.
> ⚠️ **راستی‌آزمایی «وجود، اعتبار زمانی، تأیید و نقل‌قول» را می‌سنجد، نه اینکه جمله از آن ماده نتیجه می‌شود.** مدل می‌تواند ارجاعِ درست را زیر ادعای نادرست بگذارد؛ حقوقدان باید پاسخ را بخواند.

## رابط عمومی

```ts
import { createOrchestrator, createCitationChecker } from "@/modules/ai-orchestrator";
import { createResilientGateway } from "@/modules/ai-gateway";

const checker = createCitationChecker({ current: () => corpusIndex });   // نمایه به‌ازای هر درخواست گرفته می‌شود
const made = createOrchestrator({
  searcher: kbStore,                      // هر چیز با searchArticles (خودِ KbStore)
  gateway: resilientGateway.value,        // createGateway یا createResilientGateway
  checker,
  policy: { onRejectedCitation: "withhold", requireQuotes: true },   // بی‌پیش‌فرض؛ توصیه برای رو به کاربر
});
if (!made.ok) return report(made.error);  // INVALID_CONFIG + issues

const r = await made.value.ask({ question, asOf: "2024-03-01", model: "legal-chat", maxOutputTokens: 800, requestId: "req-1" }, { signal });
if (!r.ok) return report(r.error);        // code، message ثابت، retryable، accounting
r.value; // { status, text, citations, rejections, unsupportedNumbers, retrieval, generation, accounting, warnings, asOf, promptVersion }
```

| نام | کار |
|---|---|
| `createOrchestrator(config)` | سنجش و «گرفتنِ» پیکربندی؛ `Result<Orchestrator>` (هرگز پرتاب نمی‌کند) |
| `orchestrator.ask(input, { signal? })` | خط لولهٔ کامل؛ `Result<Answer>`؛ **هرگز پرتاب نمی‌کند** (حتی اگر هر پورتی پرتاب کند) |
| `createCitationChecker(indexSource)` | آداپتور واقعی پورت راستی‌آزمایی روی `citation-verifier` (سیاست سخت: `allowUnverified: false`) |
| `buildPrompt`، `parseModelOutput`، `scanMarkers`، `rewriteMarkers`، `auditNumbers`، `ground`، `parseAskRequest` | اجزای آزمون‌پذیر |

## ورودی و پیکربندی — سخت‌گیر و بی‌حدس

- **ورودی:** `question` (۱…۲۰۰۰ نویسه)، `asOf` (تاریخ تقویمیِ معتبر)، `model`، `maxOutputTokens` **الزامی‌اند**؛ اختیاری: `documentId` (بازیابی را محدود می‌کند و سند پیش‌فرض نگهبان متن می‌شود)، `contextMaxChars` (۲۰۰…۲۰۰٬۰۰۰؛ پیش‌فرض ۶۰۰۰)، `retrieval` (`limit`، `maxTerms`، `minCoverage`، `maxQueries`)، `requestId`، `timeoutMs`.
- **گزینه نیستند:** `verifiedOnly` (همیشه `true`) و `temperature` (همیشه `0`، صریحاً به دروازه). کلید ناشناخته رد (`issues: ["unknown:verifiedOnly"]`).
- **پیکربندی:** `policy.onRejectedCitation` (`"redact"` | `"withhold"`) و `policy.requireQuotes` (بولی) **الزامی‌اند**؛ کلید ناشناخته رد. پیکربندی هنگام ساخت «گرفته» می‌شود (متدها bind، کپی منجمد).

## چطور کار می‌کند (ترتیب مراحل؛ ADR-0016 §۸)

1. اعتبارسنجی ← لغو؟ ← `gateway.limits(model)` (ناشناخته ⇒ `UNKNOWN_MODEL`؛ سقف خروجی بیش از حدّ مدل ⇒ `INVALID_INPUT`).
2. **بودجهٔ زمینه** = `min(contextMaxChars, maxInputChars − ثابتِ پرامپت و پرسش)`؛ کمتر از ۲۰۰ ⇒ `PROMPT_BUDGET` (پرسش هرگز کوتاه نمی‌شود). ناورداً مجموع پیام‌ها ≤ `maxInputChars`.
3. بازیابی (`verifiedOnly: true`) ← زمینهٔ شماره‌دار (`S1`، `S2`، …).
4. **بدون منبع ⇒ `status: "no-sources"`، صفر فراخوانی مدل، `accounting: null`** (و هشدارِ ناقص‌بودن بازیابی حفظ می‌شود: نمایهٔ کهنه ≠ «قانونی نیست»).
5. **گشودن نشستِ راستی‌آزمایی پیش از تولید:** نشدن ⇒ `VERIFIER_UNAVAILABLE` بی‌هزینه. لغو؟
6. تولید (پرامپت نسخه‌دار؛ پرسش و منابع فقط درون `<sources>`/`<question>`؛ `<` شبیه برچسب‌ها با `‹` هم‌طول خنثی می‌شود).
7. **تحلیل خروجی:** فقط `finishReason: "stop"`؛ JSON خام یا یک بلوک ```؛ هر انحراف `MODEL_OUTPUT_INVALID` (با `reason` بسته و **با حسابداری**).
8. **مستندسازی** (`ground`): نشانه‌های `[S1]`/`[S1, S2]` ← ارجاع ساختاریافتهٔ همان زمینه (شناسهٔ جعلی رد) ← راستی‌آزمایی در `asOf` با نقل‌قول (`requireQuotes`)؛ منبع با چند ورودی فقط اگر **همهٔ** ورودی‌ها پذیرفته شوند ← نشانهٔ ردشده و **مخدوش** (`[S۱]`، `[S1 S2]`، `[s1]`) با `[ارجاع نامعتبر حذف شد]` عوض می‌شود ← نگهبان متن (`checkText`) روی متنِ نهایی ← **گام آخر همیشه از خودِ ماست** (هر نشانهٔ ناپذیرفته حتی اگر نگهبان برگرداند حذف می‌شود) ← ارجاع‌های خروجی = پذیرفته‌شده‌های حاضر در متن.

## `status` و سیاست

| `status` | معنا | `text` |
|---|---|---|
| `answered` | ≥۱ ارجاع پذیرفته و چیزی حذف نشد | متن |
| `answered-redacted` | چیزی حذف شد (`redact`) | متنِ حذف‌شده |
| `no-sources` | بازیابی بند مجاز نداد؛ مدل فراخوانی نشد | `null` |
| `model-abstained` | مدل `insufficient: true` داد | `null` |
| `withheld` | `withheldReason`: `no-valid-citation` یا `citation-rejected` (`withhold` + هر رد) | `null` |

**هیچ متنی بدون دست‌کم یک ارجاعِ پذیرفتهٔ حاضر در همان متن نمایش داده نمی‌شود** (سیاست ثابت). `rejections` فقط `kind` (`claim`/`marker`/`mention`)، شناسهٔ پاک‌سازی‌شده (`S<n>` یا `null`)، کد حکم و پیام ثابت دارد؛ متنِ ردشده هرگز در خروجی نیست.

## خطا و حسابداری

خطاها: `INVALID_CONFIG`، `INVALID_INPUT`، `UNKNOWN_MODEL`، `PROMPT_BUDGET`، `RETRIEVAL_FAILED` (قابل‌تلاش؛ پیش از هزینه)، `VERIFIER_UNAVAILABLE` (قابل‌تلاش؛ پیش از هزینه)، `GENERATION_FAILED` (`gatewayCode`، `retryable` و `retryAfterMs` از دروازه)، `MODEL_OUTPUT_INVALID`، `VERIFICATION_FAILED`، `ABORTED`، `INTERNAL_ERROR`. پیام‌ها **ثابت‌اند**: هرگز پرسش، متن بند، پاسخ خام مدل، پیام ارائه‌دهنده یا استثنا.
`accounting` روی موفقیت و روی خطاهای پس از تولید می‌آید: از `report` تاب‌آور (`source: "report"`؛ `spend` همهٔ تلاش‌ها به‌تفکیک ارز، `costUnknownCalls`، `retried`، `fellBack`)، وگرنه هزینهٔ تلاش موفق (`"completion"`)، وگرنه «نامعلوم» (`"unknown"`؛ **نه صفر**). `generation.cost` مالِ آخرین تلاش است، نه کل. **`ledger` آینده نباید فقط بر پایهٔ `requestId` تکراری‌زدایی کند** (یادداشت ۰۰۱۵ بند ۴).

## محدودیت‌های شناخته‌شده (صادقانه)

- **راستی‌آزمایی ≠ استنتاج:** جمله‌ای که زیر ارجاعِ معتبر نشسته ممکن است از آن ماده نتیجه نشود. (کاهش: `requireQuotes`؛ مستندسازی جمله‌به‌جمله: برش ۷‑۳.)
- ادعای بی‌نشانه (جمله‌ای بدون `[S…]`) گرفته نمی‌شود؛ فقط «حداقل یک ارجاع پذیرفته» اجباری است.
- ممیزی عدد فقط هشدار است و عددِ حروفی («بیست روز») را نمی‌بیند.
- بازیابی واژه‌ای است (ADR-0013): «بدون منبع» ممکن است «بازیابی نکرد» باشد، نه «قانونی نیست».
- تک‌نوبتی؛ بی‌استریم؛ بی‌ابزار؛ بی‌ترمیم؛ بی‌دفتر اعتبار؛ بی‌آداپتور HTTP. خروجی نامعتبر مدل بازتولید نمی‌شود (`retryable: false` تا برش ۷‑۳).
- پرسش کاربر به ارائه‌دهندهٔ مدل می‌رود؛ با زنجیرهٔ جایگزینِ دروازه به ارائه‌دهندهٔ دیگری هم (ADR-0015 §۷؛ هشدار `FELL_BACK`/`accounting.fellBack`).
- نمایهٔ راستی‌آزمایی و بازیابی در یک لحظه جفت نیستند؛ ناسازگاریِ نمایه با پایگاه به‌سمت **رد** خطا می‌کند (ایمن)، نه پذیرش.

## تست‌ها

`*.test.ts` در همین پوشه (واحد، خصمانه، قراردادی با `createGateway`/`createResilientGateway` واقعی) + `tooling/orchestrator-pipeline.test.ts` (PostgreSQL واقعی، راستی‌آزمای واقعی و **۲۰۰ بذر** خاصیتی با راستی‌آزمایِ مستقل) + جهشی: `python3 tooling/mutation/ai-orchestrator.py`.
