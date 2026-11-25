# tool-policy (لایهٔ ۵ · خالص · 🔴 بازبینی انسانیِ اجباری: مالک امنیت) — برش CT‑5c‑2a

**هدف:** آستانه‌های **مهندسیِ** دروازهٔ ابزار (نه حقوقی، نه قیمت) یک منبعِ حقیقت دارند: پیش‌فرض‌های کد + بازنویسیِ جزئیِ ادمین با اعتبارسنجیِ **ساختاری**؛ تا ریشهٔ I/O (CT‑5c‑2c) و تنظیماتِ ادمین (2b) نتوانند مجموعه‌ای بسازند که «گامِ زامبی» یا رزروِ ردشده بسازد. تصمیم‌ها: `docs/adr/0067-tool-policy.md`.
**وابستگی:** فقط رابط‌های عمومیِ `tool-call-deadline` (`checkTimingRelations`، `CALL_DEADLINE_LIMITS`)، `tool-loop`، `calc-answer-cards`، `tool-runner`، `metering`، `ledger` — **کرانِ فیلدها از همان‌ها می‌آید و کپی نمی‌شود**. I/O، ساعت، تصادف و `process.env` ندارد.

> ⚠️ هنوز به مسیرِ محصول وصل نیست (`planned`). بازبینیِ مالک امنیت انجام نشده. **عددِ قیمت/ارز/حساب/کلید این‌جا نیست و نخواهد بود.**

## رابط
```ts
import { resolveToolPolicy, projectToolPolicy, timingFromGrace, toolScopeId, DEFAULT_TOOL_POLICY } from "@/modules/tool-policy";

const policy = resolveToolPolicy(adminOverrides);      // undefined ⇒ پیش‌فرض‌های کد؛ Result، هرگز نمی‌پرتابد
const p = projectToolPolicy(adminOverrides);           // گزینه‌های آمادهٔ loop / service / deadline / durable / gatewayModel (بی‌budget)
const t = timingFromGrace(60_000);                     // {graceMs, maxCallMs: ⌊۴۰٪⌋, reservationTtlMs: ۴×}
const s = toolScopeId(requestId);                      // "calc-answer.<requestId>" (ID_RE و ≤ ۹۶ نویسه)
```
ریشهٔ I/O فقط این را می‌سازد: `service(durable(deadline(gateway)))` با `p.deadline`، `p.durable`، `p.loop + budget`، `p.service`، و `p.gatewayModel.timeoutMs` در جدولِ مدلِ دروازه.

## پیش‌فرض‌های کد (دلیل‌ها در ADR)
| کلید | مقدار | دلیل |
|---|---|---|
| `timing.graceMs` | ۹۰٬۰۰۰ | ≥ ۳۰ ث (تأییدِ مالک)؛ جا برای `maxCallMs` + تسویه |
| `timing.maxCallMs` | ۳۶٬۰۰۰ | ۴۰٪ graceMs (تأییدِ مالک) |
| `timing.reservationTtlMs` | ۳۶۰٬۰۰۰ | ۴×graceMs (تأییدِ مالک) |
| `metering.onUnknownCost` | `forfeit` | هزینهٔ نامعلوم هرگز رایگان نمی‌شود (تأییدِ مالک) |
| `model.timeoutMs` | ۳۰٬۰۰۰ | کمتر از `maxCallMs` تا زمان‌سنجِ خودِ دروازه (که هزینه را گزارش می‌دهد) اول برنده شود |
| `loop` | ۸ گام، ۱۶ ابزار، ۲ تکرارِ یکسان، ۱ تلاشِ مجددِ بریده | کوچک‌تر از سقفِ فنیِ `tool-loop` |
| `run` | کل ۱۸۰ ث، هر ابزار ۵ ث، نتیجه ۴٬۰۰۰ نویسه | یک گام در کل جا می‌شود |
| `answer` | ۵ کارت، ۱٬۰۲۴ توکنِ خروجی | سقفِ فنی کوچک |
| `metering.perMessageOverheadTokens` | ۱۶ | برآوردِ محافظه‌کارانهٔ رزرو (بیشتر ⇒ رزروِ بزرگ‌تر، هرگز کم‌گیری) |
| `model.name` | `calc-answer` | نامِ **منطقی**؛ نامِ ارائه‌دهنده و قیمت با مالک/ریشه است |

## رابطه‌ها (`checkPolicyRelations`، تنها منبع)
۱) سه رابطهٔ `checkTimingRelations` (مثبتِ صحیح؛ `maxCallMs < graceMs`؛ `ttl ≥ ۲×graceMs`) — **کپی نشده**؛ ۲) `graceMs ≥ ۳۰٬۰۰۰`؛ ۳) `maxCallMs ≤ graceMs/۲` (حاشیهٔ تسویه دست‌کم برابرِ سقفِ تماس)؛ ۴) `model.timeoutMs < maxCallMs`؛ ۵) `totalTimeoutMs ≥ maxCallMs`. رابطه‌ها فقط وقتی سنجیده می‌شوند که هر پنج فیلدِ درگیر خودشان معتبر باشند (بی‌پیامِ تکراری).

## قواعد
- کلیدِ ناشناخته رد می‌شود، **نه نادیده**؛ مقدارِ نامعتبر (حتی `undefined`ِ صریح) هرگز بی‌صدا با پیش‌فرض جایگزین نمی‌شود؛ `null` ریشه رد می‌شود (بی‌بازنویسی = `undefined`).
- بازنویسیِ ناسازگار **هرگز خودکار اصلاح نمی‌شود**؛ برای مجموعهٔ سازگار `timingFromGrace` را بزنید (`model.timeoutMs` را عوض نمی‌کند).
- هر کلید یک بار خوانده می‌شود؛ خروجی عمیق‌یخ‌زده و مستقل از ورودی؛ خودهمانی (`resolve(resolve(x)) = resolve(x)`)؛ مشکل‌ها فقط مسیرِ فیلد و کرانِ کد، هرگز مقدار؛ حداکثر ۲۰ مورد.
- `projectToolPolicy` ورودی را **دوباره** اعتبارسنجی می‌کند (شیءِ دست‌کاری‌شده هرگز نگاشت نمی‌شود).

## محدودیت‌های شناخته‌شده (صادقانه)
- عددهای پیش‌فرض **پیشنهادِ مهندسی‌اند نه اندازه‌گیریِ تولید**؛ `maxCallMs=۳۶ ث` باید با تأخیرِ واقعیِ ارائه‌دهنده سنجیده شود (CT‑5c‑2c/پایش). بازبینیِ مالک لازم است.
- `release` مجاز است ولی تماسی که ارائه‌دهنده پولش را گرفته رایگان می‌شود؛ تصمیمِ ادمین/مالک است و رابطهٔ ساختاری ندارد.
- رابطهٔ فاصلهٔ رفتگر (`intervalMs ≤ ⌊graceMs/۲⌋`) هنوز این‌جا نیست (در `settlement` اِعمال می‌شود؛ ساختاری‌شدنش با 2c).
- `budget` (سقفِ هزینه با ارز و برآوردگر) و جدولِ قیمت با ریشهٔ I/O و مالک است.
