# settlement م۳‑د‑۳الف: `recordFailure` تکرارپذیر (`expectedAttempts`)

## هدف (یک جمله)
شمارندهٔ `attempts` (که سقفِ مرگِ مالیِ رکورد را تعیین می‌کند) را در برابر دو رفتگرِ هم‌زمان و تلاشِ دوبارهٔ پس از قطعِ مبهم، تکرارپذیر (compare-and-set) کند — بی‌مهاجرت و بی‌تغییرِ رفتارِ پیشین.

## زمینه
تحویل ۰۰۲۴ مشاهدهٔ ۶‑۱ و تحویل ۰۰۲۷ «گام بعد ۱». ADR-0028 تصمیم‌ها را ثبت کرده است.

## ماژول و پوشه‌های مجاز
`src/modules/settlement/` فقط: `types.ts`، `validate.ts`، `memory-outbox.ts`، `pg/store.ts`، `sweeper.ts`، `index.ts` (صادرکردنِ نوعِ تازه)، `README.md`، و فایل‌های **جدید**: `contract/failure-cas-contract.ts`، `memory-failure-cas.test.ts`، `pg/failure-cas.pg.test.ts`، `pg/failure-cas.unit.test.ts`، `sweeper.failure-cas.test.ts`، `tooling/mutation/settlement-failure-cas.py`. بعلاوه `docs/`، `tooling/ci-tests.ts` (فقط کفِ دروازه؛ کامیتِ جدا).

## ممنوع
مهاجرتِ تازه؛ تغییرِ هر آزمونِ موجود؛ تغییرِ `outbox-contract.ts`؛ تغییرِ `SweepReport`/`SweepLoop`؛ تغییرِ SQLِ مسیرِ بی‌`expectedAttempts`؛ ماژولی جز `settlement`؛ وابستگیِ تازه.

## قرارداد
افزایشی و اختیاری: فیلدِ `expectedAttempts` در ورودیِ `recordFailure` و فیلدِ `replayed` (فقط در مسیرِ CAS) در نتیجه. نوع‌های `FailureInput`/`FailureRecorded` صادر می‌شوند.

## معیار پذیرش
1. بی‌`expectedAttempts`: نتیجه دقیقاً `{attempts}` و SQL/رفتار بی‌تغییر (آزمون‌های موجود، از جمله «۲۵ recordFailure هم‌زمان ⇒ ۲۵»).
2. `attempts === n` ⇒ ثبت و `replayed:false`؛ `attempts > n` ⇒ بی‌نوشتن و `replayed:true`؛ `attempts < n` ⇒ `CONFLICT` بی‌نوشتن.
3. ترتیبِ خطاها: ورودیِ نامعتبر ⇒ `INVALID_INPUT` (بی‌تماس با پایگاه)؛ بی‌رکورد ⇒ `NOT_FOUND`؛ نهایی ⇒ `NOT_ACTIVE` (پیش از مقایسه).
4. **هم‌زمانی واقعی (PostgreSQL):** N فراخوانِ هم‌زمان با همان `expectedAttempts` ⇒ دقیقاً یکی `replayed:false`، بقیه `replayed:true`، `attempts` نهایی = n+1.
5. حافظه‌ای و PostgreSQL یک قرارداد را بی‌تغییر می‌گذرانند؛ آزمونِ تفاضلی و خاصیتی.
6. رفتگر: دو رفتگرِ هم‌زمان روی یک رکوردِ دارای شکستِ گذرا ⇒ `attempts` فقط +۱ و یکی از آن‌ها `raced` می‌شود؛ رکورد زودتر از `maxAttempts` نمی‌میرد. با یک رفتگر هیچ تغییری.
7. هیچ آزمونِ موجودی تغییر نکند؛ دروازهٔ صفر-رد سبز؛ کفِ دروازه بالا برود؛ آزمونِ جهشی بی‌زندهٔ توضیح‌نشده.

## تست‌های مورد انتظار
عادی (تلاشِ اول، تکرار)، مرزی (`n=0`، `undefined`)، خطا (نامعتبر، نبودن، نهایی، آینده)، هم‌زمانی، تفاضلی، ساختارِ SQL (بی‌داده در متن، یک تراکنش)، و سناریوی دو رفتگر.

## خارج از کار
lease/`SKIP LOCKED` (م۳‑د‑۳ب)، ریشهٔ ترکیب، `status` در registry.

## وابستگی‌ها
ADR-0021/0022/0023/0027؛ تحویل ۰۰۲۷.

## بازبینی و ریسک
**بله.** پول (`settlement`). تگ `pre-risk/20261119-recordfailure-cas` روی HEAD سبز پیش از اولین ویرایش زده شد؛ کامیت‌های کد `Risk-Tag` دارند. بازبین: مالک معماری + مالک امنیت/مالی.
