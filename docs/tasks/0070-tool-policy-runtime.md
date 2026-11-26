# 0070 — `tool-policy-runtime`: ریشهٔ I/Oِ سیاستِ ابزار (CT‑5c‑2c‑2b‑1)

## هدف (یک جمله)
زنجیرهٔ ذخیره‌ساز PG ← مدیر ← منبع ← حلقه روی یک `db` و یک `tuning` ساخته شود و چرخهٔ عمرِ مرتب (پیش‌بازرسیِ فقط‌خواندنی، start/stop، سلامتِ همگام) بدهد، بی‌آنکه مهاجرت کند یا بنویسد.

## زمینه
ADR‑0070/0071/0072؛ ADR‑0073. 2c‑2b به دو برش شکسته شد: **2c‑2b‑1 (این)** ریشه؛ 2c‑2b‑2 سیم‌کشیِ `projection`/`requestId`/لاگِ رزرو؛ سپس 2c‑3 CLIِ مهاجرت.

## ماژول و پوشه‌های مجاز
`src/modules/tool-policy-runtime/` (تازه)، `src/modules/registry.ts` (یک سطر)، `tooling/git-discipline.ts` (`HIGH_RISK_MODULES`)، `docs/high-risk-areas.md`، `docs/known-pitfalls.md`، `tooling/ci-tests.ts` (فقط `MIN_PASSED_TESTS`)، `tooling/tool-policy-runtime-*.test.ts`، `tooling/tool-policy-runtime.pg.test.ts`، `tooling/mutation/tool-policy-runtime.py`، ADR/task/handoff.

## ممنوع
هر آزمونِ موجود، `test-db.ts`ِ تازه، `CREATE SCHEMA`/مهاجرت در ماژول، وابستگیِ npm تازه، `setTimeout`/`Date`/`process.env`/تصادف در ماژول، تغییرِ رفتارِ ماژول‌های زیرین، `src/db/schema.ts`، قیمت/ارز/حساب/کلید، نام یا عددِ فیلدهای سیاست.

## قرارداد
بی‌تغییر؛ فقط ماژولِ تازه با رابطِ `createPgToolPolicyRuntime` / `createToolPolicyRuntime`.

## معیار پذیرش
۱) یک `tuning` یک بار خوانده و به هر دو سمت داده شود؛ ۲) `statementTimeoutMs ≤ refreshTimeoutMs`؛ ۳) پیش‌بازرسی NOT_MIGRATED/SCHEMA_MISMATCH/UNAVAILABLE و حلقه راه نیفتد؛ ۴) هرگز مهاجرت/نوشتن؛ ۵) پیش‌بازرسی نگهبانِ مهلتِ پیش‌ازفراخوانی دارد؛ ۶) `stop` در میانهٔ `start` حلقه را راه نیندازد؛ stop idempotent و هم‌زمان‌ها یک وعده؛ ۷) `ready` فقط RUNNING ∧ حلقه running ∧ منبع FRESH؛ ۸) روی PostgreSQL واقعی: بارگذاریِ نسخهٔ ۰، نسخهٔ تازه، خرابی ← STALE ← بهبود، دو نمونه، statement_timeout، زمان‌سنجِ واقعی؛ ۹) بی‌نشت و بی‌استثنا؛ ۱۰) جهش‌آزمایی همه کشته؛ ۱۱) هیچ آزمونِ موجود تغییر نکند.

## تست‌های مورد انتظار
واحد (runtime/config/clock)، مدل‌محور، نگهبانِ منبع، PG واقعی.

## خارج از کار
`projection` به دروازه، `requestId`/لاگِ رزرو، CLI، HTTP/UI، singleton/SIGTERM، `identity`.

## وابستگی‌ها
ADR‑0070/0071/0072/0073.
