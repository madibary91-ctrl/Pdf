# یادداشت تحویل ۰۰۲۸ — settlement م۳‑د‑۳الف: `recordFailure` تکرارپذیر (`expectedAttempts`)

**کامیت پایه:** `f7ef21d` (شاخهٔ `main`؛ تحویل ۰۰۲۷، ۲۸۱۳ تست). مخزن: `madibary91-ctrl/Pdf`. کلون تازه، نصبِ وابستگی‌ها و `node tooling/git-discipline.ts install` انجام شد. به مخزن پوش **نکرده‌ام** (پچ و bundle در Gofile؛ پیوند در پاسخ تحویل).

## ۱) چرا این برش (تصمیم من)
تحویل ۰۰۲۷ «گام بعد» را `م۳‑د‑۳` گذاشت و گفت: نخست `recordFailure` تکرارپذیر (کوچک‌تر، بی‌مهاجرت)، سپس lease/`SKIP LOCKED` (مهاجرت `0003`). م۳‑د‑۳ را به دو برش شکستم و **فقط الف** را ساختم:
- `attempts` سقفِ مرگِ مالیِ رکورد را تعیین می‌کند (`ATTEMPTS_EXHAUSTED` = رسیدگی انسانی/مالی). دو رفتگرِ هم‌زمان یا تلاشِ دوباره پس از قطعِ مبهمِ بعد از commit، **یک** شکستِ منطقی را **دو** بار می‌شمردند و رکورد زودتر از سقف می‌مرد و `due_at_ms` بازنویسی می‌شد.
- این کوچک‌ترین گامِ معنادار است: بی‌مهاجرت، افزایشی، بازگشت‌پذیر، و حالا که `settlement` ناحیهٔ پرریسکِ ماشین‌خوان است (ADR-0027) همین برش نخستین کاری است که با `Risk-Tag` پیش می‌رود (حفاظِ ۰۰۲۷ در عمل آزموده شد: هوکِ `commit-msg` کامیت‌های کد را بدون `Risk-Tag` رد می‌کرد).
- lease/`SKIP LOCKED` (برش ب) عمداً **بیرون** ماند: مهاجرتِ SQL است و باید جدا، با مسیرِ ارتقا و آزمونِ چندفرایندی بیاید.

## ۲) چه ساخته شد
- **قرارداد (افزایشی):** `recordFailure(ref, { errorCode, dueAtMs, expectedAttempts? })`. بی‌`expectedAttempts`: رفتار و SQLِ پیشین بی‌تغییر. با آن، زیرِ قفلِ ردیف: `attempts === n` ⇒ ثبت و `{attempts:n+1, replayed:false}`؛ `> n` ⇒ **بی‌نوشتن** و `{attempts:<فعلی>, replayed:true}`؛ `< n` ⇒ `CONFLICT`؛ نبودن ⇒ `NOT_FOUND`؛ نهایی ⇒ `NOT_ACTIVE` (پیش از مقایسه)؛ نامعتبر ⇒ `INVALID_INPUT` بی‌تماس با پایگاه (`undefined` ≡ نبودن). نوع‌های تازهٔ `FailureInput`/`FailureRecorded` از `index.ts` صادر می‌شوند.
- **`memory-outbox.ts`، `pg/store.ts`، `validate.ts`، `types.ts`:** پیاده‌سازی. PostgreSQL مقایسه را زیرِ `FOR UPDATE` انجام می‌دهد و **همان UPDATE** پیشین را به کار می‌برد (بی‌مهاجرت؛ متنِ SQL در دو مسیر یکی است و آزموده شد).
- **`sweeper.ts`:** همیشه `expectedAttempts: e.attempts` می‌فرستد؛ `replayed:true` ⇒ `raced` (نه `retryLater`)؛ `CONFLICT` ⇒ `outboxFailures`. ارزشِ خرابِ پورت بی‌پرتاب خوانده می‌شود. `SweepReport`/`SweepLoop` بی‌تغییر.
- **آزمون‌های تازه (۱۲۴):** `contract/failure-cas-contract.ts` (۱۸ مورد؛ روی حافظه‌ای و PostgreSQL بی‌تغییر) · `memory-failure-cas.test.ts` (۴۸؛ خاصیتی ۳۰ بذر × ۲۵۰ گام در برابر مدلِ مرجع) · `pg/failure-cas.unit.test.ts` (۲۱ بی‌پایگاه: مرز، getterِ بدجنس، شکلِ SQL، خرابی) · `pg/failure-cas.pg.test.ts` (۴۱: هم‌زمانیِ ۶ فرایندِ واقعی با ۳۰ فراخوان، ۱۰ رکورد × ۶، رقابت با `bury` ۴۰ دور، ۲۵ فراخوانِ بی‌expected هنوز ۲۵، ریستارت، تفاضلیِ ۱۶ بذر) · `sweeper.failure-cas.test.ts` (۱۴: دو و شش رفتگرِ هم‌زمان، مرگ فقط در دورِ سقف، عکسِ کهنه، پورتِ قدیمی/خراب/پرتابنده).
- `tooling/mutation/settlement-failure-cas.py`: ۳۸ جهش.
- مستندات: ADR-0028، task 0026، README ماژول (بندِ «محدودیتِ `recordFailure` تکرارپذیر نیست» اصلاح شد).

