# م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۲‑۳: اصلاحِ ریشه‌ایِ `to_regclass`ِ کهنه در `settlement-pending`

## هدف (یک جمله)
وجود‌سنجیِ رابطه در `settlement-pending/migrate.ts` را از کشِ کاتالوگِ کهنهٔ اتصالِ گرم مستقل کند (هر دو جهت) — بی‌تغییرِ هیچ آزمونِ موجود.

## زمینه
مورد باز بند ۶‑۱ تحویل ۰۰۴۹؛ ADR-0049 تصمیم ۳؛ گامِ بعدیِ اعلام‌شده در تحویل ۰۰۴۹ (پیش از bootstrap).

## ماژول و پوشه‌های مجاز
`src/modules/settlement-pending/migrate.ts` (و آزمون‌های تازهٔ `regclass.*.test.ts`)، `tooling/mutation/settlement-pending-regclass.py`، `tooling/ci-tests.ts` (فقط کفِ شمار)، `docs/`، `settlement-pending/README.md`.

## ممنوع
هر آزمونِ موجود، فایلِ منبعِ تازه، تغییرِ `index.ts`/`types.ts`/مهاجرت‌ها/`ROLLBACKS`، `settlement-pending-migrate/**` (حتی توضیح)، ماژول‌های دیگر با همین الگو، `vitest.config.ts` برای `ERR_IPC_CHANNEL_CLOSED`، سیم‌کشیِ bootstrap.

## قرارداد
همهٔ وجود‌سنجی‌ها از `relationExists` (`EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = to_regclass($n))`)؛ یک دستور برای هر بررسی، همان نامِ ستون‌ها و ترتیبِ پارامترها. هیچ تغییرِ رفتاری در حالتِ بی‌مسابقه.

## معیار پذیرش
1. آزمون‌های موجود بدونِ تغییر سبزند؛ `Test-Change-Approved` لازم نیست.
2. روی اتصالِ گرم: `down()` پس از برگشتِ هم‌زمانِ دیگری ⇒ `ok`/`reverted: []`؛ پس از نصبِ هم‌زمانِ دیگری ⇒ نصب را برمی‌دارد (نه بی‌کارِ دروغ)؛ `migrate()` با جدول‌های settlement حذف‌شده ⇒ پیامِ شفافِ پیش‌نیاز.
3. آزمون‌های بند ۲ پیش از رفع قرمز، پس از رفع سبز؛ کنترل منفی نشان می‌دهد `to_regclass`ِ خام کهنه می‌شود.
4. نگهبانِ منبع: فقط یک `to_regclass(` در کدِ محصولِ ماژول.
5. آزمونِ جهشی: هیچ جهشِ زنده.

## خارج از کار
ماژول‌های دیگر؛ ویرایشِ توضیحِ `execute.ts`؛ bootstrap (ب‑۲‑۳)؛ `backlog:cost` (ب‑۲‑۴)؛ متنِ پیام‌های قفل‌شده.

## وابستگی‌ها
ADR-0046، ADR-0048، ADR-0049، تحویل ۰۰۴۹.

## بازبینی و ریسک
ناحیهٔ پرریسک (پول): بازبینیِ انسانیِ `settlement-pending/migrate.ts`. تگِ پیش‌ازریسک: `pre-risk/20261122-pending-regclass-fix`.
