# یادداشت تحویل ۰۰۷۴ — `tool-policy-host`: میزبانِ فرایندیِ سیاستِ ابزار (CT‑5c‑2c‑2b‑3)

**کامیت پایه:** `b4d6a14` (`main`؛ تحویل ۰۰۷۳). مخزن: `madibary91-ctrl/Pdf`. به مخزن پوش **نکرده‌ام** (اعتبارنامهٔ نوشتن ندارم)؛ پچ‌ها و bundle در Gofile (پیوند و SHA-256 در متنِ پاسخِ تحویل).
تگِ پیش‌ازریسک: `pre-risk/20261218-tool-policy-host` (حاشیه‌دار، روی `b4d6a14`، **پیش از اولین ویرایش**). کامیت‌ها: `feat(tool-policy-host)` (ماژول + آزمون‌ها + ADR‑0075/task 0072/README/registry/ریسک/known-pitfalls + آزمونِ PG + اسکریپتِ جهش)، `chore(ci)` (کف 8072 → 8343؛ `Risk-Tag`)، و همین یادداشت.

## ۱) چرا این برش (تصمیم من) و سازمان‌دهیِ نوبت
از «گام بعد»ِ ۰۰۷۳ (2b‑2 سیم‌کشیِ `projection`، **میزبانِ فرایندی**، CLIِ مهاجرت، `identity`، …) میزبانِ فرایندی را برداشتم: ۰۰۷۳ خودش آن را پیش‌نیازِ هر بازتلاشِ `start` معرفی کرد، و بدونِ آن ریشهٔ سیاست هیچ چرخهٔ عمرِ فرایندی ندارد (سیگنال، پروب، بوتِ شکست‌بسته). 2b‑2 به ساختارِ دروازه می‌خورد و CLIِ مهاجرت به تصمیمِ نقشِ پایگاه؛ هیچ‌کدام در یک نوبتِ ≈۵۰دقیقه‌ای با جهش‌آزمایی نمی‌گنجید. اتصال به `src/app` را عمداً **جدا** گذاشتم (برشِ بعدی): این برش فقط ماژولِ بی‌I/Oِ آزموده است.
**ترتیب:** کلون و خواندنِ ۰۰۷۳/۰۰۷۲ و `settlement-host` (الگو) ← تگ ← کد ← آزمون (واحد، یکپارچه با ریشهٔ واقعی، PG واقعی) ← جهش‌آزمایی ← مستند ← `tsc`/`eslint` ← **دروازهٔ کامل یک بار** ← کف ← کامیت ← پچ/bundle ← اثباتِ پچ روی کلونِ تازه.

## ۲) چه ساخته شد (فقط افزودن)
- `src/modules/tool-policy-host/` (لایهٔ ۸، `humanReview:true`، `dependsOn:[tool-policy-runtime, settlement-host]`): `createToolPolicyHost`، `acquireToolPolicyHost/getToolPolicyHost/probeToolPolicyHost`، `evaluateProbe`، `TOOL_POLICY_HOST_LIMITS`، `TOOL_POLICY_HOST_STORE_KEY`. شش فایلِ منبع (`config/host/index/probes/singleton/types`) — بی‌`process`/`Date`/`setTimeout`.
- **نکتهٔ طراحی (چرا کپیِ `settlement-host` نشد):** قراردادِ دو ریشه فرق دارد — `start()` در سیاست `{started, reason}` است (بی‌`atMs`/`code`)، `stop()` همان `{stopped, abandonedInFlight}` (نه `{clean}`)، `health()` همان `{state, ready, reason}` (نه `{health:{status}, httpStatus}`)، و **`start` نخستین تازه‌سازی را منتظر نمی‌ماند**. پس: `ready` فقط با `state==="RUNNING" ∧ ready===true ∧ reason===null`؛ `startup` چسبنده از نخستین آمادگی (نه از «`start` موفق»)؛ توقفِ تمیز فقط `stopped===true ∧ abandonedInFlight===false`؛ بازتلاش فقط `UNAVAILABLE`؛ شکلِ قدیمیِ تسویه (`PREFLIGHT_FAILED`, `{clean:true}`) **پذیرفته نمی‌شود** (آزمون). تفصیلِ ده تصمیم در ADR‑0075.
- registry (یک سطر)، `HIGH_RISK_MODULES`، `docs/high-risk-areas.md`، `docs/known-pitfalls.md` (یک سطر)، ADR‑0075، task 0072، README، `tooling/mutation/tool-policy-host.py` (۷۶ جهش).
- **۲۷۱ آزمونِ تازه** (کف 8072 → **8343**): ماژول ۲۶۶ — `config` ۸۰ (از الگوی `settlement-host` با نام‌های تازه؛ بی‌لمسِ آزمونِ موجود)، `probes` ۴۹، `host` ۷۵ (بوت، بازتلاش، «بوت≠آماده»، خاموشی، مهلت، سیگنال، پورتِ خصمانه، بی‌نشتِ CANARY)، `singleton` ۴۴، `integration` ۷ (با `createToolPolicyRuntime` **واقعی** و پورت‌های ساختگی: اگر ریشه نام/معنای دلیل را عوض کند قرمز می‌شود)، `purity` ۱۱؛ و **۵ آزمونِ PostgreSQL واقعی** (`tooling/tool-policy-host.pg.test.ts`: مهاجرت‌نشده ⇒ `NOT_MIGRATED` بی‌بازتلاش و بی‌حلقه و بی‌جدول؛ تریگرِ خاموش ⇒ `SCHEMA_MISMATCH`؛ پایگاهِ سالم: running ← ready/startup ← خاموشیِ مرتب، ریشه/میزبان هرگز نمی‌نویسند؛ جدولِ `ACCESS EXCLUSIVE` قفل‌شده ⇒ تلاشِ نخست `UNAVAILABLE` با مهلتِ پایگاه، بازتلاش، بالا آمدن پس از رهاسازی؛ همان بی‌بازتلاش ⇒ `UNAVAILABLE` و ready ۵۰۳). پنج بار پشتِ‌سرهم سبز.

