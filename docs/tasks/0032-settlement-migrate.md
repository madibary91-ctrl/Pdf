# settlement‑migrate م۳‑ه‑۳‑ج: CLIِ رسمیِ مهاجرتِ زمانِ استقرار

## هدف (یک جمله)
مهاجرتِ صریحِ شِماهای دفتر و outbox را با دستورِ `status`/`up`، ورودیِ شکست‌بسته، کدهای خروجِ بسته، گزارشِ JSONِ بی‌نشت، هم‌زمانیِ بی‌خطر و مهلتِ کل به یک ابزارِ آزموده و قابل‌استقرار تبدیل کند، بی‌آنکه هیچ ماژولِ یا آزمونِ موجودی تغییر کند.

## زمینه
ADR-0022 (`start` مهاجرت نمی‌کند)، ADR-0033 «گام بعد ۱» و تحویل ۰۰۳۳؛ ADR-0034.

## ماژول و پوشه‌های مجاز
`src/modules/settlement-migrate/` (جدید)، `tooling/cli/` (گلو و حلقهٔ resolve، جدید)، `package.json` (فقط یک اسکریپتِ `settlement:migrate`)، `src/modules/registry.ts` (یک ردیف)، `tooling/git-discipline.ts` (`HIGH_RISK_MODULES` و regexِ `tooling/cli/`)، `tooling/ci-tests.ts` (کف)، `tooling/mutation/settlement-migrate.py`، `tooling/smoke/settlement-next.mjs` (استفاده از CLIِ رسمی) و `tooling/smoke/settlement-migrate.ts` (فقط یادداشتِ منسوخ)، آزمون‌های جدیدِ `tooling/*.test.ts`، `docs/`.

## ممنوع
تغییرِ هر ماژولِ موجود (`ledger`، `settlement`، `settlement-runtime`، `settlement-host`، `settlement-bootstrap`، `metering`)، `src/db`، `next.config.ts`، `src/app/**` و **هر آزمونِ موجود** (بدون `Test-Change-Approved`). وابستگیِ تازه به `package.json`. `.env` خواندن. فلگِ شِما. مهاجرت در بوت. SQL خام در ماژول.

## قرارداد
افزایشی: `runSettlementMigrate({argv, env, ports})`، `parseMigrateArgs(argv, env)`، `MIGRATE_EXIT`، `SETTLEMENT_MIGRATE_USAGE` و نوع‌ها. دستور: `npm run settlement:migrate -- <status|up> [--timeout-ms=N]`. env: `DATABASE_URL`، `SETTLEMENT_LEDGER_SCHEMA`، `SETTLEMENT_OUTBOX_SCHEMA`.

## معیار پذیرش
1. آرگومان/env: جدولی + خاصیتیِ ۲۰۰۰ نمونه + بدجنس (Proxy/getter)؛ بی‌نشتِ مقدار؛ آرگومانِ موضعی هرگز پژواک نمی‌شود؛ غلط‌یابِ نام؛ شِماها فقط از env و هم‌معنا با bootstrap (آزمونِ tooling).
2. `status`: فقط‌خواندنی (صفر تراکنشِ نوشتنی، شِمایی ساخته نمی‌شود)؛ هر دو فروشگاه همیشه خوانده می‌شوند؛ ۰/۳/۴/۵/۱ درست.
3. `up`: ترتیبِ دفتر ← outbox؛ check پیش از هر نوشتن (ناهمخوانی/در دسترس‌نبودن ⇒ صفر مهاجرت)؛ بی‌معلق ⇒ صفر نوشتن؛ verify پس از اعمال؛ شکستِ نیمه‌کار با `stage`/`appliedNow`/`pgCode` و تکرارِ امن.
4. هم‌زمانی: دو `up` هم‌زمان (۸ دور، PostgreSQL واقعی و فرایندِ واقعی) همه ۰ و هر مهاجرت یک بار؛ بازتلاشِ کران‌دار فقط برای SQLSTATEهای مجاز.
5. مهلت: آویزان‌شدن در check/apply/verify ⇒ ۷؛ پس از مهلت هیچ فراخوانیِ تازه؛ بستنِ کران‌دار؛ اتصالِ دیرِ باز‌شده بسته می‌شود؛ فرایندِ واقعی: پایانِ سخت، بی‌اعمال، SIGTERM.
6. نشت: هیچ‌جا رشتهٔ اتصال/رمز/میزبان (قناری) در stdout/stderr؛ stderr خالی.
7. همارزی با برنامه: `status` ≡ پیش‌بازرسیِ runtime؛ `up` ≡ `runtime.migrate()`؛ پس از `up` بوتِ runtime موفق.
8. گلو: اسکریپتِ `package.json` قفل؛ وابستگیِ تازه نیست؛ حلقهٔ resolve قواعدِ بازنویسی (و نبودِ بازنویسیِ بیش‌ازحد) آزموده.
9. نگهبانِ منبع؛ جهشی بی‌زندهٔ توضیح‌نشده؛ دروازهٔ صفر-رد سبز و کف بالا؛ هیچ آزمونِ موجودی تغییر نکند.

## تست‌های مورد انتظار
جدولی، خاصیتی، بدجنس، ترتیب/بی‌نوشتن، مسابقهٔ هم‌زمانی، مهلت/لغو، PostgreSQL واقعی، فرایندِ واقعی، همارزی (tooling)، نگهبانِ منبع، جهشی.

## خارج از کار
اصلاحِ ریشهٔ `CREATE SCHEMA IF NOT EXISTS` در `ledger`/`settlement`، حذفِ `tooling/smoke/settlement-migrate.ts` و به‌روزکردنِ README/ADRهای قدیمی که به آن اشاره دارند، ابزارِ تعمیرِ دفتر، مهاجرتِ شِماهای آینده (دفترِ محصول)، Dockerfile/`start` (`NEXT_MANUAL_SIG_HANDLE`)، `deliver` (م۳‑ه‑۴)، خواندنِ `.env`.

## وابستگی‌ها
ADR-0022/0031/0033؛ تحویل ۰۰۳۳.

## بازبینی و ریسک
**بله.** پایگاهِ پول + registry + فرایند. تگ `pre-risk/20261119-settlement-migrate` روی HEAD سبز (۳۹۴۲ تست) پیش از اولین ویرایش؛ کامیت‌های کد `Risk-Tag` دارند.
