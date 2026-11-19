# settlement-bootstrap

مرزِ برنامهٔ رفتگرِ تسویه (م۳‑ه‑۳‑ب، ADR-0033): **اتصالِ رفتگر به برنامه** — سیاستِ شکست‌بستهٔ env (پیش‌فرض خاموش)، بازشدنِ تنبلِ پایگاه، بوتِ بی‌مسدودی روی singleton، تعیینِ صاحبِ خروجِ فرایند و پاسخِ HTTP پروب‌های `live/startup/ready`.
سیاستِ پول در `settlement`، ترکیب در `settlement-runtime` و چرخهٔ عمرِ فرایندی در `settlement-host` می‌ماند. به Next، `process`، `globalThis`، `console` و پایگاه **مستقیم** وابسته نیست؛ همه تزریقی است (گلوی نازکِ `src/instrumentation*.ts` آن‌ها را می‌دهد).

## استفاده (گلوی برنامه)
```ts
// src/instrumentation.ts  (فقط runtime nodejs و نه در next build) ← src/instrumentation-node.ts
await startSettlementBootstrap({
  env: process.env,
  store: globalThis,
  processOwner: process.env.NEXT_MANUAL_SIG_HANDLE ? "host" : "next",
  openDatabase: async () => { const { db, pool } = await import("@/db"); return { db, close: () => pool.end() }; },
  log: (event) => console.log(JSON.stringify({ scope: "settlement", ...event })),
});
// src/app/api/health/{live,startup,ready}/route.ts
export function GET(): Response { return probeHttpResponse(globalThis, "ready"); }
```
`startSettlementBootstrap` هرگز نمی‌پرتابد و رد نمی‌شود؛ نتیجه: `{status:"disabled"}` | `{status:"started", created, host, booting}` | `{status:"failed", code, issues}`. بوت **بی‌انتظار** آغاز می‌شود (`booting` وعدهٔ مشاهده‌پذیرِ آن است).

## متغیرهای محیط
| متغیر | قاعده |
|---|---|
| `SETTLEMENT_HOST` | نبودن/خالی/`off` ⇒ **خاموش (پیش‌فرض)**؛ فقط دقیقاً `on` روشن می‌کند؛ هر مقدارِ دیگر (`ON`، `true`، `1`) خطای `INVALID_ENV`. |
| `SETTLEMENT_GRACE_MS` | الزامیِ `on`، بی‌پیش‌فرض؛ باید با `graceMs` دفترِ محصول یکی باشد (ADR-0023). |
| `SETTLEMENT_SHUTDOWN_TIMEOUT_MS` | اختیاری؛ سقفِ کلِ خاموشی (پیش‌فرضِ host: ۱۵٬۰۰۰). |
| `SETTLEMENT_BOOT_ATTEMPTS` / `SETTLEMENT_BOOT_RETRY_DELAY_MS` | اختیاری؛ بازتلاشِ فقط‌گذرا (`UNAVAILABLE`)؛ پیش‌فرضِ host: ۱ تلاش. |
| `SETTLEMENT_LEDGER_SCHEMA` / `SETTLEMENT_OUTBOX_SCHEMA` | اختیاری؛ پیش‌فرضِ ماژول‌های پایین‌دست. |
اعداد: فقط رقمِ لاتینِ مثبت. با `on`، هر کلیدِ ناشناختهٔ `SETTLEMENT_*` خطاست (غلط‌یابِ نام). مقدارِ هیچ متغیری هرگز در پیام/لاگ نمی‌آید.

## ناورداها
- **خاموش یعنی هیچ:** نه پایگاه باز می‌شود، نه میزبان ساخته می‌شود، نه سیگنالی نصب. پایگاه فقط وقتی `on` و env معتبر است و میزبانی از پیش نیست باز می‌شود.
- **بی‌مسدودی:** `register()` پشتِ بوتِ پایگاه منتظر نمی‌ماند؛ `startup` همین فاصله را می‌گوید.
- **تک‌نمونه:** دو فراخوانیِ هم‌زمان ⇒ یک پایگاه؛ مسابقهٔ دو بسته‌بندی ⇒ پایگاهِ اضافه بسته می‌شود؛ مقدارِ بیگانه بازنویسی نمی‌شود (`STORE_INVALID`).
- **شکست‌های سازه‌ای:** پایگاهِ بازشده بسته، چیزی ذخیره نمی‌شود؛ بازتلاش ممکن می‌ماند.
- **صاحبِ خروج:** `processOwner:"host"` ⇒ `exit(ok?0:1)` پس از خاموشیِ مرتب؛ `"next"` ⇒ **هرگز exit** (Next می‌زند؛ خاموشیِ ما رقابتی و ممکن است ناتمام بماند، ایمن ولی بی‌ضمانتِ بستنِ استخر).
- **بی‌نشت:** بی‌`catch (e)`/`.message`؛ `issues` فقط نامِ متغیر/فیلد؛ لاگ رویدادِ بسته (`bootstrap.disabled|started|failed`، `host`).
- **بی‌مهاجرت:** بوت هرگز مهاجرت نمی‌کند؛ پایگاهِ مهاجرت‌نشده ⇒ `NOT_MIGRATED`، بی‌بازتلاش، `ready=۵۰۳`.
- **HTTP:** `probeHttpResponse` هرگز نمی‌پرتابد؛ `no-store`؛ بدنهٔ بسته `{probe, ok, state, sweep}`؛ kindِ ناشناخته/میزبانِ خراب ⇒ ۵۰۳.

## صادرات
`startSettlementBootstrap`، `parseBootstrapEnv`، `probeHttpResponse`، `SETTLEMENT_BOOTSTRAP_ENV` + نوع‌ها.

## آزمون‌ها
`env.test.ts` (جدولی/خاصیتی/بدجنس) · `bootstrap.test.ts` (خاموش، نامعتبر، بوت، بازتلاش، تک‌نمونه، شکست‌های سازه‌ای، صاحبِ خروج، **SIGTERMِ واقعی**) · `http.test.ts` · `integration.pg.test.ts` (PostgreSQL واقعی) · `purity.test.ts` (نگهبانِ منبع). گلو: `src/instrumentation*.test.ts` و `src/app/api/health/probes.test.ts`. جهشی: `DATABASE_URL=… python3 tooling/mutation/settlement-bootstrap.py`. دودیِ فرایندِ واقعی (`next start` + PostgreSQL + SIGTERM): `npm run build && DATABASE_URL=… node tooling/smoke/settlement-next.mjs`.

## محدودیت‌ها
حالتِ `host` درخواست‌های HTTPِ در جریان را می‌بُرد و حالتِ `next` خاموشیِ ما را ناتمام می‌گذارد (ADR-0033 تصمیم ۴؛ توصیه: `NEXT_MANUAL_SIG_HANDLE=1` پشتِ orchestratorی که با `ready` ترافیک را برمی‌دارد). `deadLetters:false` تا `deliver`ِ واقعی (م۳‑ه‑۴). مهاجرت را این ماژول انجام نمی‌دهد (`start` هرگز مهاجرت نمی‌کند)؛ مهاجرتِ صریحِ زمانِ استقرار: `npm run settlement:migrate -- up` (CLIِ رسمیِ `settlement-migrate`، ADR-0034؛ اسکریپتِ موقتیِ smoke حذف شد، ADR-0038). drainِ مرحله‌ای نیست. فقط runtime «nodejs».
