# tool-policy-grants — حقوقِ نقشِ زمانِ اجرای سیاستِ ابزار با کمترین امتیاز

## هدف (یک جمله)
مستند، اجراشدنی و آزمودنیِ «نقشِ زمانِ اجرا دقیقاً چه حقی دارد» برای شِمای نسخه‌های سیاستِ ابزار (`plan`/`verify`/`apply` با کدهای خروجِ بسته).

## زمینه
ADR-0080 / handoff 0079 «حقوقِ نقشِ زمانِ اجرا» را باز گذاشتند. بدونِ آن، لایهٔ دومِ «فقط‌افزودنی» (نبودنِ حقِ `UPDATE/DELETE/TRUNCATE`) اجرا نمی‌شد و استقرار حدسی بود. ADR-0081 (این برش).

## ماژول و پوشه‌های مجاز
`src/modules/tool-policy-grants/` (تازه)، `tooling/cli/tool-policy-grants.ts` و `tooling/cli/grants-pg.ts`، `tooling/tool-policy-grants-*.test.ts`، `tooling/mutation/tool-policy-grants.py`، `src/modules/registry.ts` (یک مدخل)، `tooling/git-discipline.ts` (فقط فهرستِ `HIGH_RISK_MODULES`)، `docs/` و `AGENTS.md`، `package.json` (فقط اسکریپتِ `policy:grants`)، و (کامیتِ جدا، `Risk-Tag`) فقط `MIN_PASSED_TESTS`.

## ممنوع
تغییرِ `tool-policy-store-pg`، `tool-policy-migrate` و هر ماژولِ موجود، `shared-types`، **هر تستِ موجود** (فقط افزودن)، وابستگیِ تازه، ساختنِ نقش/رمز، `CREATE SCHEMA` در `src/`، خواندن/چاپِ مقدارِ `DATABASE_URL`، حقِ بیش از قرارداد، تغییر برای سه محدودیتِ محیطیِ ویندوز.

## قرارداد
`runToolPolicyGrants({argv, env, ports:{open, query, transact, timer, write}}) → {exitCode, report}` (هرگز نمی‌پرتابد)، `parseGrantsArgs`، `planStatements`، `GRANTS_EXIT` (۰..۸)، `RUNTIME_CONTRACT`. فرمان‌ها: `plan|verify|apply --role=NAME [--timeout-ms=N]`. env: `DATABASE_URL` (جز plan)، `TOOL_POLICY_SCHEMA`.

## معیار پذیرش
1. قرارداد با نقشِ بی‌امتیازِ واقعی هم **کافی** (ذخیره‌سازِ واقعی) و هم **لازم** (حذفِ هر حق ⇒ شکست) ثابت شده است.
2. `verify` هرگز نمی‌نویسد؛ حقِ کم و حقِ زیاد (شِما، هر دو جدول، رابطهٔ ناشناخته، PUBLIC، عضویت) ⇒ ۵.
3. `apply`: پیش‌بازرسی (نقش، شِما، جدول‌ها) بی‌نوشتن؛ همگرا و idempotent؛ خواندنِ دوباره؛ حقِ ناحذف‌شدنی ⇒ ۶؛ مهلت ⇒ ۷ بی‌اعمال.
4. نقشِ ناموجود/خطرناک/مالک ⇒ ۸ بی‌نوشتن؛ شِما/جدولِ ناموجود ⇒ ۳.
5. هیچ مقدارِ محیط/رشتهٔ اتصال/متنِ خطا در گزارش نیست؛ env همارزِ migrate/bootstrap.
6. فقط‌افزودن: هیچ تستِ موجودی تغییر نمی‌کند؛ ماژول در registry و فهرستِ پرریسک.

## تست‌های مورد انتظار
واحد (آرگومان/env، طرح، سنجش، دنیای ساختگی، زمان‌سنجِ مجازی)، نگهبانِ منبع، همارزی (ذخیره‌ساز/migrate)، PostgreSQL واقعیِ درون‌فرایندی و فرایندیِ واقعی، و جهشی.

## خارج از کار
نقش‌ساختن/رمز، `MAINTAIN` (PG ≥ ۱۷)، `ALTER DEFAULT PRIVILEGES`، حقوقِ سطحِ پایگاه، استخراجِ مشترکِ `deadline`/`lazy-database`، دودیِ `next start`.