## ۳) تغییر در تست‌های موجود
**هیچ.** `Test-Change-Approved` لازم نبود. فقط افزودنِ فایل؛ تنها فایل‌های موجودِ تغییرکرده: `registry.ts` (یک سطر)، `git-discipline.ts` (یک عنصر در `HIGH_RISK_MODULES`)، `ci-tests.ts` (فقط `MIN_PASSED_TESTS`) و سه سند.

## ۴) راستی‌آزمایی و یافته‌های واقعی
1. **جهش‌آزمایی: ۷۶ جهش، هیچ بازمانده‌ای نیست.** دورِ اول ۵ زنده‌مانده که **همه آزمونِ ناقصِ خودم بودند** (کدِ زائد/هم‌ارز نبود): (الف) `started` غیرِ بولی با دلیلِ معتبر (`{started:"no", reason:"NOT_MIGRATED"}`) پذیرفته می‌شد؛ (ب) `ok` مهلت‌گذشته را نادیده می‌گرفت — حالتِ «stop تمیز، بی‌`closeResources`، بوتِ آویزان» آزموده نشده بود؛ (ج) `ok` توقفِ ناتمیزِ بی‌`closeResources` را نادیده می‌گرفت؛ (د،ه) `isHost` میزبانِ بی‌`startup`/بی‌`status` را می‌پذیرفت. هر پنج با آزمونِ تازه گرفته شدند؛ دورِ دوم روی همان پنج جهش: همه کشته. دو مورد (ب،ج) نشان می‌دهد سه‌شرطیِ `ok` واقعاً هر سه شرط را لازم دارد.
2. **دروازهٔ کامل `node tooling/ci-tests.ts`** (PG محلی، Node 22، Linux): **۳۲۹ فایل، ۸۳۴۳ سبز، ۰ شکست، ۰ ردشده، ۱۶ todo** (اجرای اول؛ بدونِ تکرار و بدونِ شکستِ `regclass.cold` که در ۰۰۷۱–۰۰۷۳ دیده بودم). `tsc --noEmit` و ESLint روی فایل‌های تازه و فایل‌های تغییرکرده تمیز. «CI گیت‌هاب سبز» را ادعا نمی‌کنم (CI را نمی‌بینم). `ERR_IPC_CHANNEL_CLOSED`/`gate-floor`/`schema-ensure-key-parity` ویندوز طبق دستور دست‌نخورده.
3. **یک اشتباهِ خودم، پیش از اجرا:** هنگامِ افزودنِ سطرِ registry با اسکریپتِ پایتون، کوتیشن‌ها دوبار escape شدند و `registry.ts` از نظرِ نحوی شکست (`tsc`/ESLint فوراً گرفتند؛ قبل از کامیت رفع شد). هیچ کامیتِ قرمزی ساخته نشد.
4. **`check-range b4d6a14..HEAD`:** قالبِ پیامِ هر سه کامیت می‌خواند. اثباتِ پچ (G13): روی کلونِ تازهٔ `b4d6a14` با `git am` اعمال شد؛ نتیجه (hash درخت، `tsc`، دروازه) در متنِ پاسخ.

