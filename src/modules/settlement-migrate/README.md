# settlement-migrate

CLIِ رسمیِ مهاجرتِ زمانِ استقرارِ شِماهای تسویه (م۳‑ه‑۳‑ج، ADR-0034): **مهاجرتِ صریح و idempotentِ شِماهای دفتر (`ledger`) و outbox (`settlement`)** با ورودیِ شکست‌بسته، کدهای خروجِ بسته، گزارشِ JSONِ بی‌نشت، هم‌زمانیِ بی‌خطر و مهلتِ کل.
سیاستِ مهاجرت (SQL، checksum، قفل) در `ledger` و `settlement` می‌ماند؛ این ماژول فقط **ترتیب، پیش‌بازرسی، راستی‌آزمایی و گزارش** را دارد. به `process`، `pg`، drizzle، ساعتِ سیستم و `console` مستقیم وابسته نیست؛ همه تزریقی است (گلوی `tooling/cli/settlement-migrate.ts` آن‌ها را می‌دهد). `ledger` و `settlement` را فقط از رابطِ عمومی می‌شناسد.

## استفاده
```
DATABASE_URL=… npm run settlement:migrate -- status                 # فقط‌خواندنی؛ خروج ۳ اگر معلق باشد
DATABASE_URL=… npm run settlement:migrate -- up --timeout-ms=120000  # دفتر ← outbox؛ idempotent
```
شِماها فقط از env: `SETTLEMENT_LEDGER_SCHEMA` / `SETTLEMENT_OUTBOX_SCHEMA` (همان‌های برنامه؛ نبودن/خالی = پیش‌فرض). با `node --env-file=.env` هم می‌شود (CLI خودش `.env` نمی‌خواند). Node ≥ ۲۲٫۱۸.
الگوی استقرار: `up` (خروج ۰) ← سپس شروعِ برنامه با `SETTLEMENT_HOST=on`. در pipeline می‌شود پیش از انتشار `status` را دروازه کرد (خروج ۰ = همه اعمال‌شده).

```ts
const { exitCode, report } = await runSettlementMigrate({ argv, env, ports: { open, timer, write } });   // هرگز نمی‌پرتابد
```

## کدهای خروج
| کد | نام | معنا |
|---|---|---|
| ۰ | `OK` | `status`: همه اعمال‌اند · `up`: موفق یا کاری نبود |
| ۱ | `INTERNAL` | خطای برنامه‌نویسی/پورتِ خراب/شکلِ ناشناختهٔ پاسخِ فروشگاه (بسته: هرگز «خوب» نمی‌شود) |
| ۲ | `USAGE` | آرگومان یا env نامعتبر؛ **هیچ اتصالی ساخته نشد** |
| ۳ | `PENDING` | فقط `status`: مهاجرتِ معلق هست |
| ۴ | `UNAVAILABLE` | پایگاه در دسترس نیست؛ هیچ تغییری اعمال نشد |
| ۵ | `SCHEMA_MISMATCH` | دفترِ مهاجرت با کد نمی‌خواند (دست‌کاری، حفره، پایگاهِ «از آینده»، دادهٔ خراب)؛ **هیچ تغییری اعمال نشد** |
| ۶ | `MIGRATION_FAILED` | `up` در apply/verify شکست خورد (ممکن است مرحلهٔ پیشین اعمال شده باشد؛ تکرار امن است) |
| ۷ | `TIMEOUT` | مهلتِ کل گذشت؛ تراکنشِ نیمه‌کار با بسته‌شدنِ اتصال برمی‌گردد |

## گزارش (stdout، دقیقاً یک خطِ JSON؛ stderr خالی)
`{tool, command, ok, code, exitCode, phase?, stage?, pgCode?, ledger?, settlement?, retries?, issues?, usage?, closed?}` — `ledger`/`settlement` = `{applied, pending, appliedNow}`؛ `phase` ∈ `check|apply|verify`؛ `stage` ∈ `ledger|settlement`؛ `closed:false` یعنی بستنِ اتصال شکست/به مهلت خورد. `issues` فقط نامِ متغیر/فلگ؛ `pgCode` فقط SQLSTATEِ پنج‌نویسه. هیچ مقدارِ env، رشتهٔ اتصال یا متنِ خطای پایگاه در گزارش نیست.

## ناورداها
- **ترتیب:** دفتر ← outbox (برای هر دو فرمان).
- **check پیش از هر نوشتن:** ناهمخوانی/در دسترس‌نبودنِ هر فروشگاه ⇒ هیچ مهاجرتی اعمال نمی‌شود.
- **بی‌کاری = بی‌نوشتن:** فروشگاهِ بی‌معلق `migrate()` نمی‌شود.
- **verify پس از اعمال:** معلقِ باقی‌مانده ⇒ `۶`؛ هرگز «ok» بر پایهٔ ادعا.
- **هم‌زمانی:** `23505`/`40001`/`40P01` در apply ⇒ حداکثر ۳ تلاش (برنده‌ای دیگر هست)؛ هر خطای دیگر هرگز تکرار نمی‌شود.
- **مهلت:** پس از مهلت هیچ فراخوانیِ تازه‌ای به فروشگاه نیست؛ بستنِ اتصال با مهلتِ ۵ ثانیه؛ اتصالِ دیرِ باز‌شده بسته می‌شود؛ گلو سخت `exit` می‌زند.
- **ورودی:** دستور/فلگِ ناشناخته و تکراری خطاست؛ آرگومانِ موضعی هرگز پژواک نمی‌شود؛ هر `SETTLEMENT_*`ِ ناشناخته خطاست؛ `DATABASE_URL` فقط حضورش سنجیده می‌شود.
- **تنبل:** آرگومان/شِمای نامعتبر هرگز اتصالی نمی‌سازد.

## صادرات
`runSettlementMigrate`، `parseMigrateArgs`، `MIGRATE_EXIT`، `SETTLEMENT_MIGRATE_USAGE` + نوع‌ها.

## آزمون‌ها
`args.test.ts` (جدولی/خاصیتی/بدجنس) · `cli.test.ts` (فروشگاهِ ساختگی: ترتیب، بی‌نوشتن، نگاشت، بازتلاش، مهلت/لغو، اتصالِ تنبل، بی‌نشت، خاصیتیِ ۶۰۰ سناریو) · `cli.pg.test.ts` (PostgreSQL واقعی) · `process.pg.test.ts` (فرایندِ واقعیِ `npm run settlement:migrate`: کدِ خروج، stdout/stderr، مهلتِ سخت، SIGTERM) · `purity.test.ts` (نگهبانِ منبع). tooling: `settlement-migrate-parity.test.ts` (همارزیِ env با bootstrap)، `settlement-migrate-runtime.pg.test.ts` (CLI ≡ runtime)، `cli-alias-loader.test.ts`. جهشی: `DATABASE_URL=… python3 tooling/mutation/settlement-migrate.py`.

## محدودیت‌ها
فقط `ledger` و `settlement` را می‌شناسد. ابزارِ تعمیرِ دفتر نیست (عمداً). فقط Node ≥ ۲۲٫۱۸ و سینتکسِ «قابل‌حذف» در درختِ import. ریشهٔ مسابقهٔ `CREATE SCHEMA IF NOT EXISTS` در خودِ `ledger`/`settlement` هنوز هست (برشِ جدا)؛ این ماژول فقط آن را می‌پوشاند.
