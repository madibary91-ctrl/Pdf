# settlement‑host م۳‑ه‑۳‑الف: میزبانِ فرایندیِ رفتگرِ تسویه

## هدف (یک جمله)
چرخهٔ عمرِ فرایندیِ یک `SettlementRuntime` (singleton، بوتِ شکست‌بسته با بازتلاشِ فقط‌گذرا، خاموشیِ مرتب و مهلت‌دار روی `SIGTERM`/`SIGINT`، و سه پروبِ `live/startup/ready` جدا) را بدونِ هیچ وابستگی به Next بسازد و بیازماید.

## زمینه
تحویل ۰۰۳۱ «گام بعد ۱»، ADR-0031 تصمیم ۲ (م۳‑ه‑۳) و ADR-0032.

## ماژول و پوشه‌های مجاز
فقط `src/modules/settlement-host/` (جدید) + `src/modules/registry.ts` (یک ردیف)، `tooling/git-discipline.ts` (`HIGH_RISK_MODULES`)، `tooling/ci-tests.ts` (کف)، `docs/` و `tooling/mutation/settlement-host.py`.

## ممنوع
تغییر هر ماژولِ موجود (`settlement-runtime`، `settlement`، `ledger`، `metering`)، `src/app`، `/api/health`، `instrumentation.ts`، `next.config.ts`، `package.json`، و **هر آزمونِ موجود** (بدون استثنا؛ این برش `Test-Change-Approved` نمی‌خواهد). ساختنِ اتصال/استخر، مهاجرت، `process.exit` مستقیم، `process` بیرون از `node-process.ts`، `Date`، `setTimeout`.

## قرارداد
افزایشی: `createSettlementHost(raw)`، `acquireSettlementHost(store, create)`، `getSettlementHost(store)`، `probeSettlementHost(store, kind)`، `evaluateProbe`، `createNodeSignalSource(proc?)`، `createNodeExit(proc?)`، `SETTLEMENT_HOST_LIMITS`، `SETTLEMENT_HOST_STORE_KEY` و نوع‌ها. هیچ قراردادِ موجودی عوض نمی‌شود.

## معیار پذیرش
1. پیکربندیِ معتبر ساخته می‌شود؛ نامعتبر/غایب/ناشناخته `INVALID_CONFIG` بی‌پرتاب و بی‌نشتِ مقدار؛ `signals` نبودن ⇒ رد؛ `null` پیش‌فرض نمی‌شود؛ هر کلید یک بار خوانده می‌شود؛ مرزها (۱ و سقف و ±۱).
2. `boot`: تک‌شروع (هم‌زمان ⇒ یک وعده)، idempotent؛ سیگنال‌ها پیش از `start` نصب می‌شوند و نصبِ ناموفق رفتگر را شروع نمی‌کند؛ فقط `PREFLIGHT_FAILED/UNAVAILABLE` بازتلاش می‌شود (سایر کدها هرگز)؛ سقفِ تلاش و فاصله؛ زمان‌سنجِ خراب بازتلاش را متوقف می‌کند؛ پس از `failed` بوتِ دوباره ممکن است؛ پس از خاموشی ⇒ `SHUTTING_DOWN`.
3. `shutdown`: یک وعده؛ ترتیبِ `stop` ← `closeResources` (فقط پس از `clean`)؛ مهلتِ کلی با زمان‌سنجِ مجازی؛ زمان‌سنجِ خراب مانعِ stop نیست؛ `closeResources` که بپرتابد/آویزان شود ⇒ `closed:"failed"`؛ `shutdown` در میانهٔ بوت و در میانهٔ انتظارِ بازتلاش درست کار می‌کند (بی‌حلقهٔ یتیم).
4. سیگنال: `SIGTERM`/`SIGINT` خاموشی را شروع و `exit(0|1)` را صدا می‌زنند؛ سیگنالِ تکراری بی‌اثر؛ سیگنال هنگامِ خاموشیِ دستی ⇒ `exit` پس از پایان؛ شنونده‌ها پس از خاموشی برداشته می‌شوند؛ `signals:false` ⇒ هیچ شنونده‌ای.
5. پروب‌ها: جدولِ کاملِ حالت×پروب؛ `live` همیشه ۲۰۰؛ `startup` چسبنده؛ `ready` فقط `running` ∧ سلامتِ هم‌سازگار؛ `degraded` ⇒ ۲۰۰، `down`/ناسازگار/پرتاب ⇒ ۵۰۳؛ بدنهٔ بسته و JSON‌پذیر.
6. singleton: همان ظرف ⇒ همان میزبان؛ ظرف‌های جدا ⇒ میزبان‌های جدا؛ شکست ذخیره نمی‌شود؛ مقدارِ بیگانه بازنویسی نمی‌شود؛ `probeSettlementHost` بدونِ میزبان ⇒ `live`=۲۰۰ و بقیه ۵۰۳، هرگز نمی‌پرتابد.
7. پورتِ خصمانه: `start/stop/health/observer/exit/closeResources` پرتاب/ردّ/شکلِ نامعتبر ⇒ هیچ متدِ میزبان نمی‌پرتابد و بی‌نشتِ پیام.
8. یکپارچه با `createSettlementRuntime` واقعی (حافظه، زمانِ مجازی): رزروِ یتیم پس از بوت بسته می‌شود؛ `ready` از ۵۰۳ به ۲۰۰ و پس از سکوتِ طولانی به ۵۰۳ می‌رود؛ `SIGTERM` ⇒ توقفِ تمیز، صفر تایمرِ معلق، ناوردای دفتر؛ پس از خاموشی هیچ گذری اجرا نمی‌شود.
9. نگهبانِ منبع: فقط `settlement-runtime` در کدِ محصول؛ `process` فقط در `node-process.ts`؛ بی‌`Date/setTimeout/console/fetch/eval/require/Math.random`؛ بی‌اتصال/پایگاه؛ بی‌اسرار.
10. دروازهٔ صفر-رد سبز؛ کفِ دروازه بالا برود؛ جهشی بی‌زندهٔ توضیح‌نشده؛ **هیچ آزمونِ موجودی تغییر نکند** (`git diff --name-status BASE..HEAD -- '*.test.ts'` فقط `A`).

## تست‌های مورد انتظار
عادی، مرزی، خطا (ورودیِ بدجنس، getter، Proxy)، مسابقه (بوت/خاموشی)، جدولِ پروب‌ها، یکپارچه با پولِ حافظه‌ای، نگهبانِ منبع، جهشی.

## خارج از کار
`src/app`، `instrumentation.ts`، `/api/health`، `NEXT_MANUAL_SIG_HANDLE`، `deliver`ِ واقعی و پایشِ پسماندِ زنگ (م۳‑ه‑۴)، drainِ مرحله‌ای، ثبتِ `status:done` در registry.

## وابستگی‌ها
ADR-0030/0031/0032؛ تحویل ۰۰۳۱.

## بازبینی و ریسک
**بله.** پول + registry. تگ `pre-risk/20261122-settlement-host` روی HEAD سبز (۳۵۰۶ تست) پیش از اولین ویرایش زده شد؛ کامیت‌های کد `Risk-Tag` دارند.
