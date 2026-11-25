# tool-policy-source (لایهٔ ۶ · خالص · 🔴 بازبینی انسانیِ اجباری: مالک امنیت) — برش CT‑5c‑2c‑1

**هدف:** آخرین سیاستِ **معتبرِ** دروازهٔ ابزار را از `current()` مدیرِ نسخه‌دار بخواند و **همگام و بی‌I/O** در اختیارِ مسیرِ داغِ هر درخواست بگذارد؛ هنگامِ خرابیِ پایگاه فقط تا یک سقفِ سنِ **صریح** با آخرین‌خوبِ‌شناخته کار کند و پس از آن **ببندد**. تصمیم‌ها: `docs/adr/0071-tool-policy-source.md`.
**وابستگی:** فقط رابطِ عمومیِ `tool-policy` (`projectToolPolicy`، `resolveToolPolicy`) و `tool-policy-admin` (نوع‌ها). I/O، تایمر، ساعتِ سیستم، `process.env`، شبکه و پایگاه ندارد؛ **نامِ فیلد یا عددِ کرانِ سیاست در این ماژول نیست**.

> ⚠️ هنوز به مسیرِ محصول وصل نیست (`planned`). زمان‌بندیِ دوره‌ایِ `refresh()`، ساختنِ `createPgPolicyVersionStore → createToolPolicyAdmin → createPolicySource`، سیم‌کشیِ `snapshot().projection` به زنجیرهٔ دروازه، و CLIِ مهاجرت برشِ بعدیِ 2c است. بازبینیِ مالک امنیت انجام نشده.

## رابط
```ts
import { createPolicySource } from "@/modules/tool-policy-source";

const made = createPolicySource({ reader: admin /* { current() } */, clock /* یکنوا */, maxStaleMs, refreshTimeoutMs });  // Result؛ همهٔ چهار گزینه الزامی (بی‌پیش‌فرض)
const source = made.ok ? made.value : null;

await source.refresh();     // { ok, value: { outcome: "loaded"|"updated"|"unchanged", version } } | { ok:false, error:{ code } }
source.snapshot();          // همگام: { ok, value: { version, source, projection, drift, loadedAtMs, confirmedAtMs, ageMs } } | { ok:false, error:{ code: NOT_LOADED|STALE|CLOCK_INVALID } }
source.health();            // { state, version, ageMs, drift, consecutiveFailures, lastFailure, lastAttemptAtMs, lastSuccessAtMs } — فقط کد و عدد
```
همه `Result` برمی‌گردانند و **هرگز نمی‌پرتابند**؛ متنِ استثنای خواننده یا پایگاه هرگز بیرون نمی‌آید.

