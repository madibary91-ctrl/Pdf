# یادداشت تحویل ۰۰۳۳ — settlement‑bootstrap م۳‑ه‑۳‑ب: مرزِ برنامهٔ رفتگرِ تسویه (`startSettlementBootstrap` + `instrumentation` + پروب‌های HTTP)

**کامیت پایه:** `300b1ef` (شاخهٔ `main`؛ تحویل ۰۰۳۲، ۳۷۸۲ تست؛ همان کامیتی که مالک گزارش کرد اعمال و پوش شده). مخزن: `madibary91-ctrl/Pdf`. کلون تازه، `npm install --no-package-lock` و `node tooling/git-discipline.ts install` انجام شد. به مخزن پوش **نکرده‌ام** (اعتبارنامهٔ نوشتن ندارم)؛ پچ‌ها و bundle در Gofile (پیوند در پاسخ تحویل).

## ۱) چرا این برش (تصمیم من)
یادداشت ۰۰۳۲ «م۳‑ه‑۳‑ب» را گام بعد گذاشته بود و دو چیز را عمداً باز گذاشته بود: رقابتِ SIGTERM با Next («تصمیمِ نهایی با اجرای واقعی») و سرنوشتِ `/api/health`. تا این اتصال نباشد، رفتگر و میزبانِ ساخته‌شده هیچ اثری در سامانهٔ واقعی ندارند؛ پس این کم‌هزینه‌ترین گامی است که معماری را واقعاً «به هم وصل» می‌کند و دو ریسکِ مجهول را با آزمایشِ واقعی می‌بندد. برشِ بزرگ‌تر (م۳‑ه‑۴ `deliver`ِ واقعی، یا م۲ هویت) را عمداً شروع نکردم؛ یک برش، بالاترین کیفیت.

## ۲) آزمایشِ واقعیِ پیش از طراحی (یافتهٔ اصلی)
`next start` ۱۶٫۴٫۲ + میزبانِ واقعی (`runtime.stop` ساختگی ۳ ثانیه) + `kill -TERM`:
- **پیش‌فرض:** `shutdown.started` ← `runtime.stop begin` ← **فرایند با ۱۴۳ می‌میرد پیش از `stop end`/`closeResources`.** رقابت واقعی است و Next همیشه برد.
- **`NEXT_MANUAL_SIG_HANDLE=1`:** `stop end` ← `closeResources` ← `shutdown.finished(ok)` ← `exit(0)`.
- `register()` در `next build` اجرا **نمی‌شود**؛ در `next start` **پس از** «Ready» اجرا می‌شود.
- Next قلابِ رسمیِ خاموشیِ سرور یا دسترسی به `http.Server` نمی‌دهد ⇒ نمی‌شود هم drainِ HTTPِ Next و هم خاموشیِ ناهمگامِ ما را تضمین کرد.

