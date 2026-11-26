# tool-policy-host

میزبانِ فرایندیِ سیاستِ ابزار (CT‑5c‑2c‑2b‑3، ADR-0075): **چرخهٔ عمرِ فرایندیِ یک `ToolPolicyRuntime`** — singleton، بوتِ شکست‌بسته، خاموشیِ مرتب و مهلت‌دار روی `SIGTERM`/`SIGINT` و سه پروبِ جدای `live/startup/ready`.
سیاستی نمی‌سازد (پول/تازه‌سازی در `tool-policy-*`، ترکیب در `tool-policy-runtime`). در کدِ محصول فقط به رابط‌های عمومیِ `tool-policy-runtime` و `settlement-host` (نوع‌های سیگنال/زمان‌سنج) وابسته است؛ به Next، `process`، پایگاه و ساعت وابسته نیست.

## استفاده
```ts
const rt = createPgToolPolicyRuntime({ db, tuning });                                  // tool-policy-runtime
if (!rt.ok) throw new Error(rt.error.issues.join("; "));
const acquired = acquireToolPolicyHost(globalThis, () =>
  createToolPolicyHost({
    runtime: rt.value,
    timer: createNodeTimer(),                    // settlement-runtime
    signals: createNodeSignalSource(),           // settlement-host؛ یا false (آگاهانه؛ مالک خودش shutdown() صدا می‌زند)
    exit: createNodeExit(),                      // settlement-host؛ اختیاری
    closeResources: () => pool.end(),            // اختیاری: فقط پس از توقفِ تمیز
    bootRetry: { maxAttempts: 5, delayMs: 2_000 }, // فقط UNAVAILABLE بازتلاش می‌شود
    observer: (e) => log(e),                     // رویدادهای بسته (کد و شمارنده)
  }),
);
await acquired.value.boot();                     // { booted, attempts, reason? } — هرگز نمی‌پرتابد
// مسیرهای HTTP:
const { httpStatus, body } = probeToolPolicyHost(globalThis, "ready");   // live | startup | ready
```

## ناورداها
- **«بوت شد» ≠ «آماده است».** `runtime.start()` نخستین تازه‌سازی را منتظر نمی‌ماند؛ پس `boot()` موفق فقط یعنی «حلقه روشن شد». `ready` فقط وقتی ۲۰۰ است که `health()` ریشه **هم‌سازگار** آماده بگوید: `state==="RUNNING" ∧ ready===true ∧ reason===null`. بدشکل/ناسازگار/پرتاب ⇒ ۵۰۳ با `HEALTH_UNAVAILABLE`. بدنهٔ ۵۰۳ دلیلِ ثابتِ ریشه را (مجموعهٔ بستهٔ `NotReadyReason`) می‌دهد؛ متنِ آزاد هرگز.
- **`startup` چسبنده از نخستین آمادگیِ دیده‌شده** (فقط در حالتِ `running`؛ با خودِ پروب‌های `startup`/`ready` ثبت می‌شود، بی‌زمان‌سنجِ دوم). پس از آن حتی اگر منبع `STALE` شود `startup` ۲۰۰ می‌ماند (فقط `ready` می‌افتد). در خاموشی/توقف چسبنده نمی‌شود.
- **بوتِ شکست‌بسته و تک‌شروع:** سیگنال‌ها پیش از `runtime.start()` نصب می‌شوند (نصبِ ناموفق ⇒ `SIGNALS_UNAVAILABLE` و ریشه شروع نمی‌شود)؛ `boot()` هم‌زمان/تکراری یک وعده؛ پس از خاموشی `SHUTTING_DOWN`.
- **بازتلاشِ فقط‌گذرا:** فقط `UNAVAILABLE`. `NOT_MIGRATED`/`SCHEMA_MISMATCH`/`ALREADY_STARTED`/`SCHEDULE_FAILED`/… هرگز (مداخلهٔ انسان). پیش‌فرض ۱ تلاش. دلیلِ شکست عیناً دلیلِ ریشه است (بی‌`code`ِ جدا).
- **پاسخِ ریشه ورودیِ ناشناخته است:** `start()`ِ بدشکل (حتی دلیلِ قدیمیِ تسویه `PREFLIGHT_FAILED`) ⇒ `RUNTIME_INVALID` بی‌بازتلاش. توقفِ **تمیز** فقط `stopped===true ∧ abandonedInFlight===false`؛ هر شکلِ دیگر (از جمله `{clean:true}` تسویه) ناتمیز است ⇒ `closeResources` صدا زده نمی‌شود.
- **خاموشی:** `stopping` (ready ⇒ ۵۰۳) ← `runtime.stop()` ← انتظارِ بوتِ در جریان ← فقط پس از توقفِ تمیز `closeResources()` ← `stopped`؛ همه زیرِ یک مهلتِ کلی (پیش‌فرض ۱۵٬۰۰۰؛ زمان‌سنجِ خراب مانعِ stop نیست)؛ نتیجه `{ ok, clean, timedOut, closed, reason }`. سیگنالِ تکراری بی‌اثر؛ پس از پایان `exit(ok ? 0 : 1)` (اگر داده شده).
- **singleton:** همان ظرف ⇒ همان میزبان؛ شکست ذخیره نمی‌شود؛ مقدارِ بیگانه بازنویسی نمی‌شود؛ `probeToolPolicyHost` بدونِ میزبان هم نمی‌پرتابد (`live` ۲۰۰؛ بقیه ۵۰۳ با `state:"absent"`). کلیدِ ظرف `Symbol.for("legal-platform.tool-policy-host")` است (جدا از میزبانِ تسویه).
- **بی‌پرتاب و بی‌نشت:** هیچ متدی نمی‌پرتابد؛ خروجیِ هر پورت ناقابل‌اعتماد است؛ پیام‌ها فقط نامِ فیلد/کدِ بسته‌اند. هر پروب حداکثر یک بار `health()` می‌خواند.

