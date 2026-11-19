# یادداشت تحویل ۰۰۳۲ — settlement‑host م۳‑ه‑۳‑الف: میزبانِ فرایندیِ رفتگرِ تسویه (`createSettlementHost`)

**کامیت پایه:** `3743f39` (شاخهٔ `main`؛ تحویل ۰۰۳۱، ۳۵۰۶ تست؛ همان کامیتی که مالک گزارش کرد اعمال و پوش شده). مخزن: `madibary91-ctrl/Pdf`. کلون تازه، `npm install --no-package-lock` و `node tooling/git-discipline.ts install` انجام شد. به مخزن پوش **نکرده‌ام** (اعتبارنامهٔ نوشتن ندارم)؛ پچ‌ها و bundle در Gofile (پیوند در پاسخ تحویل).

## ۱) چرا این برش (تصمیم من)
یادداشت ۰۰۳۱ «م۳‑ه‑۳» را گام بعد گذاشته بود: اتصال به `src/app` (singleton با `instrumentation`، `/api/health` با `runtime.health()`، خاموشیِ مرتب روی `SIGTERM`) با سه هشدارِ صریح (health پیش از start عمداً `down` است؛ `/api/health` فعلی برای `build_and_start` لازم است؛ singleton و سیگنال نیست). همان استدلالِ ۰۰۳۱ اینجا هم صادق است: اگر این منطق مستقیم در `src/app` بنشیند، کارِ حساسِ بی‌آزمون در مسیرِ HTTP می‌نشیند. پس م۳‑ه‑۳ را به دو برش شکستم و **اولی** را ساختم: **منطقِ سطحِ فرایند در ماژولِ آزمودنی**، بدونِ لمس `src/app`/`/api/health`/`instrumentation`/`package.json`. اتصالِ HTTP (برش ب) بعد از آن یک لایهٔ نازک است.

## ۲) چه ساخته شد (`src/modules/settlement-host/`، لایه ۶، `humanReview:true`)
- **`createSettlementHost(raw)`** → `{ boot, shutdown, status, probes:{live,startup,ready} }`، هیچ‌کدام نمی‌پرتابد. همه‌چیز تزریقی: `runtime` (پورتِ `start/stop/health`)، `timer`، `signals` (الزامی: `false` یا منبع)، `exit?`، `closeResources?`، `observer?`.
- **بوتِ شکست‌بسته:** سیگنال‌ها **پیش از** `runtime.start()` نصب می‌شوند (نصبِ ناموفق ⇒ `SIGNALS_UNAVAILABLE`، رفتگر شروع نمی‌شود، شنونده‌ی نیمه‌نصب برمی‌گردد)؛ هم‌زمان ⇒ یک وعده؛ بازتلاشِ **فقط** `PREFLIGHT_FAILED/UNAVAILABLE` (`bootRetry`، پیش‌فرض ۱ تلاش)؛ `NOT_MIGRATED`/`SCHEMA_MISMATCH`/… هرگز بازتلاش نمی‌شوند؛ پس از `failed` بوتِ دوباره ممکن است؛ پس از خاموشی `SHUTTING_DOWN`.
- **خاموشی:** `stopping` (ready ⇒ ۵۰۳ فوری) ← `runtime.stop()` ← انتظارِ بوتِ در جریان ← **فقط پس از `clean:true`** `closeResources()` ← `stopped`؛ همه زیرِ یک مهلت (`shutdownTimeoutMs`، پیش‌فرض ۱۵٬۰۰۰)؛ زمان‌سنجِ خراب مانعِ stop نیست؛ نتیجه `{ ok, clean, timedOut, closed, reason }`؛ سیگنالِ تکراری خاموشی را نمی‌کُشد؛ `exit(ok?0:1)` پس از پایان.
- **سه پروبِ جدا (پاسخ به هشدارِ ۱ تحویل ۰۰۳۱):** `live` همیشه ۲۰۰؛ `startup` ۲۰۰ از اولین بوتِ موفق (چسبنده)؛ `ready` ۲۰۰ فقط در `running` با `status∈{ok,degraded}` و `httpStatus=200` هم‌سازگار (هر ناسازگاری ⇒ ۵۰۳). بدنه فقط `{probe, ok, state, sweep}`.
- **singleton روی ظرفِ تزریقی:** `acquireSettlementHost(store, create)` / `getSettlementHost` / `probeSettlementHost(store, kind)`؛ مقدارِ بیگانه بازنویسی نمی‌شود؛ شکستِ `create` ذخیره نمی‌شود؛ بدونِ میزبان `live`=۲۰۰ و بقیه ۵۰۳ (`state:"absent"`). کلیدِ `Symbol.for("legal-platform.settlement-host")`؛ ماژول `globalThis` را نمی‌شناسد.
- **`createNodeSignalSource`/`createNodeExit`:** تنها فایلِ حاوی `process` (`node-process.ts`)؛ میزبان خودش هرگز `process.exit` صدا نمی‌زند.
- **آزمون‌های تازه (۲۷۶، هفت فایل):** `config.test.ts` · `probes.test.ts` (جدولِ حالت×پروب) · `host.test.ts` (بوت، بازتلاش، خاموشی، مهلت، مسابقهٔ بوت/خاموشی، سیگنال، پورتِ خصمانه؛ زمانِ مجازی) · `singleton.test.ts` · `node-process.test.ts` · `integration.test.ts` (با `createSettlementRuntime` **واقعی** و دفتر/outboxِ حافظه‌ای: رزروِ یتیم بی‌sweep دستی بسته می‌شود؛ ready با سلامتِ زندهٔ runtime هم‌سازگار روی ok→degraded→down→بهبود؛ SIGTERM ⇒ توقفِ تمیز، صفر تایمرِ معلق، و نمونهٔ بعدی رزروِ رهاشده را می‌بندد؛ گذرِ آویزان ⇒ close صدا زده نمی‌شود و `exit(1)`؛ ناوردای دفتر) · `purity.test.ts`.
- `tooling/mutation/settlement-host.py`: ۹۹ جهش در پنج فایل.
- مستندات: ADR-0032، task 0030، README ماژول، ردیفِ `docs/high-risk-areas.md`، ثبت در `registry.ts` (لایه ۶، وابسته به `settlement-runtime` و برای آزمونِ یکپارچه `settlement`/`ledger`، `humanReview:true`) و `HIGH_RISK_MODULES`.