## ۳) تغییر در تست‌های موجود — **هیچ**
`git diff --name-status f7ef21d..HEAD -- '*.test.ts'`: فقط `A`. `outbox-contract.ts` و همهٔ آزمون‌های موجود دست‌نخورده؛ `Test-Change-Approved` لازم نبود. آزمونِ «۲۵ recordFailure هم‌زمان ⇒ ۲۵» (مسیرِ بی‌expected) و آزمونِ کلیدهای دقیقِ پورت (`Object.keys`) بی‌تغییر سبز ماندند. `registry.ts` و هر ماژولِ دیگر تغییر نکرد (G7: فقط `settlement`).

## ۴) راستی‌آزمایی (PostgreSQL ۱۵ واقعی، Node 22.23)
- دروازهٔ صفر-رد: **۲۹۳۷ سبز، ۰ رد، ۰ شکست، ۱۶ todo** (۲۸۱۳ + ۱۲۴). `tsc`، `eslint .`، `npm run build` سبز. کفِ `MIN_PASSED_TESTS`: ۲۸۱۳ ← ۲۹۳۷ (کامیتِ جدا با `Risk-Tag`). `check-range f7ef21d..HEAD` سبز.
- **جهشی:** `python3 tooling/mutation/settlement-failure-cas.py` — ۳۸ جهش، **۳۷ کشته + ۱ هم‌ارزِ مستند، زندهٔ توضیح‌نشده ۰.** جهشِ [۳۵] (حذفِ حفاظِ نوعِ ارزشِ پورت در رفتگر) هم‌ارز است: بدونِ آن `undefined.replayed` پرتاب می‌شود و `catch`ِ بیرونیِ `settleEntry` (خطای برنامه‌نویسی ⇒ `retry`) همان نتیجه را می‌دهد؛ اول زنده ماند و با بررسیِ مستقیم (لاگِ مقدارِ دریافتی) ثابت شد آزمون ضعیف نیست. جهش‌های کلیدی کشته شدند، از جمله «CAS بی‌قفلِ ردیف» (فقط آزمونِ چندفرایندیِ واقعی می‌گیرد) و «حالتِ کهنه دوباره می‌شمارد» (خودِ باگ).
- یک ضعفِ آزمونِ خودم را حین کار دیدم و اصلاح کردم: سناریوی «رقیب میانِ خواندن و ثبت» نخست پیش از `resolveClose` رقیب را وارد می‌کرد، ولی `resolveClose` عکس را تازه می‌کند ⇒ پنجرهٔ واقعیِ مسابقه **هنگامِ تماس با دفتر** است؛ آزمون به همان‌جا منتقل شد.
- **G13:** پچ‌ها روی **کلون تازهٔ `f7ef21d`** با `git am` اعمال و دروازهٔ کامل (+ `tsc`، `eslint`، `build`) روی نتیجه سبز شد (جزئیات در پاسخ تحویل؛ درختِ نتیجه با درختِ من یکی).

