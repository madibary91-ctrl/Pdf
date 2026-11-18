# settlement: برش م۳‑ب — outbox ماندگار روی PostgreSQL

## هدف (یک جمله)
پیاده‌سازیِ PostgreSQLِ پورت `SettlementOutbox` که همان `describeOutboxContract` را بی‌تغییر می‌گذراند و ماندگاری را با مرگِ واقعیِ فرایند ثابت می‌کند.

## زمینه
ADR-0021 («آنچه این برش نیست») و تحویل ۰۰۲۱ «گام بعد (پیشنهاد)». ADR-0022 تصمیم‌ها را ثبت کرده است.

## ماژول و پوشه‌های مجاز
`src/modules/settlement/pg/` (جدید)؛ `src/modules/settlement/index.ts` (فقط بازصادر)؛ `src/modules/settlement/purity.test.ts` (**فقط** دو ادعای ناگزیر، با `Test-Change-Approved`)؛ `src/modules/settlement/README.md`؛ `tooling/mutation/settlement-pg.py` (جدید)؛ `tooling/ci-tests.ts` (فقط بالا بردن کف، کامیت جدا، `Risk-Tag`)؛ `docs/`.

## ممنوع
تغییر `ledger`، `metering`، `ai-gateway`، `ai-orchestrator`، `shared-types`، `src/db/`، `registry.ts`؛ **تغییر یا حذف هر تستِ موجود جز دو ادعای بالا**؛ وابستگی خارجی تازه؛ ساعت سیستم/تصادف/محیط/تایمر در کد منبع؛ `now()` پایگاه در منطقِ تسویه؛ ذخیرهٔ متن پیام/پاسخ یا پیام خامِ خطای پایگاه در رکورد، پیام یا گزارش؛ حذف رکورد (حتی مرده).

## قرارداد
`createPgSettlementOutbox(db, { schema? })` ⇒ `PgStoreResult<PgSettlementOutbox>` که `SettlementOutbox` + `migrate()` + `status()` است؛ `SETTLEMENT_DEFAULT_SCHEMA = "settlement"`. `db` = `drizzle(pool)` از بیرون (ماژول اتصال نمی‌سازد).

## معیار پذیرش
1. `describeOutboxContract` بی‌تغییر روی PostgreSQL سبز.
2. تفاضلی با outbox حافظه‌ای، بی‌اختلاف.
3. مرگِ واقعیِ فرایند در سه نقطه (پیش از قصد، پس از قصدِ مصرف، پس از قصدِ بستن) ⇒ فرایندِ تازه با رفتگر می‌بندد؛ هزینه دقیقاً یک بار.
4. هم‌زمانیِ چندفرایندی: بی‌به‌روزرسانیِ گمشده، یک برنده، بی‌بن‌بست؛ مسابقهٔ رفتگر/درون‌خطی هرگز «مصرف + سوخت».
5. شکستِ پایگاه در هر دستور ⇒ `STORE_FAILURE` بی‌نشت و بی‌اثرِ نیمه.
6. قیدها و TRIGGERها مستقیم با SQL خام آزموده؛ مهاجرت idempotent/هم‌زمان‌امن/اتمی با سپر checksum.
7. جهشیِ بی‌زندهٔ توضیح‌نشده؛ هیچ تستِ موجودی ضعیف نشد؛ دروازهٔ صفر-رد سبز؛ کف `MIN_PASSED_TESTS` بالا رفت.
