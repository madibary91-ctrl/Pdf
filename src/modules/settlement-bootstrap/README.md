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
- **بی‌نشت:** بی‌`catch (e)`/`.message`؛ `issues` فقط نامِ متغیر/فیلد؛ لاگ رویدادِ بسته (`bootstrap.disabled|started|failed|backlog_watch`، `host`).
- **بی‌مهاجرت:** بوت هرگز مهاجرت نمی‌کند؛ پایگاهِ مهاجرت‌نشده ⇒ `NOT_MIGRATED`، بی‌بازتلاش، `ready=۵۰۳`.
- **HTTP:** `probeHttpResponse` هرگز نمی‌پرتابد؛ `no-store`؛ بدنهٔ بسته `{probe, ok, state, sweep}`؛ kindِ ناشناخته/میزبانِ خراب ⇒ ۵۰۳.

## پایشِ زندهٔ پسماندِ زنگ (م۳‑ه‑۴‑الف‑۲‑۲، ADR-0043)
اختیاری و **پیش‌فرض خاموش**: با `SETTLEMENT_BACKLOG_WATCH=on` (فقط دقیقاً `on|off`؛ هر مقدارِ دیگر خطا) ماژولِ `settlement-backlog-watch` روی **همان** پایگاه/ساعت/زمان‌سنجِ رفتگر ساخته و در ظرف ثبت می‌شود، با رویدادِ `booted` شروع و با `shutdown.started` (و پیش از بستنِ استخر) متوقف می‌شود.
- **env:** آستانه‌ها `SETTLEMENT_BACKLOG_{INTERVAL_MS,TIMEOUT_MS,DEGRADED_COUNT,DOWN_COUNT,DEGRADED_AFTER_MS,DOWN_AFTER_MS,SAMPLE_MAX_AGE_MS,SAMPLE_LIMIT,READY_POLICY}` (پیش‌فرض‌های امن در ماژولِ watch؛ `READY_POLICY=report|gate_down`، پیش‌فرض `report`). آستانهٔ تنظیم‌شده بی‌کلیدِ روشن = `INVALID_ENV` (اطمینانِ کاذب نمی‌دهیم). ترتیب/دامنه را `createBacklogWatch` می‌سنجد؛ نقص ⇒ `BACKLOG_INVALID` پیش از ساختنِ میزبان، پایگاه بسته.
- **HTTP:** با پایشِ ثبت‌شده، بدنهٔ `ready` و `startup` کلیدِ پنجمِ `backlog` (`status,count,truncated,oldestAgeMs,reasons,policy`) می‌گیرد؛ `live` هرگز. `gate_down ∧ down` فقط `ready` را ۵۰۳ (`ok:false`) می‌کند؛ `startup` و `live` هرگز. پسماند فقط ۲۰۰ را ۵۰۳ می‌کند، نه برعکس؛ ثبتِ خراب ⇒ `unknown` و بی‌مسدودسازی. بی‌پایش، بدنه و کد بایت‌به‌بایت مثلِ قبل است.
- **لاگ:** `bootstrap.backlog_watch` با `state: armed|started|stopped` و `readyPolicy` (بی‌مقدارِ آستانه).
- محدودیت‌ها: هزینهٔ خواندن (هر ۳۰ ثانیه، ≤۱۰۰۰ ردیف) اندازه‌گیری نشده (الف‑۲‑۳)؛ پایش از همان استخرِ برنامه می‌خواند.

## صادرات
`startSettlementBootstrap`، `parseBootstrapEnv`، `probeHttpResponse`، `SETTLEMENT_BOOTSTRAP_ENV` + نوع‌ها. (نامِ کلیدِ `SETTLEMENT_BACKLOG_WATCH` و `BACKLOG_WATCH_STORE_KEY` داخلی‌اند؛ ADR-0043.)

## آزمون‌ها
`env.test.ts` (جدولی/خاصیتی/بدجنس) · `bootstrap.test.ts` (خاموش، نامعتبر، بوت، بازتلاش، تک‌نمونه، شکست‌های سازه‌ای، صاحبِ خروج، **SIGTERMِ واقعی**) · `http.test.ts` · `integration.pg.test.ts` (PostgreSQL واقعی) · `purity.test.ts` (نگهبانِ منبع). گلو: `src/instrumentation*.test.ts` و `src/app/api/health/probes.test.ts`. جهشی: `DATABASE_URL=… python3 tooling/mutation/settlement-bootstrap.py`. دودیِ فرایندِ واقعی (`next start` + PostgreSQL + SIGTERM): `npm run build && DATABASE_URL=… node tooling/smoke/settlement-next.mjs`.
**پایشِ پسماند (ADR-0043):** `env.backlog.test.ts` (کلید، شکست‌بسته، خاصیتی ۲۰۰۰) · `http.backlog.test.ts` (پایشِ واقعی روی outboxِ حافظه‌ایِ واقعی با زمانِ مجازی، سیاستِ مالک، ثبتِ خراب، خاصیتی ۳۰۰۰) · `backlog.test.ts` (سیم‌کشی بی‌پایگاه) · `backlog.pg.test.ts` (PostgreSQLِ واقعی: بوت ⇒ شروع، gate_down، بازگشت، توقف پیش از بستنِ استخر) · `backlog-source.test.ts` (نگهبانِ منبع) · جهشی: `tooling/mutation/settlement-bootstrap-backlog.py`.

## محدودیت‌ها
حالتِ `host` درخواست‌های HTTPِ در جریان را می‌بُرد و حالتِ `next` خاموشیِ ما را ناتمام می‌گذارد (ADR-0033 تصمیم ۴؛ توصیه: `NEXT_MANUAL_SIG_HANDLE=1` پشتِ orchestratorی که با `ready` ترافیک را برمی‌دارد). `deadLetters:false` تا `deliver`ِ واقعی (م۳‑ه‑۴). مهاجرت را این ماژول انجام نمی‌دهد (`start` هرگز مهاجرت نمی‌کند)؛ مهاجرتِ صریحِ زمانِ استقرار: `npm run settlement:migrate -- up` (CLIِ رسمیِ `settlement-migrate`، ADR-0034؛ اسکریپتِ موقتیِ smoke حذف شد، ADR-0038). drainِ مرحله‌ای نیست. فقط runtime «nodejs».