## ۵) انحراف‌ها و محدودیت‌های صادقانه
1. **به محصول وصل نیست:** `src/app`، `instrumentation`، `/api/health/{live,startup,ready}` برای سیاست، `projection` به دروازه، `requestId`، لاگِ رزرو. بازبینیِ انسانیِ مالکِ امنیت (`host.ts`، `probes.ts`) انجام نشده.
2. **`boot()` نخستین تازه‌سازی را منتظر نمی‌ماند.** بوتِ منتظر (تا `ready`) به تایمرِ دوم و تصمیمِ «اگر نرسید ریشهٔ نیمه‌روشن چه شود» نیاز دارد؛ جایگزینِ پذیرفته‌شده: `startup` از نخستین آمادگیِ دیده‌شده چسبنده است و ترافیک فقط با `ready` می‌آید. اگر ترجیح می‌دهید `boot()` منتظر بماند، تصمیمِ مالک است (ADR‑0075 بند ۵).
3. **چسباندنِ `startup` به خودِ پروب‌ها وابسته است** (بی‌پایش): اگر هیچ‌کس پروب نزند، `hasBeenReady` همچنان `false` می‌ماند (در K8s پروبِ startup دوره‌ای است؛ پس عملاً مشکلی نیست، ولی `status().hasBeenReady` را «زنده» ندانید).
4. **وابستگیِ نوعی به `settlement-host`** (جفت‌شدن با دامنهٔ دیگر؛ فقط نوع‌ها، آداپتورِ `process` بازصادر نمی‌شود). استخراجِ نوع‌های مشترکِ فرایندی تصمیمِ معماری است؛ نکردم.
5. **`snapshot()` را میزبان عبور نمی‌دهد** (مسیرِ داغ مستقیم از `runtime.snapshot()`). **Next ۱۶ روی SIGTERM خودش `process.exit` می‌زند** (همان محدودیتِ `settlement-host`)؛ «بستنِ استخر» تضمین نیست تا اجرای واقعی در برشِ اتصال.
6. هوک‌های گیت نصب نشد؛ `check-range` دستی. موارد بازِ ۰۰۴۶–۰۰۷۳ و تصمیم‌های معلق **دست‌نخورده**.

## تأیید لازم از شما
۱) کفِ 8343 پس از دیدنِ CI لینوکس؛ ۲) ADR‑0075 به‌ویژه بند ۴–۵ («بوت≠آماده»، `startup` چسبنده، بوتِ غیرمنتظر) و بند ۲ (وابستگیِ نوعی به `settlement-host`)؛ ۳) بازبینیِ انسانیِ مالکِ امنیت: `host.ts` و `probes.ts`؛ ۴) همچنان معلق از ۰۰۷۰: `Test-Change-Approved` برای `9f3ff8b`.

## گام بعد (تصمیم من)
۱) **اتصالِ میزبانِ سیاست به برنامه** (`policy-bootstrap` الگوی `settlement-bootstrap`: `instrumentation`، سیاستِ env شکست‌بسته با پیش‌فرضِ خاموش، `/api/health/policy/{live,startup,ready}`، `connectionTimeoutMillis` استخر). ۲) **CT‑5c‑2c‑2b‑2:** سیم‌کشیِ `snapshot().projection` به زنجیرهٔ دروازه، `requestId`، `version` در لاگِ رزرو. ۳) 2c‑3: CLIِ `migrate/status` + نقشِ مهاجرتِ جدا + مهلتِ `migrate()`. ۴) `identity`. ۵) `LATE_AFTER_CLOSE`/مغایرت‌گیری. ۶) استخراجِ تسویهٔ مشترک و نوع‌های فرایندیِ مشترک. ۷) `Answer.reviewPending`. ۸) تطبیقِ عدد. ۹) CT‑3c‑2.

## پچ‌ها
`git format-patch b4d6a14..HEAD` (سه پچ) + bundle (تگ `pre-risk/20261218-tool-policy-host`) در Gofile (`SHA256SUMS` کنار پچ‌ها). اعمال: `git checkout b4d6a14 && git am /path/000*.patch`، یا `git pull <bundle> main`. `git am` هوک‌ها را اجرا نمی‌کند.
