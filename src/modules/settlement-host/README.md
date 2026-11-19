# settlement-host

میزبانِ فرایندیِ رفتگرِ تسویه (م۳‑ه‑۳‑الف، ADR-0032): **چرخهٔ عمرِ فرایندیِ یک `SettlementRuntime`** — singleton، بوتِ شکست‌بسته، خاموشیِ مرتب و مهلت‌دار روی `SIGTERM`/`SIGINT` و سه پروبِ جدای `live/startup/ready`.
سیاستی نمی‌سازد (پول/سلامت در `settlement`، ترکیب در `settlement-runtime`). در کدِ محصول فقط به رابط عمومیِ `settlement-runtime` وابسته است؛ به Next، `process` (جز آداپتورِ نازک)، پایگاه و ساعت وابسته نیست.

## استفاده
```ts
const rt = createPgSettlementRuntime({ db, graceMs: 300_000, deadLetters: false });       // settlement-runtime
if (!rt.ok) throw new Error(rt.error.issues.join("; "));
const acquired = acquireSettlementHost(globalThis, () =>
  createSettlementHost({
    runtime: rt.value,
    timer: createNodeTimer(),                 // settlement-runtime
    signals: createNodeSignalSource(),        // یا false (آگاهانه؛ مالک خودش shutdown() صدا می‌زند)
    exit: createNodeExit(),                   // اختیاری: پس از خاموشیِ سیگنالی با ok ? 0 : 1
    closeResources: () => pool.end(),         // اختیاری: فقط پس از توقفِ تمیز
    bootRetry: { maxAttempts: 5, delayMs: 2_000 }, // فقط UNAVAILABLE بازتلاش می‌شود
    observer: (e) => log(e),                  // رویدادهای بسته (کد و شمارنده)
  }),
);
await acquired.value.boot();                  // { booted, … } — هرگز نمی‌پرتابد
// مسیرهای HTTP:
const { httpStatus, body } = probeSettlementHost(globalThis, "ready");   // live | startup | ready
```
(`acquireSettlementHost` ظرف را به‌عنوان `store` می‌گیرد؛ ماژول `globalThis` را نمی‌شناسد.)

## ناورداها
- **بوتِ شکست‌بسته و تک‌شروع:** سیگنال‌ها پیش از `runtime.start()` نصب می‌شوند (نصبِ ناموفق ⇒ رفتگر شروع نمی‌شود)؛ `boot()` هم‌زمان/تکراری یک وعده؛ پس از خاموشی `SHUTTING_DOWN`.
- **بازتلاشِ فقط‌گذرا:** فقط `PREFLIGHT_FAILED/UNAVAILABLE`؛ `NOT_MIGRATED`/`SCHEMA_MISMATCH`/… هرگز (مداخلهٔ انسان). پیش‌فرض ۱ تلاش.
- **خاموشی:** `stopping` (ready ⇒ ۵۰۳) ← `runtime.stop()` ← انتظارِ بوتِ در جریان ← فقط پس از `clean:true` `closeResources()` ← `stopped`؛ همه زیرِ یک مهلتِ کلی (پیش‌فرض ۱۵٬۰۰۰؛ زمان‌سنجِ خراب مانعِ stop نیست)؛ نتیجه `{ ok, clean, timedOut, closed, reason }`.
- **سیگنال:** تکراری بی‌اثر (خاموشی را نمی‌کُشد)؛ پس از پایان `exit(ok ? 0 : 1)` (اگر داده شده)؛ شنونده‌ها پس از خاموشی برداشته می‌شوند.
- **پروب‌ها:** `live` همیشه ۲۰۰؛ `startup` ۲۰۰ از اولین بوتِ موفق (چسبنده)؛ `ready` ۲۰۰ فقط در `running` با سلامتِ هم‌سازگارِ `ok|degraded`، وگرنه ۵۰۳. بدنه فقط `{probe, ok, state, sweep}`.
- **singleton:** همان ظرف ⇒ همان میزبان؛ شکست ذخیره نمی‌شود؛ مقدارِ بیگانه بازنویسی نمی‌شود؛ `probeSettlementHost` بدونِ میزبان هم نمی‌پرتابد.
- **بی‌پرتاب و بی‌نشت:** هیچ متدی نمی‌پرتابد؛ خروجیِ هر پورت ناقابل‌اعتماد است؛ پیام‌ها فقط نامِ فیلد/کدِ بسته‌اند.

## صادرات
`createSettlementHost`، `acquireSettlementHost`، `getSettlementHost`، `probeSettlementHost`، `evaluateProbe`، `createNodeSignalSource(proc?)`، `createNodeExit(proc?)`، `SETTLEMENT_HOST_LIMITS`، `SETTLEMENT_HOST_STORE_KEY` + نوع‌ها.

## آزمون‌ها
`config.test.ts` (مرز/پیش‌فرض/بدجنس) · `probes.test.ts` (جدولِ حالت×پروب) · `host.test.ts` (بوت، بازتلاش، خاموشی، مهلت، مسابقه، سیگنال، پورتِ خصمانه؛ زمانِ مجازی) · `singleton.test.ts` · `node-process.test.ts` · `integration.test.ts` (با `createSettlementRuntime` واقعی و دفتر/outboxِ حافظه‌ای؛ ناوردای پول) · `purity.test.ts` (نگهبانِ منبع). جهشی: `python3 tooling/mutation/settlement-host.py`.

## محدودیت‌ها
خودِ ماژول به `src/app` وصل نیست؛ اتصال را `settlement-bootstrap` انجام می‌دهد (م۳‑ه‑۳‑ب، ADR-0033: `instrumentation` + پروب‌های `/api/health/{live,ready,startup}`). **Next ۱۶ خودش روی SIGTERM/SIGINT `process.exit` می‌زند** (`start-server.js`؛ مگر `NEXT_MANUAL_SIG_HANDLE`) و ممکن است پیش از پایانِ خاموشیِ ناهمگام فرایند را ببُرد — خاموشیِ ناتمام ایمن است ولی «بستنِ استخر» تضمین نیست؛ تصمیمِ نهایی با اجرای واقعی در برش ب (ADR-0032). drainِ مرحله‌ای ندارد. سیگنالِ واقعیِ OS در آزمون ارسال نمی‌شود. `graceMs` هنوز باید دستی با `createDurableLedger` یکی باشد.