## صادرات
`createToolPolicyHost`، `acquireToolPolicyHost`، `getToolPolicyHost`، `probeToolPolicyHost`، `evaluateProbe`، `TOOL_POLICY_HOST_LIMITS`، `TOOL_POLICY_HOST_STORE_KEY` + نوع‌ها. آداپتورهای `process` (`createNodeSignalSource`/`createNodeExit`) در `settlement-host` می‌مانند و بازصادر نمی‌شوند.

## آزمون‌ها
`config.test.ts` (مرز/پیش‌فرض/بدجنس) · `probes.test.ts` (جدولِ حالت×پروب، آمادگیِ سخت‌گیرانه) · `host.test.ts` (بوت، بازتلاش، «بوت≠آماده»، خاموشی، مهلت، سیگنال، پورتِ خصمانه؛ زمانِ مجازی) · `singleton.test.ts` · `integration.test.ts` (با `createToolPolicyRuntime` **واقعی** و پورت‌های ساختگی) · `purity.test.ts` (نگهبانِ منبع) · و روی PostgreSQL واقعی: `tooling/tool-policy-host.pg.test.ts`. جهشی: `python3 tooling/mutation/tool-policy-host.py` (۷۶ جهش).

## محدودیت‌ها
به `src/app` وصل نیست (برشِ بعدی: بوت‌استرپ/`instrumentation` و مسیرهای `/api/health/…` برای سیاست). `boot()` نخستین تازه‌سازی را منتظر نمی‌ماند (بوتِ منتظر = زمان‌سنجِ دوم و تصمیمِ مهلتِ بوت؛ باز می‌ماند). **Next ۱۶ خودش روی SIGTERM/SIGINT `process.exit` می‌زند** و ممکن است پیش از پایانِ خاموشیِ ناهمگام فرایند را ببُرد (همان محدودیتِ `settlement-host`). میزبان `snapshot()` را عبور نمی‌دهد: مسیرِ داغ مستقیم از `runtime.snapshot()` می‌خواند. وابستگیِ نوعی به `settlement-host` (جفت‌شدن با دامنهٔ دیگر) آگاهانه است؛ استخراجِ نوع‌های مشترکِ فرایندی تصمیمِ معماری است.