## ۳) تغییر در تست‌های موجود — **هیچ**
`git diff --name-status 3743f39..HEAD -- '*.test.ts'`: **هفت `A`، صفر `M`/`D`**. هیچ `Test-Change-Approved` لازم نشد (ماژول عمداً `test-db.ts` ندارد تا فهرستِ قفل‌شدهٔ `test-connection-budget.test.ts` دست نخورد). `settlement-runtime`، `settlement`، `ledger`، `metering`، `src/app`، `package.json` و هیچ قراردادی دست نخورد. فایل‌های غیرِ `settlement-host` که تغییر کردند: `registry.ts` (یک ردیف)، `tooling/git-discipline.ts` (یک نام)، `tooling/ci-tests.ts` (کف)، `docs/high-risk-areas.md` (یک ردیف).

## ۴) راستی‌آزمایی (PostgreSQL ۱۵ واقعی، Node 22.23)
- **پایه پیش از شروع:** دروازهٔ صفر-رد روی `3743f39` سبز: ۳۵۰۶ (همان عددِ ۰۰۳۱). تگِ `pre-risk/20261122-settlement-host` پیش از اولین ویرایش زده شد.
- **پس از برش:** دروازهٔ صفر-رد **۳۷۸۲ سبز، ۰ رد، ۰ شکست، ۱۶ todo** (۳۵۰۶ + ۲۷۶؛ ۱۳۴ فایل). `tsc` و `eslint .` سبز. کفِ `MIN_PASSED_TESTS`: ۳۵۰۶ ← ۳۷۸۲ (کامیتِ جدا با `Risk-Tag`). هوکِ pre-commit دروازه را خودش روی هر دو کامیتِ کد اجرا کرد.
- **جهشی:** ۹۹ جهش، **۹۸ کشته، ۱ هم‌ارزِ توضیح‌داده‌شده، زندهٔ توضیح‌نشده ۰** (اجرای نهایی روی کدِ کامیت‌شده).
- **یافتهٔ مهمِ راستی‌آزمایی (Next):** `node_modules/next/dist/server/lib/start-server.js` خودش روی SIGTERM/SIGINT `cleanup` ثبت می‌کند که پس از `server.close()` مستقیم `process.exit(143|130)` می‌زند (مگر `NEXT_MANUAL_SIG_HANDLE`). یعنی در برش «ب» دو شنونده رقابت می‌کنند و Next ممکن است پیش از پایانِ خاموشیِ ناهمگامِ ما ببُرد. (ADR-0032؛ تصمیمِ نهایی با اجرای واقعی در برش ب.)
- **ضعف‌هایی که حین کار پیدا و رفع کردم:** (الف) جهشِ نخست ۱۱ زنده داشت. سه مورد **زائد بودنِ خودِ کد** بود و **حذف کردم** نه این‌که برایشان آزمون ساختگی بنویسم: دو بررسیِ `state!=="booting"` که هم‌پوشان بودند (یکی ماند)، پاک‌کردنِ وعدهٔ بوتِ تمام‌شده (بی‌اثرِ مشاهده‌پذیر)، بررسیِ `typeof create` (پرتابِ `TypeError` همان `CREATE_FAILED` می‌شود) و ردِّ `onSignal`ِ تکراری (`shutdownInternal` خودش یک وعده است). (ب) پنج جهشِ زنده **حفرهٔ واقعیِ آزمون** بود و آزمونِ تازه گرفتند: `ok` بی‌`closeResources` وقتی توقف ناتمیز است (`closed:"none"` نباید پنهانش کند ⇒ `exit(1)`)؛ `ok` وقتی بوتِ آویزان مهلت را می‌خورد ولی stop تمیز بود؛ کدِ `UNAVAILABLE` همراهِ دلیلی جز `PREFLIGHT_FAILED`؛ میزبانِ ساختگی با `probes` ناقص؛ بریدنِ نامِ کلیدِ ناشناخته. (ج) سه آزمونِ نخستین خودم به‌خاطر زمان‌بندیِ ریزتیکِ مجازی (`advance` پیش از آن‌که تایمر ثبت شود) قرمز شدند؛ آزمون را درست کردم (`flush`)، نه کد را. (د) در آزمونِ یکپارچه TTLِ رزرو (۶۰ ثانیه) انقضای دفتر را وسط انداخت؛ زمان را کوتاه کردم تا فقط رفتارِ رفتگر سنجیده شود.
- **یک هم‌ارزِ توضیح‌داده‌شده:** حذفِ `if (observer === null) return;`: بدونِ آن، `TypeError` را همان `try/catch` می‌گیرد؛ رفتارِ مشاهده‌پذیر یکی است (نگهبانِ وضوح).