## ۳) چه ساخته شد
**ماژولِ جدید `src/modules/settlement-bootstrap/`** (لایه ۷، `humanReview:true`؛ وابسته به `settlement-host` و `settlement-runtime`):
- **`parseBootstrapEnv`** (خالص): `SETTLEMENT_HOST` نبودن/خالی/`off` ⇒ خاموش؛ فقط دقیقاً `on` ⇒ روشن؛ هر چیزِ دیگر (`ON`، `true`، `1`، فاصله) **خطا** نه حدس. `SETTLEMENT_GRACE_MS` الزامی و بی‌پیش‌فرض؛ اعداد فقط رقمِ لاتینِ مثبت؛ با `on` هر `SETTLEMENT_*`ِ ناشناخته خطا (غلط‌یابِ نام)؛ هیچ مقداری در پیام نمی‌آید.
- **`startSettlementBootstrap`**: هرگز نمی‌پرتابد/رد نمی‌شود. خاموش ⇒ هیچ (نه پایگاه، نه میزبان، نه سیگنال). روشن ⇒ پایگاهِ **تنبل** ← `createPgSettlementRuntime` (`deadLetters:false` صریح) ← `createSettlementHost` ← singleton ← **بوتِ بی‌انتظار** (پایگاهِ کُند راه‌اندازیِ سرور را نگه نمی‌دارد). هم‌زمانیِ دو register ⇒ یک پایگاه (نشانگرِ in‑flight روی ظرف)؛ مسابقهٔ دو بسته‌بندی ⇒ پایگاهِ اضافه بسته؛ هر شکستِ سازه‌ای پایگاه را می‌بندد و چیزی ذخیره نمی‌کند. خطای پایگاه (ممکن است رشتهٔ اتصال داشته باشد) هرگز به `issues`/لاگ نمی‌رسد (بی‌`catch (e)`/`.message`، با نگهبانِ منبع).
- **`processOwner: "host"|"next"`** (پاسخ به پرسشِ بازِ ۰۰۳۲): `host` ⇒ `exit(ok?0:1)` پس از خاموشیِ مرتب؛ `next` ⇒ **هرگز exit** (دو `exit` رقیب نمی‌خواهیم؛ آزمون قفل کرده). گلو آن را از درستیِ رشتهٔ `NEXT_MANUAL_SIG_HANDLE` می‌خواند (همان شرطِ Next).
- **`probeHttpResponse(store, kind)`** ⇒ `Response` استاندارد: `no-store`، بدنهٔ بسته `{probe, ok, state, sweep}`، هرگز نمی‌پرتابد؛ kindِ ناشناخته/میزبانِ خراب ⇒ ۵۰۳ ثابت.
**گلو (بی‌منطق):** `src/instrumentation.ts` (فقط runtime `nodejs` و نه `phase-production-build`)، `src/instrumentation-node.ts` (`process.env`/`globalThis`/`console`/`@/db` را به ماژول می‌دهد)، `src/app/api/health/{live,startup,ready}/route.ts` (هرکدام یک خط، `force-dynamic`). **`/api/health` اصلی دست‌نخورده** (`select 1`؛ قراردادِ `build_and_start`) و با آزمون قفل شد.
**ابزار:** `tooling/mutation/settlement-bootstrap.py` (۵۳ جهش)، `tooling/smoke/settlement-next.mjs` (دودیِ فرایندِ واقعی، خارج از دروازه)، `tooling/smoke/settlement-migrate.ts` (مهاجرتِ صریح با `vite-node`؛ موقتی تا CLIِ رسمی).
**مستندات:** ADR-0033، task 0031، README ماژول (جدولِ env)، ردیفِ `docs/high-risk-areas.md`، `known-pitfalls.md` (۵ ردیف)، ثبت در `registry.ts` و `HIGH_RISK_MODULES`، و قاعدهٔ `^src/instrumentation[^/]*\.ts$` در `HIGH_RISK` (آزمونِ همگامیِ موجود بدونِ آن قرمز می‌شد؛ تغییرِ کدِ ابزار نه آزمون).

## ۴) تغییر در تست‌های موجود — **هیچ**
`git diff --name-status 300b1ef..HEAD -- '*.test.ts'`: **هشت `A`، صفر `M`/`D`**. هیچ `Test-Change-Approved` لازم نشد. هیچ ماژولِ موجود (`settlement-host`، `settlement-runtime`، `settlement`، `ledger`، `metering`)، `src/db`، `package.json`، `next.config.ts` و `src/app/api/health/route.ts` دست نخورد. فایل‌های غیرِ جدید که تغییر کردند: `registry.ts` (یک ردیف)، `tooling/git-discipline.ts` (یک نام + یک regex)، `tooling/ci-tests.ts` (کف)، `docs/high-risk-areas.md` (یک ردیف)، `docs/known-pitfalls.md` (افزودن).

