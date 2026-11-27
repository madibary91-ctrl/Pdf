# tool-policy-migrate — CLIِ مهاجرتِ شِمای سیاستِ ابزار با نقشِ مهاجرتِ جدا

## هدف (یک جمله)
فراهم‌کردنِ مسیرِ رسمیِ استقرار برای `status` و `up`ِ شِمای نسخه‌های سیاستِ ابزار (شِما، جدول‌ها، قید و تریگرِ فقط‌افزودنی) بدونِ اینکه برنامه DDL بزند.

## زمینه
2c‑3 در ADR‑0068..0078 (یادداشت‌های ۰۰۷۱–۰۰۷۸) معلق بود. `tool-policy-store-pg.migrate()` هست ولی شِما نمی‌سازد و بی‌سقف است؛ برنامه (`tool-policy-bootstrap`) هیچ DDL نمی‌زند. ADR‑0080 (این برش)، الگو: ADR‑0034 `settlement-migrate`.

## ماژول و پوشه‌های مجاز
`src/modules/tool-policy-migrate/` (تازه)، `tooling/cli/tool-policy-migrate.ts`، `tooling/tool-policy-migrate-parity.test.ts`، `tooling/mutation/tool-policy-migrate.py`، `src/modules/registry.ts` (یک مدخل)، `tooling/git-discipline.ts` (فقط فهرستِ `HIGH_RISK_MODULES`)، `docs/` و `AGENTS.md`، `package.json` (فقط اسکریپتِ `policy:migrate`)، و (کامیتِ جدا، `Risk-Tag`) فقط `MIN_PASSED_TESTS`.

## ممنوع
تغییرِ `tool-policy-store-pg` و هر ماژولِ موجود، `shared-types`، **هر تستِ موجود** (فقط افزودن)، وابستگیِ تازه، ساختنِ شِما بدونِ فلگِ صریح، خواندن/چاپِ مقدارِ `DATABASE_URL`، نوشتنِ `GRANT` از حافظه، تغییر برای سه محدودیتِ محیطیِ ویندوز.

## قرارداد
`runToolPolicyMigrate({argv, env, ports:{open, timer, write, createStore?}}) → {exitCode, report}` (هرگز نمی‌پرتابد)، `parseMigrateArgs`، `MIGRATE_EXIT` (۰..۸)، `TOOL_POLICY_MIGRATE_USAGE`. فرمان‌ها: `status`، `up [--create-schema] [--timeout-ms=N]`. env: `DATABASE_URL`، `TOOL_POLICY_SCHEMA`.

## معیار پذیرش
1. `status` هرگز نمی‌نویسد؛ آماده ⇒ ۰، معلق ⇒ ۳، ناهمخوان ⇒ ۵، پایگاهِ ناپیدا ⇒ ۴.
2. `up`: پیش‌بازرسیِ بی‌نوشتن؛ شِمای ناموجود بی‌فلگ ⇒ ۸؛ با فلگ ساخته و مهاجرت داده و دوباره خوانده می‌شود؛ آماده ⇒ بی‌نوشتن.
3. بازتلاشِ کران‌دار فقط برای SQLSTATEِ هم‌زمانی؛ چهار فرایندِ هم‌زمان ⇒ یک اعمال‌کننده.
4. مهلتِ کل و SIGTERM بی‌اعمال و بی‌اتصالِ آویزان؛ پایانِ فرایند صریح.
5. هیچ مقدارِ محیط/رشتهٔ اتصال/متنِ خطا در stdout/stderr نیست؛ env همارزِ bootstrap.
6. فقط‌افزودن: هیچ تستِ موجودی تغییر نمی‌کند؛ ماژول در registry و فهرستِ پرریسک.

## تست‌های مورد انتظار
واحد (آرگومان/env، فروشگاهِ ساختگی، زمان‌سنجِ مجازی)، نگهبانِ منبع، PostgreSQL واقعی درون‌فرایندی و فرایندِ واقعی، همارزیِ bootstrap (۲۰۰۰ بذر)، و جهشی.

## خارج از کار
حقوقِ نقشِ زمانِ اجرا (`GRANT`)، سقفِ زمانیِ `migrate()` در خودِ ذخیره‌ساز، استخراجِ مشترکِ `deadline`/`lazy-database`، مهاجرتِ دوم، دودیِ `next start`.
