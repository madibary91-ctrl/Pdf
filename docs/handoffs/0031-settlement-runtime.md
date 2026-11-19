# یادداشت تحویل ۰۰۳۱ — settlement‑runtime م۳‑ه‑۲: ریشهٔ ترکیبِ رفتگرِ تسویه (`createSettlementRuntime`)

**کامیت پایه:** `3532f9c` (شاخهٔ `main`؛ تحویل ۰۰۳۰، ۳۲۷۴ تست). مخزن: `madibary91-ctrl/Pdf`. کلون تازه، `npm install --no-package-lock` و `node tooling/git-discipline.ts install` انجام شد. به مخزن پوش **نکرده‌ام** (اعتبارنامهٔ نوشتن ندارم)؛ پچ‌ها و bundle در Gofile (پیوند در پاسخ تحویل).

## ۱) چرا این برش (تصمیم من)
یادداشت ۰۰۳۰ دو چیز گذاشته بود: نقشهٔ ریشهٔ ترکیب (م۳‑ه‑۲/۳/۴) و **یک پرسشِ معماریِ باز**: «سیم‌کشی کجا زندگی کند؟». من آن را پاسخ دادم (ماژولِ تازه) چون همهٔ برش‌های بعدی (اتصال به `src/app`، `deliver`ِ واقعی، دسکتاپ، کارگر) روی آن سوار می‌شوند و بدونِ آن هر کدام یا نگهبانِ پولِ `settlement` را سست یا منطقِ حساس را در مسیرِ HTTP بدونِ آزمون می‌نشاند. از میانِ سه برشِ نقشه، **م۳‑ه‑۲ را برداشتم و عمداً `src/app` را لمس نکردم**: خطرِ اصلیِ سیم‌کشی (شروع روی پایگاهِ مهاجرت‌نشده، دو حلقه، تایمرِ حلقهٔ داغ، `stop` وسطِ `start`) را می‌شود کاملاً بی‌Next آزمود؛ اتصالِ HTTP بعد از آن یک لایهٔ نازک می‌شود.

## ۲) چه ساخته شد (`src/modules/settlement-runtime/`)
- **`createSettlementRuntime(raw)`** (روی پورت‌های تزریقی) و **`createPgSettlementRuntime(raw)`** (از `db` دفتر و outbox می‌سازد): `start()` / `stop()` / `health()` / `status()` / `ports` (+ `migrate()` در نسخهٔ pg). `health()` همگام و بی‌I/O است و `sweepHealthHttpStatus` را اعمال می‌کند.
- **شروعِ شکست‌بسته:** پیش‌بازرسیِ فقط‌خواندنیِ مهاجرت‌ها با مهلت ⇒ `NOT_MIGRATED | SCHEMA_MISMATCH | UNAVAILABLE`؛ `start` هرگز مهاجرت نمی‌کند (ADR-0022)؛ ساعتِ نامعتبر ⇒ `CLOCK_INVALID`.
- **چرخهٔ عمر:** `idle→starting→running→stopping`؛ تک‌شروع، `stop` هم‌زمان با وعدهٔ مشترک، `stop` در میانهٔ `start` آن را لغو می‌کند (بی‌حلقهٔ یتیم)، گذرِ آویزان ⇒ `clean:false`/`PREVIOUS_RUN_ACTIVE`، ریستارت.
- **پیش‌فرض‌های مستند:** `intervalMs=max(1,⌊grace/4⌋)`، `leaseMs=min(grace,سقف)` (همیشه روشن)، `startTimeoutMs=۱۵٬۰۰۰`؛ `deadLetters` الزامی (`false` یا `{deliver}`).
- **`createNodeTimer`** (تأخیرِ نامعتبر می‌پرتابد؛ `unref`؛ لغوِ بی‌خطر) و **`createSystemClock`**.
- **آزمون‌های تازه (۲۳۲):** `config.test.ts` (۷۴) · `runtime.test.ts` (۵۳: پول، چرخهٔ عمر، پیش‌بازرسی، سلامت روی حلقهٔ واقعی، زنگ) · `node-timer.test.ts` (۳۹) · `pg-runtime.unit.test.ts` (۴۰: اعتبارسنجی و نگاشتِ SQLSTATE با `db`ِ ساختگی) · `runtime.pg.test.ts` (۱۳، PostgreSQL واقعی: بی‌مهاجرت/ناقص/دست‌کاری/قطع، ریستارتِ فرایند، دو فرایند با استخرِ جدا، قطعِ وسطِ کار، دودیِ زمانِ واقعی) · `purity.test.ts` (۱۰: نگهبانِ منبع) · `clock.test.ts` (۳).
- `tooling/mutation/settlement-runtime.py`: ۵۳ جهش در چهار فایل.
- مستندات: ADR-0031، task 0029، README ماژول، ردیفِ `docs/high-risk-areas.md`، ثبت در `registry.ts` (لایه ۵، `humanReview:true`) و `HIGH_RISK_MODULES`.

