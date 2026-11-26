# 0073 — `tool-policy-bootstrap`: اتصالِ میزبانِ سیاستِ ابزار به برنامه (CT‑5c‑2c‑2b‑3b)

## هدف (یک جمله)
میزبانِ فرایندیِ سیاستِ ابزار را با گلوی نازکِ `instrumentation` و سه مسیرِ پروبِ HTTP به برنامه وصل کن، با سیاستِ env شکست‌بسته (خاموشِ پیش‌فرض، بی‌پیش‌فرضِ حدسی برای tuning) و بدونِ آن‌که دو میزبانِ فرایندی همدیگر را (استخر، خروج) خراب کنند.

## زمینه
ADR‑0075 / یادداشتِ ۰۰۷۴ «گام بعد» ۱؛ ADR‑0033 (الگو)؛ ADR‑0076.

## ماژول و پوشه‌های مجاز
`src/modules/tool-policy-bootstrap/` (ماژولِ تازه)، `src/modules/registry.ts` (یک سطر)، `src/instrumentation.ts` و `src/instrumentation-{policy,shared}.ts`، `src/instrumentation-node.ts` (فقط جایگزینیِ `openDatabase` و افزودنِ `exit`)، `src/db/pool-lease.ts`، `src/process-exit.ts`، `src/app/api/health/policy/**`، `tooling/` (`git-discipline.ts` فقط `HIGH_RISK_MODULES`، آزمونِ PG، اسکریپتِ جهش، `ci-tests.ts` فقط `MIN_PASSED_TESTS`)، `docs/`.

## ممنوع
هر آزمونِ موجود؛ دست‌زدن به `settlement-*`، `tool-policy-host`، `tool-policy-runtime`، `src/db/index.ts`؛ وابستگیِ npm تازه؛ مهاجرت؛ تغییرِ قرارداد؛ اتصالِ سیاست به دروازه.

## معیار پذیرش
۱) خاموشِ پیش‌فرض ⇒ هیچ پایگاه/میزبان/سیگنال؛ ۲) `on` بی‌هر پنج عددِ tuning ⇒ `INVALID_ENV`؛ ۳) شکستِ ساختار (پایگاه/ریشه/میزبان/ظرف) ⇒ اجارهٔ پایگاه با `release` پس داده می‌شود و استخرِ مشترک بسته نمی‌شود؛ ۴) بوت بی‌مسدودی و تک‌نمونه؛ ۵) `NOT_MIGRATED` بی‌بازتلاش و بی‌جدول؛ ۶) پروب‌های HTTP هرگز «نمی‌دانم» را ۲۰۰ نمی‌کنند؛ ۷) دو میزبان: `close` فقط آخرین اجاره‌دار، `exit` فقط آخرین نفر و با بیشینهٔ کد؛ ۸) آزمونِ موجودِ گلو دست‌نخورده سبز؛ ۹) جهش‌آزمایی بی‌بازمانده.

## تست‌های مورد انتظار
واحد (env/http/bootstrap/purity)، گلو (policy/shared/register)، اجاره و خروجِ هماهنگ (با دو میزبانِ واقعی)، مسیرها، PG واقعی (سالم، مهاجرت‌نشده، SIGTERM، استخرِ واقعی با دو اجاره‌دار و شکستِ بوت).

## خارج از کار
اتصال به دروازه (2b‑2)؛ CLIِ مهاجرت (2c‑3)؛ `connectionTimeoutMillis`؛ دودیِ `next start`.

## وابستگی‌ها
ADR‑0032/0033/0073/0075/0076.

## بازبینی و ریسک
ناحیهٔ پرریسک (پول): مالک امنیت — `env.ts`، `bootstrap.ts`، `http.ts`، `pool-lease.ts`، `process-exit.ts`.
