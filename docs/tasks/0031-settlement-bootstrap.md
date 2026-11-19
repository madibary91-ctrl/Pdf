# settlement‑bootstrap م۳‑ه‑۳‑ب: مرزِ برنامهٔ رفتگرِ تسویه

## هدف (یک جمله)
رفتگرِ تسویه را با سیاستِ شکست‌بستهٔ env (پیش‌فرض خاموش)، بوتِ بی‌مسدودی، صاحبِ خروجِ فرایندِ تعیین‌شده با اجرای واقعی و سه مسیرِ پروبِ HTTP به برنامهٔ Next وصل کند، بی‌آنکه `/api/health` فعلی یا هیچ آزمونِ موجود تغییر کند.

## زمینه
ADR-0032 «گام بعد ۱»، تحویل ۰۰۳۲ و ADR-0033.

## ماژول و پوشه‌های مجاز
`src/modules/settlement-bootstrap/` (جدید)، `src/instrumentation.ts` و `src/instrumentation-node.ts` (گلوی نازک، جدید)، `src/app/api/health/{live,startup,ready}/route.ts` (جدید)، `src/modules/registry.ts` (یک ردیف)، `tooling/git-discipline.ts` (`HIGH_RISK_MODULES`)، `tooling/ci-tests.ts` (کف)، `tooling/mutation/settlement-bootstrap.py`، `tooling/smoke/` (جدید)، `docs/`.

## ممنوع
تغییر هر ماژولِ موجود (`settlement-host`، `settlement-runtime`، `settlement`، `ledger`، `metering`)، `src/app/api/health/route.ts`، `package.json`، `next.config.ts`، `src/db`، و **هر آزمونِ موجود** (بدون `Test-Change-Approved`). مهاجرت در بوت؛ `process`/`globalThis`/`console`/`env` درونِ ماژول؛ روشن‌بودنِ پیش‌فرض.

## قرارداد
افزایشی: `startSettlementBootstrap(raw)`، `parseBootstrapEnv(env)`، `probeHttpResponse(store, kind)`، `SETTLEMENT_BOOTSTRAP_ENV` و نوع‌ها. متغیرهای محیط: `SETTLEMENT_HOST`، `SETTLEMENT_GRACE_MS` (الزامی با on)، `SETTLEMENT_SHUTDOWN_TIMEOUT_MS`، `SETTLEMENT_BOOT_ATTEMPTS`، `SETTLEMENT_BOOT_RETRY_DELAY_MS`، `SETTLEMENT_LEDGER_SCHEMA`، `SETTLEMENT_OUTBOX_SCHEMA`.

## معیار پذیرش
1. env: نبودن/خالی/off خاموش؛ فقط دقیقاً `on` روشن؛ هر مقدارِ دیگر خطا (جدول + خاصیتیِ ۲۰۰۰ نمونه)؛ `graceMs` الزامی و بی‌پیش‌فرض؛ اعدادِ لاتینِ مثبت و مرزها؛ غلط‌یابِ نام؛ بی‌نشتِ مقدار؛ بی‌پرتاب (Proxy، getterِ دو‌چهره).
2. خاموش: پایگاه باز نمی‌شود، میزبان/سیگنالی نیست. نامعتبر: `INVALID_ENV` و پایگاه باز نمی‌شود.
3. روشن: پایگاه یک بار (تنبل)، singleton، بوت بی‌انتظار (حتی با پایگاهِ آویزان)، بازتلاشِ گذرا فقط `UNAVAILABLE`، `NOT_MIGRATED` هرگز.
4. شکست‌های سازه‌ای: پایگاه بسته، چیزی ذخیره نمی‌شود، بی‌نشتِ پیامِ خطا؛ مقدارِ بیگانه/ظرفِ فریز ⇒ `STORE_INVALID`؛ مسابقهٔ دو بسته‌بندی؛ هم‌زمانیِ دو register.
5. صاحبِ خروج: `host` ⇒ `exit(0|1)` پس از خاموشیِ مرتب؛ `next` ⇒ هرگز `exit`؛ سیگنالِ **واقعی** (SIGTERM به خودِ process) در یک آزمونِ صریح.
6. PostgreSQL واقعی: مهاجرت‌شده ⇒ running/ready ۲۰۰ و خاموشیِ تمیز با بسته‌شدنِ استخر؛ مهاجرت‌نشده ⇒ `NOT_MIGRATED` بی‌بازتلاش و بی‌ساختنِ شِما؛ پایگاهِ قطع ⇒ `UNAVAILABLE`.
7. HTTP: بدنهٔ بسته، `no-store`، kindِ ناشناخته/میزبانِ خراب ⇒ ۵۰۳؛ مسیرهای `force-dynamic`؛ `/api/health` اصلی دست‌نخورده.
8. گلو: `register` فقط در nodejs و نه در ساخت؛ ترکیبِ Node: ورودی‌های دقیق، پایگاهِ تنبل، مالکِ خروج از `NEXT_MANUAL_SIG_HANDLE`، لاگ JSON؛ پیش‌فرضِ واقعی هیچ نمی‌سازد.
9. دودیِ فرایندِ واقعی (`tooling/smoke/settlement-next.mjs`): سناریوهای A تا E سبز.
10. نگهبانِ منبع؛ جهشی بی‌زندهٔ توضیح‌نشده؛ دروازهٔ صفر-رد سبز و کف بالا؛ هیچ آزمونِ موجودی تغییر نکند.

## تست‌های مورد انتظار
جدولی، خاصیتی، بدجنس (Proxy/getter/thenable)، مسابقه، PostgreSQL واقعی، سیگنالِ واقعی، نگهبانِ منبع، جهشی، دودیِ فرایند.

## خارج از کار
`deliver`ِ واقعی و پایشِ پسماند (م۳‑ه‑۴)، CLIِ رسمیِ مهاجرت، drainِ مرحله‌ای، تغییرِ اسکریپتِ `start`، دفترِ محصولِ واقعی در برنامه، `status:done` در registry.

## وابستگی‌ها
ADR-0031/0032/0033؛ تحویل ۰۰۳۲.

## بازبینی و ریسک
**بله.** پول + registry + فرایند. تگ `pre-risk/20261119-settlement-bootstrap` روی HEAD سبز (۳۷۸۲ تست) پیش از اولین ویرایش؛ کامیت‌های کد `Risk-Tag` دارند.