## ۵) انحراف‌ها و نکته‌ها (برای بازبینی)
1. **ماژولِ جدا به‌جای افزودن به `settlement-runtime`:** `settlement-runtime` نگهبانِ منبعش `process` را می‌بندد و وظیفه‌اش ترکیبِ سیاست است؛ سیگنال/singleton/پروب وظیفهٔ فرایند است. هزینه: یک ردیفِ دیگر در registry.
2. **`dependsOn` شاملِ `settlement` و `ledger`** است فقط چون آزمونِ یکپارچه از رابط عمومی‌شان می‌خواند و بررسِ مرزها آزمون‌ها را هم می‌سنجد؛ کدِ محصول فقط `settlement-runtime` را import می‌کند (نگهبانِ منبع می‌سنجد).
3. **`closeResources` فقط پس از توقفِ تمیز** و `ready` بی‌درنگ ۵۰۳ در آغازِ خاموشی؛ `startup` چسبنده؛ `live` هرگز به پایگاه گره نخورد. (ADR-0032 تصمیم ۴/۶)
4. **بازتلاش پیش‌فرض خاموش است** (۱ تلاش) تا «بی‌صدا منتظر ماندن» تصمیمِ مالک باشد.
5. **ساخت و اجرای محلی:** مخزن `pnpm` می‌خواهد؛ `npm install --no-package-lock` و `pnpm-lock.yaml` دست نخورد. اگر تفاوتی مشکوک است در CI با pnpm هم تأیید شود.
6. **هویتِ گیت:** فقط در همین کلون `Sonnet <sonnet@example.invalid>` (مثلِ کامیت‌های پیشین).
7. **تغییرِ رفتارِ مشاهده‌پذیر در سامانه نیست:** به `src/app`، `/api/health`، `instrumentation` و استخرِ برنامه وصل نشده.
8. بازبینیِ انسانیِ مالک معماری و امنیت/مالی انجام نشده است (`settlement-host` ناحیهٔ پرریسک است).

