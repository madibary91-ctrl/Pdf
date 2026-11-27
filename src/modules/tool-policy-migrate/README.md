# tool-policy-migrate

CLIِ رسمیِ مهاجرتِ زمانِ استقرارِ شِمای نسخه‌های سیاستِ ابزار (CT‑5c‑2c‑3، ADR-0080): **`status` فقط‌خواندنی و `up` idempotent** با پیش‌بازرسیِ بی‌نوشتن، ساختنِ شِما فقط با فلگِ آگاهانه، راستی‌آزماییِ پس از اعمال، کدهای خروجِ بسته، گزارشِ JSONِ بی‌نشت، هم‌زمانیِ بی‌خطر و مهلتِ کل.
منطقِ مهاجرت (SQL، checksum، قفل) در `tool-policy-store-pg` می‌ماند؛ این ماژول فقط **ترتیب، پیش‌بازرسی، راستی‌آزمایی و گزارش** را دارد و یک SQLِ ثابت: `CREATE SCHEMA IF NOT EXISTS` (فقط در `store.ts`). به `process`، `pg`، ساعتِ سیستم و `console` مستقیم وابسته نیست؛ همه تزریقی است (گلوی `tooling/cli/tool-policy-migrate.ts` آن‌ها را می‌دهد). `tool-policy-store-pg` را فقط از رابطِ عمومی می‌شناسد.

## چرا جدا از برنامه
برنامه (`tool-policy-bootstrap`) هرگز DDL نمی‌زند و `CREATE SCHEMA` هم نمی‌زند (ADR-0070 بند ۳). مهاجرت با **نقشِ مهاجرتِ جدا** اجرا می‌شود: `DATABASE_URL`ِ این CLI رشتهٔ اتصالِ نقشِ مدیر/مهاجرت است، نه نقشِ زمانِ اجرا.

## استفاده
```
DATABASE_URL=… npm run policy:migrate -- status                          # فقط‌خواندنی؛ خروج ۰ فقط اگر آماده باشد
DATABASE_URL=… npm run policy:migrate -- up                              # شِما باید از پیش باشد
DATABASE_URL=… npm run policy:migrate -- up --create-schema --timeout-ms=120000
```
شِما فقط از env: `TOOL_POLICY_SCHEMA` (همان برنامه؛ نبودن/خالی = `tool_policy`). هر `TOOL_POLICY_*`ِ ناشناخته خطاست (غلط‌یاب). با `node --env-file=.env` هم می‌شود (CLI خودش `.env` نمی‌خواند). Node ≥ ۲۲٫۱۸.
الگوی استقرار: `up` (خروج ۰) ← سپس شروعِ برنامه با `TOOL_POLICY_HOST=on`. در pipeline می‌شود پیش از انتشار `status` را دروازه کرد.

## کدهای خروج
| کد | نام | معنا |
|---|---|---|
| ۰ | `OK` | `status`: آماده (مهاجرت‌ها اعمال، بی‌مشکل، نسخه‌ها بی‌شکاف) · `up`: موفق یا کاری نبود |
| ۱ | `INTERNAL` | خطای برنامه‌نویسی/پورتِ خراب/شکلِ ناشناختهٔ پاسخ (بسته) |
| ۲ | `USAGE` | آرگومان یا env نامعتبر؛ **هیچ اتصالی ساخته نشد** |
| ۳ | `PENDING` | `status`: شِما/جدول نیست یا مهاجرتِ معلق هست |
| ۴ | `UNAVAILABLE` | پایگاه در دسترس نیست؛ هیچ تغییری اعمال نشد |
| ۵ | `SCHEMA_MISMATCH` | دفتر دست‌کاری/«از آینده»، قید یا تریگرِ فقط‌افزودنی نیست/خاموش است، یا نسخه‌ها شکاف دارند؛ **هیچ تغییری اعمال نشد** |
| ۶ | `MIGRATION_FAILED` | `up` در ساختنِ شِما، اعمال یا راستی‌آزمایی شکست خورد (تکرار امن است) |
| ۷ | `TIMEOUT` | مهلتِ کل گذشت؛ تراکنشِ نیمه‌کار با بسته‌شدنِ اتصال برمی‌گردد |
| ۸ | `SCHEMA_MISSING` | `up` بی‌`--create-schema` روی شِمای ناموجود؛ **هیچ تغییری اعمال نشد** |

## گزارش (stdout، دقیقاً یک خطِ JSON؛ stderr خالی)
`{tool, command, ok, code, exitCode, phase?, pgCode?, state?, schemaCreated?, issues?, usage?, retries?, closed?}`؛ `state` = `{schemaExists, applied, pending, appliedNow, rows, latestVersion, contiguous, problemCount, ready}`. فقط نامِ مهاجرت، شمارش، SQLSTATEِ پنج‌نویسه و نامِ متغیر؛ **هرگز** رشتهٔ اتصال، SQL، متنِ خطا یا متنِ مشکل. `closed:false` یعنی بستنِ اتصال شکست خورد و گلو فرایند را سخت می‌بُرد.

## ناورداها
۱) `check` پیش از هر نوشتن؛ ناهمخوانی/در‌دسترس‌نبودن ⇒ هیچ نوشتنی. ۲) آماده ⇒ بی‌نوشتن (نه قفل، نه DDL). ۳) شِما فقط با `--create-schema` و فقط وقتی نیست. ۴) پس از اعمال، خواندنِ دوباره؛ هر چیزی جز «آماده» ⇒ `MIGRATION_FAILED`. ۵) بازتلاشِ کران‌دار (۳ تلاش) فقط برای SQLSTATEِ هم‌زمانی (`23505`، `40001`، `40P01`) روی `DB_ERROR`. ۶) پس از مهلت هیچ فراخوانیِ تازه‌ای نیست.

## ممنوع
`process`، `console`، `Date`/تایمر، `pg`، ساختنِ اتصال، `catch (e)`/`.message`، خواندنِ مقدارِ `DATABASE_URL`، هر SQLِ دیگر جز `CREATE SCHEMA IF NOT EXISTS`، و import از جز `tool-policy-store-pg` (آزمونِ `purity.test.ts`).