## ۵) راستی‌آزمایی (PostgreSQL ۱۵ واقعی، Node 22.23)
- **پایه پیش از شروع:** دروازهٔ صفر-رد روی `300b1ef` سبز: ۳۷۸۲. تگِ `pre-risk/20261119-settlement-bootstrap` پیش از اولین ویرایش زده شد.
- **پس از برش:** دروازهٔ صفر-رد **۳۹۴۲ سبز، ۰ رد، ۰ شکست، ۱۶ todo** (۳۷۸۲ + ۱۶۰؛ ۱۴۲ فایل). `tsc`، `eslint .`، `npm run build` سبز. کفِ `MIN_PASSED_TESTS`: ۳۷۸۲ ← ۳۹۴۲ (کامیتِ جدا با `Risk-Tag`). هوکِ pre-commit دروازه را روی هر دو کامیتِ کد اجرا کرد.
- **دودیِ فرایندِ واقعی (`next start` + PostgreSQL + SIGTERM): ۲۷/۲۷ سبز.** A پیش‌فرض خاموش (`/api/health` ۲۰۰، live ۲۰۰، startup/ready ۵۰۳ absent، SIGTERM ⇒ ۱۴۳)؛ B روشنِ مهاجرت‌شده با Next صاحبِ خروج (ready ۲۰۰ با بدنهٔ بسته، SIGTERM ⇒ ۱۴۳؛ رقابتِ مستند)؛ C با `NEXT_MANUAL_SIG_HANDLE=1` (خاموشیِ مرتب: `ok/clean/closed:ok`، خروج ۰)؛ D مهاجرت‌نشده (`NOT_MIGRATED`، بی‌بازتلاش حتی با ۳ تلاش، سرور بالا و `/api/health` ۲۰۰، خروج ۰)؛ E `SETTLEMENT_HOST=ON` ⇒ `INVALID_ENV`؛ در همهٔ سناریوها گذرواژهٔ پایگاه در لاگ نیست.
- **جهشی:** ۵۳ جهش، **۵۳ کشته، زندهٔ توضیح‌نشده ۰** (اجرای نهایی روی کدِ کامیت‌شده؛ نتیجه در پاسخِ تحویل).
- **ضعف‌هایی که حین کار پیدا و رفع کردم:** (الف) نخستین جهش‌ها یک زنده داشتند: فریزِ `issues` در شکستِ env؛ آزمونِ تازه گرفت. (ب) `tsc`/`next build` سه خطای تایپ را در آزمون/گلو گرفت (که `vitest` نمی‌گیرد) و رفع شد. (ج) هوکِ بهداشتِ گیت رشتهٔ اتصالِ دارای قناری را در آزمون‌ها `[secret]` دید؛ به `SECRET_URL` قطعه‌قطعه تغییر کرد. (د) آزمونِ همگامیِ `HIGH_RISK` برای `src/instrumentation*.ts` قرمز شد؛ regex اضافه شد. (ه) `.env.example` را ساختم ولی `.gitignore` (`.env*`) آن را می‌پوشاند؛ به‌جای دورزدن، جدولِ متغیرها را در README گذاشتم و pitfall ثبت کردم.

## ۶) انحراف‌ها و نکته‌ها (برای بازبینی)
1. **ماژولِ جدا به‌جای افزودن به `settlement-host`:** نگهبانِ منبعِ host فهرستِ فایل/صادرات را قفل و `env`/`import()`/`globalThis` را ممنوع کرده بود؛ تغییرش `Test-Change-Approved` می‌خواست و host باید از Next بی‌خبر بماند. هزینه: یک ردیفِ دیگر در registry.
2. **`/api/health` عمداً تغییر نکرد** (پاسخِ پیشنهادیِ من به پرسشِ بازِ ۰۰۳۱): پلتفرم به `select 1` تکیه دارد و پایگاهِ مهاجرت‌نشده نباید آن را ۵۰۳ کند. orchestrator از `live/startup/ready` استفاده کند.
3. **پیش‌فرضِ خاموش:** بدونِ `SETTLEMENT_HOST=on` هیچ اثری در اجرا نیست (آزمونِ «پیش‌فرضِ واقعی» با ماژولِ واقعی). روشن‌بودنِ پیش‌فرض `build_and_start` را روی پایگاهِ مهاجرت‌نشده می‌شکست.
4. **`package.json`/اسکریپتِ `start` را عوض نکردم** (تغییرِ رفتارِ استقرار؛ `NEXT_MANUAL_SIG_HANDLE=1 next start` POSIX است). توصیه‌ام برای تولید پشتِ orchestratorی که با `ready` ترافیک را برمی‌دارد: `NEXT_MANUAL_SIG_HANDLE=1`.
5. **`deadLetters:false`** سخت‌کد و با آزمون قفل است تا با آمدنِ `deliver` (م۳‑ه‑۴) آگاهانه عوض شود. `graceMs` از env و الزامی است (دفترِ محصول در برنامه هنوز نیست).
6. **`vite-node` در `tooling/smoke`** وابستگیِ تراگذرِ `vitest` است نه اعلام‌شده؛ فقط ابزارِ دستیِ موقتی است و وابستگیِ تازه به `package.json` اضافه نشد (AGENTS بند ۸).
7. ساخت و اجرای محلی با `npm install --no-package-lock` (مخزن `pnpm` می‌خواهد؛ `pnpm-lock.yaml` دست نخورد). اگر تفاوتی مشکوک است در CI با pnpm هم تأیید شود. هویتِ گیت فقط در همین کلون `Sonnet <sonnet@example.invalid>`.
8. بازبینیِ انسانیِ مالکِ معماری و امنیت/مالی انجام نشده است (`settlement-bootstrap` و گلوی `instrumentation` ناحیهٔ پرریسک‌اند).

