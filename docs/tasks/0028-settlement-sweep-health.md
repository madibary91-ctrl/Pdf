# settlement م۳‑ه‑۱: ارزیابِ سلامتِ رفتگر (`createSweepHealthCheck`)

## هدف (یک جمله)
از `SweepLoopStatus` و ساعتِ فراخواننده به‌صورتِ تابعِ خالص و شکست‌بسته تعیین کند رفتگر `ok`، `degraded` یا `down` است، و کدِ HTTP پروبِ سلامت را بدهد — تا ریشهٔ ترکیب (برشِ بعد) فقط سیم‌کشی باشد.

## زمینه
تحویل ۰۰۲۹ «گام بعد ۱» (ریشهٔ ترکیب). ADR-0030 تصمیم‌ها و برش‌بندیِ ریشهٔ ترکیب را ثبت کرده است (این برش فقط سیاستِ سلامت).

## ماژول و پوشه‌های مجاز
`src/modules/settlement/` فقط: `types.ts` (نوع‌های تازه، افزایشی)، `index.ts` (صادرات)، `README.md`، و فایل‌های **جدید**: `health.ts`، `health.test.ts`، `tooling/mutation/settlement-sweep-health.py`. تنها ویرایشِ آزمونِ موجود: `purity.test.ts` (فهرستِ فایل‌ها و صادرات؛ `Test-Change-Approved`). بعلاوه `docs/` و `tooling/ci-tests.ts` (فقط کفِ دروازه؛ کامیتِ جدا).

## ممنوع
تغییرِ هر آزمونِ موجود جز مورد بالا؛ تغییرِ `SweepLoop`/`SweepLoopStatus`/`SweepReport`؛ ساعت/تایمر/پایگاه/`process` در `health.ts`؛ ماژولی جز `settlement`؛ `registry.ts`؛ `src/app`؛ وابستگیِ تازه؛ خروجیِ شاملِ هر متن/مقدارِ ورودی.

## قرارداد
افزایشی: `createSweepHealthCheck(raw): SettlementResult<SweepHealthCheck>`، `sweepHealthHttpStatus(health): 200 | 503`، و نوع‌های `HealthStatus`، `HealthReason(Code)`، `SweepHealth(Check|Config|Input)`.

## معیار پذیرش
1. سکوت ≤ ⌊grace/2⌋ ⇒ ok؛ `>` ⇒ degraded؛ `> grace` ⇒ down؛ مرزها با ±۱ آزموده (مقایسهٔ اکیداً `>`).
2. حالت‌ها: `stopped`/`stalled` ⇒ down، `stopping` ⇒ degraded؛ در `running` شکستِ پیاپی ⇒ degraded با نوعِ شکست (هر هشت نوع).
3. `sinceMs`: مرجع = دیرترینِ آخرین موفقیت و آغاز؛ بی‌مرجع ⇒ degraded (`NOT_YET_RUN`/`NO_SUCCESS_SINCE_START`)؛ ساعتِ عقب‌رفته ⇒ degraded (`CLOCK_BEHIND`).
4. شکستِ بسته: `status`/`nowMs`/`sinceMs` نامعتبر، ورودیِ غیرشیء، getter/Proxy (حتی لغوشده) ⇒ down بی‌پرتاب.
5. بی‌نشت و ثابت‌شکل: نتیجه فقط کد و عدد؛ فیلدِ اضافه و متنِ نامعتبر نمی‌رسد؛ منجمد و JSON-پذیر.
6. پیکربندی: `graceMs` الزامی (۲…سقف)، آستانه‌های دستیِ سازگار، کلیدِ ناشناخته رد؛ پیام‌ها فقط نامِ فیلد.
7. یکنوایی: با ثابت‌ماندنِ وضعیت، جلو رفتنِ ساعت هرگز سلامت را بهتر نمی‌کند.
8. با حلقهٔ واقعیِ `createSweepLoop` (زمانِ مجازی): شکلِ `status` همیشه پذیرفته می‌شود؛ چرخهٔ شکست ⇒ بهبود؛ `stop`/`start`؛ `stalled`.
9. `sweepHealthHttpStatus`: down ⇒ ۵۰۳؛ ok/degraded ⇒ ۲۰۰؛ نتیجهٔ خراب ⇒ ۵۰۳.
10. فقط `purity.test.ts` از آزمون‌های موجود عوض شود (`Test-Change-Approved`)؛ دروازهٔ صفر-رد سبز؛ کفِ دروازه بالا برود؛ جهشی بی‌زندهٔ توضیح‌نشده.

## تست‌های مورد انتظار
عادی (جدولِ قاعده‌ها)، مرزی (±۱ در هر آستانه، `grace=۲`، سقف، `sinceMs`)، خطا (نامعتبر، getterِ بدجنس، Proxy)، خاصیتی با مرجعِ مستقل، یکنوایی، آشوب (۱۰۰۰ ورودی)، یکپارچگی با حلقهٔ واقعی، جهشی.

## خارج از کار
تایمرِ واقعی، singletonِ فرایند، استخر، `/api/health`، `deliver`ِ واقعی، پایشِ پسماندِ زنگِ ماندگار، `status` در registry.

## وابستگی‌ها
ADR-0023/0026/0027/0029؛ تحویل ۰۰۲۹.

## بازبینی و ریسک
**بله.** پول (`settlement`). تگ `pre-risk/20261119-sweep-health` روی HEAD سبز پیش از اولین ویرایش زده شد؛ کامیت‌های کد `Risk-Tag` دارند. بازبین: مالک معماری + مالک امنیت/مالی.