## ۵) انحراف‌ها و نکته‌ها (برای بازبینی)
1. **ساخت و اجرای محلی:** مخزن `pnpm` می‌خواهد؛ در این محیط pnpm نبود و وابستگی‌ها را با `npm install --no-package-lock` نصب کردم (همان نسخه‌های `package.json`). `pnpm-lock.yaml` دست نخورد؛ اگر تفاوتی در حلِ وابستگی‌ها مشکوک است، در CI با pnpm هم تأیید شود.
2. **`replayed` فقط در مسیرِ CAS می‌آید** (تا `toEqual({attempts})` آزمون‌های موجود نشکند). این یک نابرابریِ ظریفِ شکلِ نتیجه است؛ در ADR-0028 توجیه شد.
3. **`bury` تکراری** در دو رفتگرِ هم‌زمان هنوز برای هر دو `buried` گزارش می‌دهد (چون `bury` idempotent و `replayed` است). این **پیش از** این برش هم بود، با ack ماندگارِ ADR-0025/0026 زنگِ ماندگار تکراری نمی‌شود، ولی `onBuried`ِ درون‌حافظه‌ای ممکن است دو بار صدا بخورد. در برش ب بررسی می‌شود.
4. بازبینیِ انسانیِ مالک معماری و امنیت/مالی انجام نشده است (`settlement` ناحیهٔ پرریسک است).

## محدودیت‌های صادقانه
- فقط **شمارنده** تکرارپذیر شد. دو رفتگر هنوز می‌توانند `charge`/`close`ِ تکراری (idempotent و بی‌ضرر) روی دفتر بزنند؛ حذفِ کارِ تکراری نیازمندِ lease است.
- ریشهٔ ترکیب (تایمرِ واقعی، `/api/health` با `status().deadLetters`، تنظیمِ استخر، `deliver`ِ واقعی) و `status`ِ ناهمخوانِ registry (۰۰۲۷ بند ۳) دست نخورده است.
- فقط لینوکس + PostgreSQL ۱۵. CI گیت‌هاب را نمی‌بینم؛ تگِ `green/<slug>` (G9) را نزدم.

## تأیید لازم از شما
۱) **معماری/مالی:** ADR-0028 تصمیم ۱ (فیلدِ اختیاریِ CAS به‌جای متدِ تازه/توکن) و تصمیم ۳ (`replayed` ⇒ `raced`، `CONFLICT` ⇒ `outboxFailures`).

## گام بعد (پیشنهاد)
۱) **م۳‑د‑۳ب:** lease/`SKIP LOCKED` (مهاجرت `0003`، با مسیرِ ارتقا از 0002، آزمونِ چندفرایندی، `Risk-Tag`). ۲) ریشهٔ ترکیب (تایمر، `/api/health`، استخر، `deliver`). ۳) سپس م۲ (هویت) و م۴ (خرید).

## پچ‌ها
`git format-patch -N f7ef21d..HEAD` (چهار پچ؛ چهارمی همین یادداشت) + bundle (تگ `pre-risk/20261119-recordfailure-cas`) در Gofile (`SHA256SUMS` کنار پچ‌ها). SHA-256 سه پچ نخست (شماره‌گذاریِ «n/4»؛ پچِ چهارم همین یادداشت است و SHA آن در `SHA256SUMS` کنار پچ‌ها در Gofile است):
```
67d6d396fc2d9243200acbf67019bb0e1362b18a3217ef7d126c1ae9ed5a566a  0001-docs-settlement-ADR-0028-and-task-0026-for-the-idemp.patch
11bd081209170e148a217fa852555068ff69ab681c314bba8eeec847cf692361  0002-feat-settlement-make-recordFailure-idempotent-with-a.patch
66bf8554a5a9e83b2140db9fc924836a18a584c07eb4ebe036513f9d2623a5a0  0003-chore-ci-raise-MIN_PASSED_TESTS-from-2813-to-2937.patch
```
اعمال: `git clone https://github.com/madibary91-ctrl/Pdf && cd Pdf && git checkout f7ef21d && git tag -a pre-risk/20261119-recordfailure-cas -m "…" && git am /path/000*.patch`، یا `git pull <bundle> main`. `git am` هوک‌ها را اجرا نمی‌کند.
