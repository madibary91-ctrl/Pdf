# یادداشت تحویل ۰۰۵۱ — م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۳: سیم‌کشیِ `SETTLEMENT_BACKLOG_SOURCE=pending` در bootstrap

**کامیت پایه:** `6f792d8` (`main`؛ تحویل ۰۰۵۰، ۵۱۸۹ تست). مخزن: `madibary91-ctrl/Pdf`. کلونِ تازه، `npm install --no-package-lock`. به مخزن پوش **نکرده‌ام** (اعتبارنامهٔ نوشتن ندارم)؛ پچ‌ها و bundle در Gofile (پیوند و SHA-256 در پاسخِ تحویل؛ نمی‌شود درونِ همین فایل باشند چون خودِ فایل در پچ است).
تگِ پیش‌ازریسک: `pre-risk/20261125-backlog-source-pending` (حاشیه‌دار، روی `6f792d8`، **پیش از اولین ویرایش**؛ داخل bundle).

## ۱) چرا این برش (تصمیم من)
نقشهٔ راهِ ۰۰۵۰: ب‑۲‑۳ ← ب‑۲‑۴. نمایه و CLIِ آن کامل و آزموده‌اند ولی **هیچ مصرف‌کننده‌ای ندارند**؛ تا پایش از آن نخواند، همهٔ ب‑۲ سودی نمی‌دهد. بقیهٔ فهرستِ ۰۰۵۰ (ب‑۲‑۴ هزینه/backfill در مقیاس، `deliver`، هویت) یا به این وابسته‌اند یا بزرگ‌تر. برشِ بسته و پیش‌فرض‌خاموش؛ ADR-0051 تصمیم‌ها را ثبت کرده است. `ERR_IPC_CHANNEL_CLOSED` و `gate-floor` ویندوز طبق دستورِ شما دست نخورد؛ تصمیم‌های معلقِ ۰۰۴۶–۰۰۵۰ هم.
**سازمان‌دهیِ نوبت:** فایل‌های مرتبط پیوسته؛ دروازهٔ کامل ۲ بار (بار نخست یک خطای ساختاریِ **خودم** را نشان داد؛ توضیح در §۵).

## ۲) چه ساخته شد
- **`SETTLEMENT_BACKLOG_SOURCE`** ∈ {نبودن/خالی/`outbox` (پیش‌فرض)، `pending`}؛ هر مقدارِ دیگر و هر مقدارِ بی‌`SETTLEMENT_BACKLOG_WATCH=on` ⇒ `INVALID_ENV`. `backlog.source:"pending"` در نتیجهٔ env و لاگِ `bootstrap.backlog_watch` **فقط برای pending** می‌آید ⇒ پیش‌فرض بایت‌به‌بایت مثلِ پیش.
- **`bootstrap.ts`:** با pending، پایش فقط از `createPendingDeadIndex(db,{schema, readStatementTimeoutMs})` می‌خواند (همان پایگاه/شِما/سقفِ ADR-0045)؛ هیچ outboxی برای پایش ساخته نمی‌شود. **بی‌بازگشتِ بی‌صدا به outbox:** نمایهٔ نصب‌نشده ⇒ `degraded`/`SAMPLE_UNREADABLE`/`count:null`. نمایه ساخته نشد ⇒ `BACKLOG_INVALID`. بوت هرگز نمایه را نصب/بررسی نمی‌کند و نتیجهٔ بوتِ رفتگر به آن وابسته نیست.
- **CLIِ `settlement:pending`:** نامِ تازه در `KNOWN_SETTLEMENT_ENV` (وگرنه با همان envِ برنامه خروج ۲ می‌داد؛ مقدارش نادیده).
- `registry.ts`: وابستگیِ `settlement-bootstrap → settlement-pending` (۵ < ۷).
- آزمون‌های تازه (۶۸): `env.source.test.ts` (۳۲؛ شاملِ خاصیتیِ ۳۰۰۰)، `source.test.ts` (۱۲؛ اسپا)، `source.pg.test.ts` (۸؛ **PostgreSQL واقعی**)، `source.guard.test.ts` (۶)، `args.source.test.ts` (۶)، `tooling/backlog-source-parity.test.ts` (۴؛ خاصیتیِ ۳۰۰۰ + registry). جهشی: `tooling/mutation/settlement-bootstrap-source.py` (۱۵ جهش).
- مستند: ADR-0051، task 0049، `known-pitfalls` (۴ سطر)، `high-risk-areas`، README دو ماژول.