## ۳) تغییر در تست‌های موجود — **یک مورد**، با `Test-Change-Approved`
`tooling/test-connection-budget.test.ts` فهرستِ دقیقِ همهٔ `src/**/test-db.ts` را قفل کرده؛ ماژولِ تازه یکی دارد ⇒ **یک خط** به فهرست افزوده شد (همان رویهٔ ADR-0024؛ `test-db.ts` تازه قاعدهٔ `idleTimeoutMillis` را رعایت می‌کند). `git diff --name-status 3532f9c..HEAD -- '*.test.ts'`: هفت `A` (همگی در `settlement-runtime/`) و یک `M` (همین). `settlement`، `ledger`، `metering`، `src/app` و هیچ قراردادی دست نخورد؛ `registry.ts` فقط یک ردیف گرفت (G7: فقط ماژولِ `settlement-runtime`).

## ۴) راستی‌آزمایی (PostgreSQL ۱۵ واقعی، Node 22.23)
- **پایه پیش از شروع:** دروازهٔ صفر-رد روی `3532f9c` سبز: ۳۲۷۴ (همان عددِ ۰۰۳۰). تگِ `pre-risk/20261121-settlement-runtime` پیش از اولین ویرایش زده شد.
- **پس از برش:** دروازهٔ صفر-رد **۳۵۰۶ سبز، ۰ رد، ۰ شکست، ۱۶ todo** (۳۲۷۴ + ۲۳۲؛ ۱۲۷ فایل). `tsc` و `eslint .` سبز. کفِ `MIN_PASSED_TESTS`: ۳۲۷۴ ← ۳۵۰۶ (کامیتِ جدا با `Risk-Tag`). هوکِ pre-commit دروازه را خودش روی هر دو کامیتِ کد اجرا کرد.
- **جهشی:** ۵۳ جهش، **۵۳ کشته، هم‌ارزِ توضیح‌نشده ۰، زندهٔ توضیح‌نشده ۰** (اجرای نهایی روی کدِ کامیت‌شده).
- **ضعف‌هایی که حین کار پیدا و رفع کردم:** (الف) **باگِ واقعی در کدِ خودم:** `snap.startTimeoutMs ?? پیش‌فرض` مقدارِ صریحِ `null` را بی‌صدا پیش‌فرض می‌کرد (همین‌طور `leaseMs`/`intervalMs`)؛ آزمونِ مرزی قرمز شد و با `=== undefined` رفع شد (+ آزمون برای هر سه). (ب) جهشِ نخست ۷ زنده داشت: دو بررسیِ **زائد** (`clock`/`timer` که `settlement` همان را رد می‌کند و یک `return` پس از `done`) را از منبع **حذف** کردم نه این‌که برایشان آزمون ساختگی بنویسم؛ برای «`ALREADY_RUNNING` حالتِ اجرا را خراب نکند»، «مرحلهٔ شکستِ migrate»، «مهاجرتِ معلقِ دفتر»، «نگاشتِ `NOT_MIGRATED` از SQLSTATE `42P01/3F000`»، «`db` نامعتبر» و «بریدنِ نامِ کلیدِ ناشناخته» آزمونِ تازه نوشتم. (ج) هوکِ اسرار دو فایلِ آزمون را رد کرد چون رشتهٔ اتصالِ ساختگیِ حاویِ رمز (برای آزمونِ نشت) داشتند؛ به‌جای دورزدن، رشته را در `test-kit` تکه‌تکه ساختم (`FAKE_DSN`).

