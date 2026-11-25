# 0067 — `tool-policy-store-pg`: آداپتور PostgreSQL نسخه‌های سیاستِ ابزار (CT‑5c‑2b‑2)

## هدف (یک جمله)
پورتِ `PolicyVersionStore` روی PostgreSQL پیاده شود به‌طوری که «فقط‌افزودنی و بی‌شکاف» را خودِ پایگاه اجرا کند و همان آزمونِ قراردادِ ذخیره‌سازِ حافظه‌ای را بگذراند.

## زمینه
ADR‑0069 (2b‑2)؛ ADR‑0070؛ الگوی `settlement/pg` (مهاجرت، سپرِ همخوانی، نگاشتِ خطا).

## ماژول و پوشه‌های مجاز
`src/modules/tool-policy-store-pg/` (تازه)، `src/modules/tool-policy-admin/index.ts` (فقط افزودنِ یک صادرات؛ کامیتِ جدا) + آزمونِ آن، `src/modules/registry.ts` (یک سطر)، `tooling/git-discipline.ts` (`HIGH_RISK_MODULES`)، `docs/high-risk-areas.md`، `docs/known-pitfalls.md`، `tooling/ci-tests.ts` (فقط `MIN_PASSED_TESTS`)، `tooling/tool-policy-store-pg-*.test.ts`، `tooling/mutation/tool-policy-store-pg.py`، ADR/task/handoff.

## ممنوع
هر آزمونِ موجود (به‌ویژه `schema-ensure-key-parity`)، `CREATE SCHEMA` در کدِ تولید، وابستگیِ تازه، `process.env`/رشتهٔ اتصال/ساعت/تصادف در ماژول، تغییرِ رفتارِ `tool-policy-admin`، `src/db/schema.ts`، قیمت/ارز/حساب/کلید، نام یا عددِ فیلدهای سیاست.

## قرارداد
بی‌تغییر؛ فقط یک صادراتِ افزودهٔ `parsePolicyRecord` از `tool-policy-admin`.

## معیار پذیرش
۱) `describePolicyStoreContract` روی PG سبز؛ ۲) UPDATE/DELETE/TRUNCATE/شکاف/تکرار با `psql` هم رد (تریگر)؛ ۳) قیدهای CHECK هم‌ارزِ مرزِ رکورد؛ ۴) مسابقه: دقیقاً یک برنده، زنجیرهٔ بی‌شکاف؛ ۵) ردیفِ خراب (از جمله `__proto__`) بسته می‌شکند؛ ۶) مهلتِ سمتِ پایگاه و بی‌نشت به اتصالِ استخر؛ ۷) migrate idempotent، هم‌زمان‌امن، checksum/ناشناخته/حفره؛ شِما ساخته نمی‌شود؛ ۸) نگهبانِ نوشتن (تریگرِ خاموش/حذف‌شده، replica)؛ ۹) `status` مشکل‌ها را می‌گوید؛ ۱۰) نشتِ متنِ خطا/رمز نیست؛ ۱۱) ادمینِ واقعی روی PG (دو نمونه، ریستارت)؛ ۱۲) جهش‌آزمایی همه کشته (یا هم‌ارزِ مستند)؛ ۱۳) هیچ آزمونِ موجود تغییر نکند.

## خارج از کار
CLIِ مهاجرت/بوت‌استرپ (2c)، HTTP/UI (2b‑3)، `identity`.

## وابستگی‌ها
ADR‑0069/0070.