## قواعد
- **بسته‌شدنِ شکست:** بدونِ بارِ موفق `NOT_LOADED` (هرگز پیش‌فرض‌های کد، مگر مدیر صریحاً نسخهٔ ۰ را بدهد). شکستِ خواندن/نگاشت آخرین‌خوب را نگه می‌دارد، اما فقط تا `maxStaleMs` از **شروعِ** آخرین تأییدِ موفق؛ بعد `STALE`. (در سقفِ دقیق هنوز باز؛ یک میلی‌ثانیه بعد بسته.)
- **پاسخِ خواننده ورودیِ ناشناخته است:** `ok`، نسخه (عددِ صحیحِ ایمن ≥ ۰)، `source` (`version==0 ⇔ defaults`)، `drift` بولی، و `policy` باید **شیءِ کاملِ نقطهٔ ثابتِ `resolveToolPolicy`** باشد؛ سپس فقط با `projectToolPolicy` نگاشت می‌شود. (`policy` غایب/ناقص نباید بی‌صدا با پیش‌فرض پر شود؛ آزمون این را گرفت.) ترتیبِ کلیدها مهم نیست (jsonb آن را عوض می‌کند).
- **نسخه عقب نمی‌رود** (`VERSION_REGRESSED`؛ مثلاً پایگاهِ بازیابی‌شده از پشتیبانِ قدیمی) و **همان نسخه با محتوای دیگر رد می‌شود** (`VERSION_CONTENT_MISMATCH`؛ ذخیره‌ساز فقط‌افزودنی است). برای پذیرفتنِ عمدیِ عقب‌گرد، فرایند را ریستارت کنید.
- **تازه‌سازیِ هم‌زمان** یک تلاش را شریک است. تلاشی که از `refreshTimeoutMs` قدیمی‌تر شود **رها** می‌شود (ماژول تایمر ندارد: رهاشدن در فراخوانیِ بعدیِ `refresh` رخ می‌دهد) و نتیجه‌اش اگر برسد `SUPERSEDED` است و حالت را نمی‌گیرد و شکستِ منبع شمرده نمی‌شود.
- **ساعت باید یکنوا باشد.** ساعتِ نامعتبر ⇒ `INVALID_CLOCK` (خواننده صدا زده نمی‌شود)؛ ساعتِ رو به عقب یا پرتاب‌کننده ⇒ `snapshot` با `CLOCK_INVALID` می‌بندد تا یک `refresh` موفق دوباره‌پایه‌گذاری کند.
- `snapshot()` هر بار شیءِ یخ‌زدهٔ تازه می‌دهد؛ `projection` مشترک و یخ‌زده است (بی‌کپیِ هر درخواست).
- `drift` از مدیر عبور می‌کند و فقط گزارش می‌شود (دروازه نمی‌شود).

## محدودیت‌های شناخته‌شده (صادقانه)
- **اگر `reader.current()` هرگز تمام نکند** وعدهٔ همان `refresh` هم تمام نمی‌شود (بی‌تایمر). سقفِ زمانیِ واقعی با ذخیره‌ساز است (`statement_timeout` سمتِ پایگاه در `tool-policy-store-pg`)؛ تلاشِ بعدی همچنان قفل نمی‌شود. زمان‌بندِ دوره‌ایِ 2c نباید `await`ِ بی‌پایان بگذارد.
- کرانِ `maxStaleMs` ۱ثانیه تا ۲۴ساعت و `refreshTimeoutMs` ۱۰۰ میلی‌ثانیه تا ۵ دقیقه **پیشنهادِ این برش** است (مالک تأیید نکرده)؛ **عددِ استقرار** را مالک می‌گذارد و پیش‌فرض ندارد. این ماژول رابطهٔ `maxStaleMs` با `reservationTtl` یا فاصلهٔ تازه‌سازی را نمی‌سنجد (زمان‌بندِ 2c).
- سیاستِ کهنه تا `maxStaleMs` همچنان اعمال می‌شود (تغییرِ ادمین دیرتر می‌رسد). اعلانِ تغییر نیست؛ هر نمونه باید دوره‌ای `refresh` کند.
- `STALE` همهٔ درخواست‌های متکی بر `snapshot` را رد می‌کند؛ تصمیمِ «چه پاسخی به کاربر» با ریشهٔ I/O است.
- هنوز به محصول وصل نیست.

## آزمون
`config`، `source` (رفتاری با ساعت و خواننده‌ٔ مجازی: مرزهای دقیقِ سن/رهاکردن، هم‌زمانی، رد کردن‌ها، بی‌نشت)، `evaluate` (داورِ خالص)، `property` (۳۰۰ بذر × ۶۰ گام در برابرِ داورِ مستقل) و در `tooling/`: `tool-policy-source-source.test.ts` (نگهبانِ منبع)، `tool-policy-source-admin.test.ts` (مدیرِ واقعی + اعتبارسنجِ واقعیِ پایین‌دست)، `tool-policy-source-store-pg.pg.test.ts` (PostgreSQL واقعی: ریستارت، خرابیِ پایگاه، نسخهٔ عقب‌رفته). جهش‌آزمایی: `tooling/mutation/tool-policy-source.py`.