## محدودیت‌های صادقانه
- سیگنالِ واقعیِ OS در آزمون ارسال نمی‌شود (process ساختگی؛ فقط بهداشتِ شنونده‌ها روی `process` واقعی). دودیِ فرایندِ واقعی با Next در برش ب.
- رقابت با شنوندهٔ SIGTERMِ خودِ Next حل نشده (بالا)؛ خاموشیِ ناتمام ایمن است ولی بسته‌شدنِ استخر پیش از مرگ تضمین نیست.
- drainِ مرحله‌ای (فاصله میانِ ۵۰۳ شدنِ ready و توقف برای دیده‌شدن توسط load balancer) نیست؛ `shutdownTimeoutMs` فقط سقف است.
- مسیرِ PostgreSQL را آزمون‌های `settlement-runtime` پوشش می‌دهند؛ میزبان خودش پایگاه نمی‌شناسد (آزمونِ pg ندارد).
- `graceMs` هنوز باید دستی با `createDurableLedger` یکی باشد (ADR-0023). فقط لینوکس + Node ۲۲. CI گیت‌هاب را نمی‌بینم؛ تگِ `green/<slug>` (G9) را نزدم.

## تأیید لازم از شما
۱) **معماری:** ثبتِ ماژولِ `settlement-host` در `registry.ts` و `HIGH_RISK_MODULES` (ADR-0032 تصمیم ۱)، و تقسیمِ م۳‑ه‑۳ به الف/ب. ۲) **مالی/معماری:** سه پروبِ جدا و نگاشتِ `degraded⇒۲۰۰، down⇒۵۰۳` (ادامهٔ ۰۰۳۰/۰۰۳۱)؛ `startup` چسبنده؛ بازتلاشِ فقط‌گذرا. ۳) **امنیت/مالی:** `closeResources` فقط پس از توقفِ تمیز و `exit(ok?0:1)`. ۴) پاسخ به پرسشِ بازِ Next (برش ب): `NEXT_MANUAL_SIG_HANDLE` + بستنِ سرور توسط خودمان، یا پذیرشِ رقابت.

## گام بعد (پیشنهاد)
۱) **م۳‑ه‑۳‑ب:** اتصال به `src/app`: `instrumentation.ts` (`register()` ← `createPgSettlementRuntime` + `acquireSettlementHost(globalThis, …)` + `migrate()` صریح فقط در دیپلوی نه در بوت)، `/api/health` با `probeSettlementHost(globalThis, "ready"|"live"|"startup")` — **بدونِ شکستنِ `build_and_start`** (پروبِ فعلی `select 1` باید تا تصمیمِ مالک `live`ِ بدونِ وابستگی به پایگاه بماند یا ترکیب شود) — و دودیِ فرایندِ واقعی `next start` با SIGTERM برای حلِ رقابتِ بالا. ۲) **م۳‑ه‑۴:** `deliver`ِ واقعی (کانالِ اعلامِ مرده‌ها) و پایشِ پسماند در `health`. ۳) سپس م۲ (هویت) و م۴ (خرید).

## پچ‌ها
`git format-patch -N 3743f39..HEAD` (چهار پچ؛ چهارمی همین یادداشت) + bundle (تگ `pre-risk/20261122-settlement-host`) در Gofile (`SHA256SUMS` کنار پچ‌ها). اعمال: `git clone https://github.com/madibary91-ctrl/Pdf && cd Pdf && git checkout 3743f39 && git tag -a pre-risk/20261122-settlement-host -m "…" && git am /path/000*.patch`، یا `git pull <bundle> main`. `git am` هوک‌ها را اجرا نمی‌کند.
