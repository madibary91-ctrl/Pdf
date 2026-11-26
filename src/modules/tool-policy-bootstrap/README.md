# tool-policy-bootstrap

مرزِ برنامهٔ میزبانِ سیاستِ ابزار (CT‑5c‑2c‑2b‑3b، ADR-0076): **اتصالِ میزبان به برنامه** — سیاستِ شکست‌بستهٔ env (پیش‌فرض خاموش)، بازشدنِ تنبلِ پایگاه، ساختنِ ریشهٔ PG و میزبان، بوتِ بی‌مسدودی روی singleton، تعیینِ صاحبِ خروجِ فرایند و پاسخِ HTTP پروب‌های `live/startup/ready`.
چرخهٔ عمرِ فرایندی در `tool-policy-host` و زنجیرهٔ سیاست در `tool-policy-runtime` می‌ماند. به Next، `process`، `globalThis`، `console` و پایگاه **مستقیم** وابسته نیست؛ همه تزریقی است (گلوی نازکِ `src/instrumentation-policy.ts` آن‌ها را می‌دهد).

## استفاده (گلوی برنامه)
```ts
// src/instrumentation.ts (فقط runtime nodejs و نه در next build) ← پس از تسویه، در try/catch ← src/instrumentation-policy.ts
await startToolPolicyBootstrap({
  env: process.env,
  store: globalThis,
  processOwner: process.env.NEXT_MANUAL_SIG_HANDLE ? "host" : "next",
  exit: sharedExit,                 // خروجِ هماهنگ با میزبانِ تسویه (src/process-exit.ts)
  openDatabase: openSharedDatabase, // اجارهٔ شمارشیِ استخرِ @/db: { db, close, release } (src/db/pool-lease.ts)
  log: (event) => console.log(JSON.stringify({ scope: "tool-policy", ...event })),
});
// src/app/api/health/policy/{live,startup,ready}/route.ts
export function GET(): Response { return probeHttpResponse(globalThis, "ready"); }
```
`startToolPolicyBootstrap` هرگز نمی‌پرتابد و رد نمی‌شود؛ نتیجه: `{status:"disabled"}` | `{status:"started", created, host, booting}` | `{status:"failed", code, issues}`. بوت **بی‌انتظار** آغاز می‌شود (`booting` وعدهٔ مشاهده‌پذیرِ آن است).

## متغیرهای محیط
| متغیر | قاعده |
|---|---|
| `TOOL_POLICY_HOST` | نبودن/خالی/`off` ⇒ **خاموش (پیش‌فرض)**؛ فقط دقیقاً `on` روشن می‌کند؛ هر مقدارِ دیگر (`ON`، `true`، `1`) خطای `INVALID_ENV`. |
| `TOOL_POLICY_INTERVAL_MS` · `_RETRY_MS` · `_ATTEMPT_DEADLINE_MS` · `_REFRESH_TIMEOUT_MS` · `_MAX_STALE_MS` | **الزامیِ `on`، بی‌پیش‌فرض** (پنجرهٔ تازگیِ سیاست تصمیمِ مالک است). بازه و رابطه‌ها را ریشه می‌سنجد (`RUNTIME_INVALID`). |
| `TOOL_POLICY_SCHEMA` | اختیاری؛ پیش‌فرضِ ذخیره‌ساز (`tool_policy`)؛ باید از پیش و با نقشِ مهاجرتِ جدا ساخته و مهاجرت‌شده باشد. |
| `TOOL_POLICY_STATEMENT_TIMEOUT_MS` | اختیاری؛ باید `≤ REFRESH_TIMEOUT_MS` باشد (پیش‌فرضِ ریشه: `min(۵۰۰۰, REFRESH_TIMEOUT_MS)`). |
| `TOOL_POLICY_SHUTDOWN_TIMEOUT_MS` | اختیاری؛ سقفِ کلِ خاموشی (پیش‌فرضِ host: ۱۵٬۰۰۰). |
| `TOOL_POLICY_BOOT_ATTEMPTS` / `TOOL_POLICY_BOOT_RETRY_DELAY_MS` | اختیاری؛ بازتلاشِ فقط‌گذرا (`UNAVAILABLE`)؛ پیش‌فرضِ host: ۱ تلاش. |
اعداد: فقط رقمِ لاتینِ مثبت. با `on`، هر کلیدِ ناشناختهٔ `TOOL_POLICY_*` خطاست. مقدارِ هیچ متغیری هرگز در پیام/لاگ نمی‌آید.