## ۵) انحراف‌ها و نکته‌ها (برای بازبینی)
1. **`db` به‌جای `pool`:** ۰۰۳۰ `createSettlementRuntime({ pool, … })` پیشنهاد داده بود؛ من `db` (drizzle) گرفتم تا ماژول هرگز اتصال نسازد/نبندد و `pg` import نشود (نگهبانِ منبع می‌سنجد).
2. **`Math.min(graceMs, سقفِ اجاره)` امروز بی‌اثر است** (`maxGraceMs = ۴۳٬۲۰۰٬۰۰۰ < maxLeaseMs`)؛ سپرِ دفاعی است و آزمونِ رفتاری ندارد؛ عمداً جهشی هم برایش ننوشتم تا هم‌ارزِ ساختگی ثبت نشود.
3. **ساخت و اجرای محلی:** مخزن `pnpm` می‌خواهد؛ `npm install --no-package-lock` و `pnpm-lock.yaml` دست نخورد. اگر تفاوتی مشکوک است در CI با pnpm هم تأیید شود.
4. **هویتِ گیت:** فقط در همین کلون `Sonnet <sonnet@example.invalid>` (مثلِ کامیت‌های پیشین).
5. **تغییرِ رفتارِ مشاهده‌پذیر در سامانه نیست:** به `src/app`، `/api/health`، استخرِ برنامه وصل نشده؛ تا برشِ بعد هیچ اثری در اجرا ندارد.
6. بازبینیِ انسانیِ مالک معماری و امنیت/مالی انجام نشده است (`settlement-runtime` ناحیهٔ پرریسک است).

## محدودیت‌های صادقانه
- پیش‌بازرسی فقط در `start` است؛ پایگاهی که **بعد** قطع شود از راهِ `health()` (degraded ⇒ down) دیده می‌شود (آزموده شد)، نه پیش‌بازرسی.
- `graceMs` هنوز باید دستی با `createDurableLedger` یکی باشد (محدودیتِ ADR-0023)؛ `ports` فقط outbox و دفتر را یکی می‌کند.
- `deliver`ِ واقعی و پایشِ پسماندِ مرده‌ها نیست (م۳‑ه‑۴)؛ `SIGTERM`/خاموشیِ مرتبِ فرایند و singleton نیست (م۳‑ه‑۳).
- `health()` پیش از `start` عمداً `down` است؛ اگر `/api/health` با همان لایوِنِس‌پروب یکی شود، شروعِ کُندِ پایگاه ۵۰۳ می‌دهد (در م۳‑ه‑۳ باید پروبِ آمادگی/زنده‌بودن جدا شود).
- فقط لینوکس + PostgreSQL ۱۵. CI گیت‌هاب را نمی‌بینم؛ تگِ `green/<slug>` (G9) را نزدم.

## تأیید لازم از شما
۱) **معماری:** ثبتِ ماژولِ `settlement-runtime` در `registry.ts` و `HIGH_RISK_MODULES` (ADR-0031 تصمیم ۱) و `db` به‌جای `pool` (تصمیم ۳). ۲) **معماری/مالی:** `leaseMs` همیشه روشن با پیش‌فرض `graceMs` (تصمیم ۵) و `deadLetters` الزامی (تصمیم ۶). ۳) **مالی (ادامهٔ ۰۰۳۰):** `degraded` ⇒ ۲۰۰، `down` ⇒ ۵۰۳ و `down` پیش از `start`. ۴) تأییدِ تغییرِ تک‌خطیِ `test-connection-budget.test.ts`.

## گام بعد (پیشنهاد)
۱) **م۳‑ه‑۳:** اتصال به `src/app`: `instrumentation.ts` برای singleton (با `createPgSettlementRuntime`، `migrate()` صریح در دیپلوی نه در بوت)، `/api/health` با `runtime.health()`؛ **بدون شکستنِ آزمونِ سلامتِ فعلی** (`/api/health` الان برای `build_and_start` لازم است — پروبِ راه‌اندازی/آمادگی جدا از `down`) و خاموشیِ مرتب روی `SIGTERM`. ۲) **م۳‑ه‑۴:** `deliver`ِ واقعی (کانالِ اعلامِ مرده‌ها) و پایشِ پسماند (`counts()`/`listUnacknowledgedDead`) در `health`. ۳) سپس م۲ (هویت) و م۴ (خرید).

## پچ‌ها
`git format-patch -N 3532f9c..HEAD` (چهار پچ؛ چهارمی همین یادداشت) + bundle (تگ `pre-risk/20261121-settlement-runtime`) در Gofile (`SHA256SUMS` کنار پچ‌ها). اعمال: `git clone https://github.com/madibary91-ctrl/Pdf && cd Pdf && git checkout 3532f9c && git tag -a pre-risk/20261121-settlement-runtime -m "…" && git am /path/000*.patch`، یا `git pull <bundle> main`. `git am` هوک‌ها را اجرا نمی‌کند.