## محدودیت‌های صادقانه
- حالتِ `host` درخواست‌های HTTPِ در جریان را می‌بُرد؛ حالتِ `next` خاموشیِ ما را ناتمام می‌گذارد (ایمن، بی‌ضمانتِ بستنِ استخر). هر دو مستند و با دودی سنجیده شدند؛ **تصمیمِ نهایی استقرار با مالک است.**
- drainِ مرحله‌ای (فاصله میانِ ۵۰۳ شدنِ `ready` و توقف) نیست. فقط runtime «nodejs». فقط لینوکس + Node ۲۲.
- دودیِ فرایند جزو دروازهٔ CI نیست (ساخت و پورت می‌خواهد)؛ دستی اجرا و در همین یادداشت گزارش شد. CI گیت‌هاب را نمی‌بینم؛ تگِ `green/<slug>` (G9) را نزدم.
- مهاجرتِ رسمی (CLI) هنوز نیست؛ `tooling/smoke/settlement-migrate.ts` موقتی است.
- مسیرِ `deliver` و پایشِ پسماندِ زنگ هنوز نیست؛ دفترِ محصول (`createDurableLedger`) هنوز به برنامه وصل نیست، پس رفتگر عملاً روی دفترِ خالی می‌دود.

## تأیید لازم از شما
۱) **معماری:** ثبتِ `settlement-bootstrap` در `registry.ts` و `HIGH_RISK_MODULES`؛ قاعدهٔ `src/instrumentation*.ts` در `HIGH_RISK`. ۲) **امنیت/مالی:** سیاستِ env (پیش‌فرضِ خاموش، فقط `on` دقیق، بی‌پیش‌فرضِ `graceMs`، غلط‌یابِ نام)، بی‌نشتِ پیامِ خطای پایگاه. ۳) **معماری/استقرار:** انتخابِ حالتِ خروج (`NEXT_MANUAL_SIG_HANDLE=1` توصیه‌شده یا پذیرشِ رقابت) و اینکه `/api/health` اصلی همان `select 1` بماند. ۴) **عملیات:** آیا اسکریپتِ `start`/Dockerfile باید `NEXT_MANUAL_SIG_HANDLE=1` را بگذارد (کارِ جدا).

## گام بعد (پیشنهاد)
۱) **م۳‑ه‑۳‑ج:** CLIِ رسمیِ مهاجرتِ زمانِ استقرار (آزموده، `tooling/` یا ماژول) با بازبینیِ ترتیب (دفتر ← outbox) و خروجِ کدِ بسته؛ جایگزینِ `tooling/smoke/settlement-migrate.ts`. ۲) **م۳‑ه‑۴:** `deliver`ِ واقعی (کانالِ اعلامِ مرده‌ها) و پایشِ پسماند در `health`. ۳) سپس اتصالِ دفترِ محصول/metering به برنامه (تا رفتگر روی داده‌ی واقعی بدود)، م۲ (هویت) و م۴ (خرید).

## پچ‌ها
`git format-patch -N 300b1ef..HEAD` (چهار پچ؛ چهارمی همین یادداشت) + bundle (تگ `pre-risk/20261119-settlement-bootstrap`) در Gofile (`SHA256SUMS` کنار پچ‌ها). اعمال: `git clone https://github.com/madibary91-ctrl/Pdf && cd Pdf && git checkout 300b1ef && git tag -a pre-risk/20261119-settlement-bootstrap -m "…" && git am /path/000*.patch`، یا `git pull <bundle> main`. `git am` هوک‌ها را اجرا نمی‌کند.