## ۳) تغییر در تست‌های موجود — **دو مورد، `Test-Change-Approved` در کامیت‌ها**
هر دو فقط افزودنِ یک مقدار به یک فهرست؛ نامِ هیچ `it` عوض نشد و هیچ تأکیدی ضعیف نشد:
۱. `settlement-bootstrap/purity.test.ts`: `ALLOWED_IMPORTS` ← `@/modules/settlement-pending` (مثلِ ADR-0043؛ بی‌این، هر سیم‌کشیِ نمایه در bootstrap ناممکن است).
۲. `tooling/settlement-pending-migrate-parity.test.ts`: فهرستِ نام‌های مورد انتظار ← `SETTLEMENT_BACKLOG_SOURCE` (همارزیِ «CLI ≡ bootstrap» همان است که می‌سنجد).
«تأییدکننده»: مجوزِ کلیِ شما در همین نوبت («مگر مستقیماً مرتبط با تغییرِ درخواستی و با تگ»)؛ اگر این دو را نمی‌پذیرید بگویید تا برگردانده شود و برش با روشِ تزریقِ وابستگی بازنویسی شود.

## ۴) راستی‌آزمایی
- **PostgreSQL واقعی (۱۵٫۱۹، لینوکس):** نمایهٔ نصب‌شده ⇒ شمارِ تأییدنشده (۳−۱=۲)؛ تأیید ⇒ کاهش تا `ok`؛ `gate_down` ⇒ ۵۰۳ و بازگشت؛ **نصب‌نشده با ۲ مردهٔ واقعی در outbox ⇒ هرگز ok/۲** (کنترل: خودِ outbox همان ۲ را می‌دهد)؛ `down` در حینِ اجرا ⇒ degraded و نصبِ دوباره ⇒ `ok` بی‌ری‌استارت؛ TRIGGER خاموش ⇒ پایش صفر می‌بیند ولی outbox یک (اثباتِ اینکه خواندن واقعاً از نمایه است؛ و `verify` همین `missing:1` را می‌گیرد).
- **جهشی:** ۱۵ جهش ← ۱۵ کشته، ۰ زنده (از جمله بازگشتِ پنهان به outbox، حذفِ سقف/شِما، وارونگیِ انتخاب، پذیرشِ مقدارِ نامعتبر/بی‌پایش، افتادنِ نام از فهرستِ شناخته‌ها، CLI بی‌نام).
- `tsc --noEmit` و `eslint` پاک؛ آزمون‌های بوت‌استرپ/CLI/مرزها (۴۰۷ + ۶۸) سبز.
- **دروازهٔ کامل** (`node tooling/ci-tests.ts`، این سندباکس، کندتر از CI: ≈۳۲۵ ثانیه): اجرای ۲: فایل ۲۱۳، **سبز ۵۲۵۶، شکست ۱**، ردشده ۰ (۱۶ todo از قبل)؛ آن یک شکست یک **ناپایداریِ پیش‌موجود** است (§۵) و فایلش به‌تنهایی سبز است ⇒ ۵۱۸۹ + ۶۸ = **۵۲۵۷**؛ `MIN_PASSED_TESTS` ۵۱۸۹ ← ۵۲۵۷. هیچ‌کدام از ۶۸ آزمونِ تازه در هیچ اجرایی شکست نخورد.

