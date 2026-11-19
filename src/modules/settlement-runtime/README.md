# settlement-runtime

ریشهٔ ترکیبِ رفتگرِ تسویه (م۳‑ه‑۲، ADR-0031): از یک پیکربندیِ واحد رفتگر، حلقه و ارزیابِ سلامتِ `settlement` را می‌سازد و **چرخهٔ عمرِ شکست‌بسته** می‌دهد.
سیاستی نمی‌سازد؛ هر سیاست (اجاره، حلقه، سلامت) در `settlement` است. وابسته به `settlement` و `ledger` (رابط عمومی).

## استفاده (PostgreSQL)
```ts
const rt = createPgSettlementRuntime({ db, graceMs: 300_000, deadLetters: false }); // db = drizzle(pool) برنامه
if (!rt.ok) throw new Error(rt.error.issues.join("; "));
await rt.value.migrate();            // صریح؛ start هرگز مهاجرت نمی‌کند
const started = await rt.value.start(); // { started:true, atMs } یا { started:false, reason, code }
const { health, httpStatus } = rt.value.health(); // همگام، بی‌I/O؛ ۲۰۰/۵۰۳
const durable = createDurableLedger({ ledger: rt.value.ports.ledger, outbox: rt.value.ports.outbox, clock, graceMs: 300_000, onUnknownCost: "forfeit" });
await rt.value.stop();               // { clean }
```
`createSettlementRuntime` همین است روی پورت‌های تزریقی (`ledger`، `outbox`، `clock`، `timer`، `preflight?`) — برای آزمون با حافظه و زمانِ مجازی.

## ناورداها
- **شروعِ شکست‌بسته:** پیش‌بازرسیِ فقط‌خواندنیِ هر دو شِما (`NOT_MIGRATED`، `SCHEMA_MISMATCH`، `UNAVAILABLE`) با مهلت؛ شکست ⇒ حلقه شروع نمی‌شود. ساعتِ نامعتبر ⇒ `CLOCK_INVALID`.
- **تک‌شروع و توقفِ مرتب:** `ALREADY_RUNNING`/`STARTING`/`STOPPING`؛ `stop` در میانهٔ `start` لغوش می‌کند؛ `stop` هم‌زمان یک وعده؛ گذرِ آویزان ⇒ `clean:false` و `PREVIOUS_RUN_ACTIVE`.
- **پیش‌فرض‌ها:** `intervalMs=max(1,⌊graceMs/4⌋)`، `leaseMs=min(graceMs,سقف)` (همیشه روشن)، `startTimeoutMs=۱۵٬۰۰۰`. `null` صریح پیش‌فرض نمی‌شود. `deadLetters` الزامی: `false` یا `{ deliver }`.
- **`health()`** همگام و بی‌I/O، `sinceMs`=آغازِ آخرین start؛ پیش از start ⇒ `down`؛ خطا ⇒ `down`.
- **بی‌اتصال:** `db` تزریقی؛ ماژول `Pool`/`drizzle()`/`.end()` ندارد؛ `migrate` فقط درونِ `migrate()`.
- **بی‌پرتاب و بی‌نشت:** هیچ متدی نمی‌پرتابد؛ پیام‌ها فقط نامِ فیلد/کدِ بسته‌اند؛ هر کلیدِ پیکربندی یک بار خوانده می‌شود.

## صادرات
`createSettlementRuntime`، `createPgSettlementRuntime`، `createNodeTimer({ unref? })` (تأخیرِ نامعتبر می‌پرتابد)، `createSystemClock(now?)`، `SETTLEMENT_RUNTIME_LIMITS` + نوع‌ها.

## آزمون‌ها
`node-timer.test.ts`، `clock.test.ts`، `config.test.ts` (مرز و پیش‌فرض‌ها)، `runtime.test.ts` (چرخهٔ عمر، پیش‌بازرسی، سلامت، پول، زنگ؛ حافظه و زمانِ مجازی)، `pg-runtime.unit.test.ts` (بی‌پایگاه: اعتبارسنجی و نگاشتِ SQLSTATE)، `runtime.pg.test.ts` (PostgreSQL واقعی)، `purity.test.ts` (نگهبانِ منبع). جهشی: `python3 tooling/mutation/settlement-runtime.py`.

## محدودیت‌ها
به `src/app` و `/api/health` وصل نیست (م۳‑ه‑۳)؛ `deliver`ِ واقعی و پایشِ پسماندِ زنگ نیست (م۳‑ه‑۴)؛ `graceMs` باید دستی با دفترِ ماندگار یکی باشد؛ پیش‌بازرسی فقط در `start`.
