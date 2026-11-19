# settlement‑runtime م۳‑ه‑۲: ریشهٔ ترکیبِ رفتگرِ تسویه

## هدف (یک جمله)
با یک پیکربندیِ واحد رفتگر/حلقه/ارزیابِ `settlement` را بسازد و چرخهٔ عمرِ شکست‌بسته (پیش‌بازرسیِ مهاجرت، `start`/`stop`، `health()` همگام) و آداپتورهای تایمر/ساعتِ Node را بدهد.

## زمینه
تحویل ۰۰۳۰ «گام بعد ۱–۲» و ADR-0031 (تصمیم‌ها و برش‌بندیِ م۳‑ه).

## ماژول و پوشه‌های مجاز
فقط `src/modules/settlement-runtime/` (جدید) + `src/modules/registry.ts` (یک ردیف)، `tooling/git-discipline.ts` (`HIGH_RISK_MODULES`)، `tooling/ci-tests.ts` (کف)، `docs/` و `tooling/mutation/settlement-runtime.py`. **تنها تغییرِ آزمونِ موجود:** یک خط در فهرستِ `tooling/test-connection-budget.test.ts` (`Test-Change-Approved`).

## ممنوع
تغییر `settlement`/`ledger`/`metering`، `src/app`، `/api/health`، `deliver`ِ واقعی، ساختنِ اتصال/استخر در ماژول، مهاجرتِ خودکار در `start`، تغییرِ هر آزمونِ موجود جز مورد بالا.

## قرارداد
افزایشی: `createSettlementRuntime(raw)`، `createPgSettlementRuntime(raw)`، `createNodeTimer(options?)`، `createSystemClock(now?)`، `SETTLEMENT_RUNTIME_LIMITS` و نوع‌ها. هیچ قراردادِ موجودی عوض نمی‌شود.

## معیار پذیرش
1. با پیکربندیِ معتبر ساخته می‌شود؛ ورودیِ نامعتبر/غایب/ناشناخته `INVALID_CONFIG` بی‌پرتاب و **بی‌نشتِ مقدار**؛ `deadLetters` نبودن ⇒ رد؛ `null` پیش‌فرض نمی‌شود؛ هر کلید یک بار خوانده می‌شود.
2. پیش‌فرض‌ها: `intervalMs=max(1,⌊grace/4⌋)`، `leaseMs=min(grace,سقف)` (همیشه روشن)، `startTimeoutMs=۱۵٬۰۰۰`؛ مقدارِ صریح می‌چربد.
3. `start` فقط پس از پیش‌بازرسیِ موفق و ساعتِ معتبر؛ شکستِ پیش‌بازرسی/مهلت/تایمرِ خراب ⇒ حلقه شروع نمی‌شود؛ کدهای بسته؛ `start` هرگز مهاجرت نمی‌کند.
4. چرخهٔ عمر: تک‌شروع، `stop` هم‌زمان مشترک، `stop` در میانهٔ `start` لغوش می‌کند، گذرِ آویزان ⇒ `clean:false` و `PREVIOUS_RUN_ACTIVE`، ریستارت.
5. `health()` همگام و بی‌I/O؛ `sinceMs` = آغازِ آخرین start؛ ok/degraded/down و ۲۰۰/۵۰۳ روی حلقهٔ واقعی؛ ساعتِ خراب ⇒ down.
6. پول: رزروِ یتیم بی‌هیچ `sweep` دستی بسته می‌شود (forfeit/release)؛ ۲۵ رزرو؛ دو اجرا روی یک outbox هیچ رزروی را دوبار نمی‌بندند؛ ناوردای دفتر برقرار.
7. PostgreSQL واقعی: `NOT_MIGRATED`/`SCHEMA_MISMATCH`/`UNAVAILABLE`، `migrate()` صریح و idempotent با گزارشِ مرحله، ریستارتِ فرایند با استخرِ تازه، دو فرایند با استخرهای جدا، قطعِ پایگاه وسطِ کار، دودیِ زمانِ واقعی.
8. `createNodeTimer`: تأخیرِ نامعتبر می‌پرتابد؛ `unref`؛ لغوِ بی‌خطر؛ `fn` پرتاب‌کننده فرایند را نمی‌کُشد.
9. نگهبانِ منبع: فقط ledger/settlement، بی‌process/console/pg/drizzle/Pool، `Date` فقط clock.ts، `setTimeout` فقط node-timer.ts، `migrate` فقط درونِ `migrate()`.
10. دروازهٔ صفر-رد سبز؛ کفِ دروازه بالا برود؛ جهشی بی‌زندهٔ توضیح‌نشده.

## تست‌های مورد انتظار
عادی، مرزی (grace=۲، سقف‌ها، ±۱)، خطا (ورودیِ بدجنس، getter، Proxy)، حالت‌های چرخهٔ عمر، ناوردای پول، جهشی، PostgreSQL واقعی.

## خارج از کار
`src/app`، `/api/health`، singleton، `SIGTERM`، `deliver`ِ واقعی، پایشِ پسماندِ زنگ، ثبتِ `status:done` در registry.

## وابستگی‌ها
ADR-0022/0023/0026/0029/0030؛ تحویل ۰۰۳۰.

## بازبینی و ریسک
**بله.** پول + registry. تگ `pre-risk/20261121-settlement-runtime` روی HEAD سبز پیش از اولین ویرایش زده شد؛ کامیت‌های کد `Risk-Tag` دارند.