## ۵) انحراف‌ها و محدودیت‌های صادقانه
1. **اشتباهِ خودم، رفع‌شده:** `source.guard.test.ts` ابتدا `@/modules/registry` را import می‌کرد و `boundaries.test.ts` در دروازهٔ کامل قرمز شد (زیرمجموعهٔ آزمون‌هایی که پیش‌تر اجرا کرده بودم آن را نداشت چون فایل بعداً اضافه شد). بررسیِ registry به `tooling/backlog-source-parity.test.ts` رفت. درس: پیش از کامیت، `tooling/boundaries.test.ts` را پس از افزودنِ هر فایلِ آزمون اجرا کنید.
2. **ناپایداریِ پیش‌موجود، ثبت نه تغییر:** `settlement-pending/regclass.pg.test.ts › خطِ پایه (کنترل منفی)` (از ۰۰۵۰) و در اجرای دوم `settlement-pending-migrate/down.pg.test.ts › بی‌--yes` (`activeBackends` ۱ به‌جای ۰) زیرِ بارِ موازیِ DDLِ فایل‌های PostgreSQLِ دیگر گاهی قرمز می‌شوند. اندازه‌گیری: جفتِ `down.pg.test.ts + regclass.pg.test.ts` روی **همان کامیتِ پایهٔ بی‌تغییر** (`6f792d8`) هم در ۱ از ۷ اجرا قرمز شد (روی درختِ من ۵ از ۱۲)؛ هر فایل به‌تنهایی همیشه سبز. فرضِ من: بازنشانیِ کشِ کاتالوگ (انباشتِ پیام‌های invalidation) در اتصالِ گرمِ کنترلِ منفی؛ و تأخیرِ بسته‌شدنِ backend در `activeBackends`. به آن‌ها دست نزدم (قانونِ آهنین)؛ بی‌ارتباط با این برش است ولی **باز** است (با مورد باز «ناپایداریِ `process.pg.test.ts`» هم‌خانواده است): پیشنهاد برشِ کوچکِ «پایدارسازیِ آزمون‌های PostgreSQLِ گرم» (با `Test-Change-Approved` و بی‌ضعیف‌کردن).
3. **باز برای مالک (ADR-0051 یافتهٔ ۳):** `SAMPLE_UNREADABLE` فقط degraded است ⇒ با `gate_down` و نمایهٔ نصب‌نشده ready هنوز ۲۰۰؛ سیاستِ ADR-0043 است، عوض نکردم.
4. `settlement-migrate` (ابزار قدیمی) `SETTLEMENT_BACKLOG_SOURCE` را هم رد می‌کند (همان یافتهٔ ۰۰۴۷)؛ دست نخورد؛ `settlement:migrate` را با envِ بدونِ متغیرهای پایش اجرا کنید.
5. **ترتیبِ عملیات:** نصب (`up` + `verify`) ← env ← استقرار؛ برگشت: env را بردارید ← `down --yes`.
6. بازبینیِ انسانیِ `bootstrap.ts`/`env.ts` (ناحیهٔ پرریسک) انجام نشده؛ هوک‌های گیت را نصب نکردم (قالبِ پیام و trailerها با `check-range` سنجیده شدند). CI گیت‌هاب را نمی‌بینم؛ «سبز بودن» ادعای من است تا CI شما تأیید کند. ویندوز: آزمون‌های تازه اجرا نشده‌اند.
7. موارد بازِ ۰۰۴۶–۰۰۵۰ (متنِ پیام‌های قفل‌شده، `PendingMigratable.down` اختیاری، ناهمارزیِ `settlement-migrate`، ناپایداریِ `process.pg.test.ts`، backfill در مقیاس، `ACCESS EXCLUSIVE`، توضیحِ کهنهٔ `execute.ts`) **دست‌نخورده**.

## تأیید لازم از شما
۱) بازبینیِ انسانیِ انتخابِ منبع در `bootstrap.ts` و آزمونِ «بی‌بازگشتِ بی‌صدا»؛ ۲) پذیرشِ دو ویرایشِ فهرست‌گونهٔ آزمونِ قفل‌شده (§۳)؛ ۳) تصمیم درباره‌ٔ سیاستِ `SAMPLE_UNREADABLE` با `gate_down` (§۵‑۳).

## گام بعد (تصمیم من)
۱) **ب‑۲‑۴** بازاجرای `backlog:cost` با منبعِ نمایه + زمانِ backfill و انسدادِ نویسنده در مقیاس (آخرین برشِ ب‑۲). ۲) پایدارسازیِ آزمون‌های PostgreSQLِ گرم (§۵‑۲) و `process.pg.test.ts`، و به‌روزکردنِ توضیحِ `execute.ts`. ۳) م۳‑ه‑۴‑ب (`deliver`). ۴) م۲ (هویت).

## پچ‌ها
`git format-patch 6f792d8..HEAD` (چهار کامیت: `feat(settlement-pending-migrate)`، `feat(settlement-bootstrap)`، `chore(ci)`، `docs`) + bundle (تگ `pre-risk/20261125-backlog-source-pending`) در Gofile (`SHA256SUMS` کنار پچ‌ها). اعمال: `git checkout 6f792d8 && git am /path/000*.patch`، یا `git pull <bundle> main`. `git am` هوک‌ها را اجرا نمی‌کند.