## ناورداها
- **خاموش یعنی هیچ:** نه پایگاه باز می‌شود، نه میزبان ساخته می‌شود، نه سیگنالی نصب.
- **بی‌مسدودی** و **تک‌نمونه** (دو فراخوانیِ هم‌زمان ⇒ یک پایگاه؛ مسابقهٔ دو بسته‌بندی ⇒ اجارهٔ اضافه پس داده می‌شود؛ مقدارِ بیگانه بازنویسی نمی‌شود: `STORE_INVALID`).
- **شکستِ ساختار ⇒ `release`، نه `close`:** استخرِ `@/db` را وبِ اصلی هم می‌خواند؛ بوتِ شکست‌خوردهٔ سیاست نباید آن را ببندد. `close` فقط در `closeResources` پس از توقفِ تمیز.
- **بی‌مهاجرت:** `NOT_MIGRATED` بی‌بازتلاش، بی‌جدول، `ready=۵۰۳`.
- **صاحبِ خروج:** `host` ⇒ `exit(ok?0:1)` پس از خاموشیِ مرتب (با خروجِ هماهنگ در گلو)؛ `next` ⇒ هرگز exit.
- **HTTP:** `probeHttpResponse` هرگز نمی‌پرتابد؛ `no-store`؛ بدنهٔ بسته `{probe, ok, state, reason}`؛ هر پاسخِ ناهمسازِ میزبان/kindِ ناشناخته ⇒ ۵۰۳ `{ok:false}`؛ بی‌میزبان: `live` ۲۰۰، بقیه ۵۰۳ (`state:"absent"`).
- **بی‌نشت:** بی‌`catch (e)`/`.message`؛ `issues` فقط نامِ متغیر/فیلد؛ لاگِ رویدادِ بسته (`bootstrap.disabled|started|failed`، `host`).

## محدودیت‌ها
**به دروازهٔ ابزار وصل نیست** (2b‑2): روشن‌کردنِ `TOOL_POLICY_HOST=on` فقط سلامت/تازگیِ سیاست را قابل‌مشاهده می‌کند. `connectionTimeoutMillis` استخر تنظیم نشده. Next ۱۶ روی SIGTERM خودش `process.exit` می‌زند (در حالتِ `next` بستنِ استخر تضمین نیست؛ توصیه: `NEXT_MANUAL_SIG_HANDLE=1`). مسیرِ شکستِ `settlement-bootstrap` هنوز `close` (نه `release`) صدا می‌زند (ADR-0076 بند ۵). فقط runtime «nodejs».

## آزمون‌ها
`env.test.ts` (جدولی/خاصیتی/بدجنس) · `bootstrap.test.ts` (خاموش، نامعتبر، بوت، بازتلاش، تک‌نمونه، شکست‌های سازه‌ای با `release`/`close`، صاحبِ خروج و SIGTERM) · `http.test.ts` (با میزبانِ واقعی؛ پاسخِ ناهمساز) · `purity.test.ts`. گلو: `src/instrumentation-policy.test.ts`، `src/instrumentation.policy.test.ts`، `src/instrumentation-shared.test.ts`، `src/db/pool-lease.test.ts`، `src/process-exit.test.ts` (دو میزبانِ واقعی)، `src/app/api/health/policy/probes.test.ts`. PostgreSQLِ واقعی: `tooling/tool-policy-bootstrap.pg.test.ts`. جهشی: `python3 tooling/mutation/tool-policy-bootstrap.py`.
