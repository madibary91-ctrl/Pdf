# settlement (لایهٔ ۴ · غیرخالص · **بازبینی انسانیِ اجباری: مالک امنیت/مالی**) — **م۳‑الف: outbox و رفتگر تسویه · م۳‑ب: outbox ماندگار روی PostgreSQL**

**هدف:** هیچ تغییرِ دفتر بدون ردّ ماندگارِ پیشین؛ تسویه‌های شکست‌خورده و رزروهای یتیمِ مرگِ فرایند با تکرارِ idempotent بسته می‌شوند؛ هر مرگِ خودکار صدا می‌دهد. تصمیم‌ها و دلیل‌ها: `docs/adr/0021-settlement.md` (outbox، رفتگر) و `docs/adr/0022-settlement-postgres-outbox.md` (ذخیرهٔ PostgreSQL) و `docs/adr/0023-settlement-sweep-loop.md` (حلقهٔ رفتگر).
**وابستگی:** طبق `registry.ts` فقط `ledger` و `metering` (رابط عمومی). به شبکه، فایل، `process.env`، ساعت سیستم، تایمر و تصادف دست نمی‌زند؛ **ساعت و outbox و دفتر تزریق می‌شوند** (آزمونِ نگهبان این را می‌سنجد).

> ✅ **ماندگاریِ واقعی (م۳‑ب):** `createPgSettlementOutbox` همان `describeOutboxContract` را بی‌تغییر می‌گذراند و با «مرگِ واقعیِ فرایند» (بستنِ همهٔ اتصال‌ها و بازیابی با فرایندِ تازه) آزموده شده است. `createMemoryOutbox` فقط برای آزمون/توسعه است.
> ⚠️ بازبینی مالک امنیت/مالی و مهاجرتِ پایگاه (ناحیهٔ پرریسک) انجام نشده؛ **هنوز به پول واقعی وصل نکنید.** زمان‌بندِ رفتگر اکنون هست (`createSweepLoop`، م۳‑ج) ولی **باید در ریشهٔ ترکیب سیم‌کشی شود** (تایمر، `/api/health`، زنگِ `onBuried`)؛ تا آن‌گاه هیچ‌کس `sweep()` را صدا نمی‌زند و رزروهای یتیم با سررسید آزاد می‌شوند.

## ترکیب
```ts
// ریشهٔ ترکیب: db = drizzle(pool)؛ شِمای settlement (نه public)
const pg = createPgSettlementOutbox(db);                      // PgStoreResult<PgSettlementOutbox>
if (!pg.ok) throw new Error(pg.error.code);
await pg.value.migrate();                                     // یک‌بار در راه‌اندازی (idempotent، هم‌زمان‌امن)؛ outbox خودش هرگز مهاجرت نمی‌کند
const outbox = pg.value;                                      // آزمون/توسعه: createMemoryOutbox()
const made = createDurableMeteredGateway({                    // = MeteringConfig + outbox + clock + graceMs
  gateway, ledger /* دفتر خام */, account, currency, models, scopeId,
  reservationTtlMs: 60_000, maxProviderCalls: 1, perMessageOverheadTokens: 10, onUnknownCost: "forfeit",
  outbox, clock, graceMs: 10_000,                             // graceMs > زمانِ کل یک تماس؛ ≤ ttl/2
});                                                           // SettlementResult<MeteredGateway> — ارکستراتور بی‌تغییر آن را می‌گیرد
const sweeper = createSettlementSweeper({ ledger /* همان دفتر خام */, outbox, clock });
const report = await sweeper.sweep();                         // هر ≤ graceMs از ریشهٔ ترکیب؛ report.buried غیرتهی ⇒ زنگ
```
رفتگر دفتر **خام** می‌گیرد (دفتر دکوراته‌شده رد می‌شود). `createDurableLedger` همان دکوراتور را جدا می‌دهد (برای کاربردی بی‌metering).

## outbox PostgreSQL (`settlement/pg/`)
- **شِما و جدول:** شِمای `settlement` (یا `options.schema`؛ `^[a-z][a-z0-9_]{0,39}$`، نه `public`)؛ جدول `settlement_outbox` و دفترِ مهاجرتِ **جدا** `settlement_migration_ledger` (دفترِ مهاجرتِ ledger را نمی‌شکند؛ هم‌شِمایی با ledger بی‌برخورد است). مهاجرتِ دست‌نویس با checksum؛ اعمال‌شده هرگز ویرایش نمی‌شود، تغییر = مهاجرت تازه.
- **هر عملیات یک تراکنش:** سپر مهاجرت ← `SELECT … FOR UPDATE` ← تصمیم ← `UPDATE`. `resolveClose` درون همان قفل اتمی است (بی‌قصدِ مصرف ⇒ سیاستِ یتیم؛ با قصدِ مصرف ⇒ `release`).
- **ناورداها در خودِ پایگاه:** `CHECK` شکلِ هر وضعیت، قصدِ مصرف/بستن نوشتن‌یک‌بار، `done`/`dead` نهایی، **بی‌حذف و بی‌`TRUNCATE`** (حتی با `psql`)؛ `COLLATE "C"` برای ترتیبِ قطعیِ شناسه؛ ایندکس‌های جزئی (رفتگر فقط فعال‌ها را می‌بیند).
- **بی‌پرتاب و بی‌نشت:** هر خطای پایگاه یا ردیفِ خراب ⇒ `STORE_FAILURE` با پیامِ ثابت؛ ورودیِ نامعتبر هرگز به پایگاه نمی‌رسد. زمان‌ها از فراخواننده می‌آیند (بی‌`now()`).
- `migrate()` و `status()` (مسیرِ راه‌اندازی، `PgStoreResult`) خطاهای غنی می‌دهند: `MIGRATION_TAMPERED`، `MIGRATION_UNKNOWN`، `NOT_MIGRATED`، `COMMIT_REJECTED`، `DB_ERROR`.

## رکورد outbox: `open → settling → done | dead`
| گام | ردّ ماندگار (پیش از اجرا روی دفتر) | شکستِ ثبت |
|---|---|---|
| `reserve` | `begin` | رزرو برمی‌گردد؛ تماسی نیست |
| `charge` | `recordCharge` | دفتر دست‌نخورده |
| `close` | `recordClose` ← دفتر ← `finish` | دفتر دست‌نخورده؛ `finish` بی‌خطر |
ناورداها: قصدِ بستن آخرین قصد است؛ یک رزرو = یک قصدِ مصرف؛ `done`/`dead` نهایی.

## رفتگر
`resolveClose` (**اتمی، با خودِ outbox**: بی‌قصدِ مصرف ⇒ سیاستِ یتیم؛ با قصدِ مصرف ⇒ `release`، هرگز بیش‌اخذ) ← `charge` (بازپخش هزینه را دوباره نمی‌گیرد) ← `close` ← `finish`.
| نتیجه | رفتار |
|---|---|
| موفق | `done` |
| خطای گذرای دفتر | بازتلاش با `retryDelayMs × (تلاش+۱)`؛ پس از `maxAttempts` ⇒ `dead: ATTEMPTS_EXHAUSTED` |
| انقضا | `dead: EXPIRED_UNBILLED` |
| خطای دائمی | `dead: LEDGER_REJECTED` |
| خطای خودِ outbox / مسابقه | رکورد دست‌نخورده / `raced` |
`SweepReport` فقط شناسه و شمار دارد (`buried` = زنگ). رکورد مرده حذف نمی‌شود (`outbox.listDead`).

## حلقهٔ رفتگر (`createSweepLoop`، م۳‑ج)
```ts
const loop = createSweepLoop({
  sweeper,                        // createSettlementSweeper(...) — با دفتر خام
  timer: { after: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h as never) }, // ریشهٔ ترکیب
  clock, graceMs,                 // همان graceMs دکوراتور
  intervalMs: Math.floor(graceMs / 2),
  observer: { onBuried: (items) => page(items), onFault: (f) => metrics(f) },
});
loop.start();                     // ... و هنگام خاموشی: await loop.stop()  ⇒ { clean }
loop.status();                    // state، busy، lastSuccessAtMs، consecutiveFailures، totals (برای /api/health)
```
- **تک‌پرواز** (زنجیرِ تایمرِ یک‌باره، نه `setInterval`)؛ هر تایمر یک بار (نشانهٔ یکتا).
- **سقفِ فاصله:** `intervalMs ≤ maxBackoffMs ≤ ⌊graceMs/2⌋` در پیکربندی اعمال می‌شود (وگرنه رزروِ یتیم پیش از دیده‌شدن منقضی می‌شود).
- **شکست** (رفتگر بپرتابد، گزارشِ خراب، `listFailed`، `outboxFailures>0`) ⇒ عقب‌نشینیِ نمایی تا سقف + `onFault`؛ **پیشرفت** (تسویه/مرگ) ⇒ تخلیهٔ بی‌انتظار تا `maxDrainRuns`.
- **مشاهده‌گرها await نمی‌شوند** و خرابی‌شان فقط `observerFailures` را زیاد می‌کند؛ گزارش کپیِ منجمدِ فیلدهای شناخته‌شده است (پیامِ خام هرگز نمی‌رسد).
- `stop()` منتظر گذرِ جاری می‌ماند (مهلت `stopTimeoutMs`؛ `clean:false` اگر تمام نشد)؛ گذرِ رهاشده زمان‌بندی نمی‌کند ولی `onBuried` می‌دهد.
- زمان‌سنجِ ناتوان از ساختنِ گذر بعد ⇒ `state: "stalled"` + `SCHEDULE_FAILED` (خاموشیِ ساکت نیست).
- `onBuried` **ماندگار نیست**: مرگِ فرایند میانِ `bury` و زنگ ⇒ زنگ گم می‌شود (رکورد `dead` می‌ماند؛ پایشِ `listDead` برش بعد).

## محدودیت‌های صادقانه
- `graceMs` باید از زمانِ کل تماس بیشتر باشد (وگرنه رفتگر زیرِ دستِ تماسِ زنده می‌بندد و تماس طبق سیاست تسویه می‌شود) و رفتگر باید **پیش از سررسید رزرو** (≤ `ttl − graceMs`) اجرا شود (وگرنه `EXPIRED_UNBILLED`).
- سیاستِ `release` + از کار افتادنِ outbox پس از تماس ⇒ هزینهٔ معلوم گم می‌شود (`forfeit` می‌پوشاندش، با جریمهٔ کاربر): تصمیمِ محصول/مالی.
- هزینهٔ **نامعلومِ** با کفِ معلوم که پیش از `close` فرایندش بمیرد: بخش نامعلوم `release` می‌شود (بی‌بیش‌اخذ) نه سوخت.
- چند رفتگرِ هم‌زمان **بی‌`leaseMs`** ایمن‌اند ولی کار را دوباره می‌کنند (قفلِ ردیف تکرارِ هم‌زمانِ یک رکورد را سریال می‌کند)؛ با `leaseMs` (ADR-0029) کارِ تکراری حذف می‌شود، ولی اجاره قفلِ درستی نیست. هویت، خرید: برش‌های بعد.
- رکوردهای `done` هرگز حذف نمی‌شوند (TRIGGER حذف را می‌بندد) و جدول رشد می‌کند؛ بایگانی باید با مسیرِ آگاهانه و تأییدشده بیاید. ایندکس‌های جزئی هزینهٔ رفتگر را ثابت نگه می‌دارند ولی `counts()` کل جدول را می‌شمارد.
- «ثبتِ قصد» و «تغییرِ دفتر» دو تراکنشِ جدا هستند (طراحیِ write-ahead، بسته‌شکست)؛ ادغام در یک تراکنش نیازمند تغییرِ قرارداد ledger است (کارِ جدا).
- فقط روی PostgreSQL ۱۵٫۱۹ و لینوکس آزموده شده (ویندوز نه).

## بودجهٔ اتصال آزمون‌ها و خرابیِ گذرای پایگاه (ADR-0024)
- ریشهٔ `STORE_FAILURE`های تصادفیِ آزمون‌های `pg/` **محصول نبود**: کمک‌تست استخرها را تا `afterAll` باز می‌گذاشت (۲۴×۴ = ۹۶ اتصال در آزمون تفاضلی) و فایل‌های موازی `53300 too many clients` می‌گرفتند؛ آداپتور درست آن را `STORE_FAILURE` کرد. کمک‌تست‌ها اکنون اتصال بیکار را پس از ۵۰ms می‌دهند (و اتصال‌ها `application_name` دارند).
- **زیرِ ردِ اتصال یا قطعِ پس از commit** (نتیجهٔ مبهم): همه‌چیز `STORE_FAILURE`ِ ثابت و بی‌نشت است، چیزی نیمه‌نوشته نمی‌ماند و تکرارِ فراخوان برای `begin/recordCharge/recordClose/resolveClose/finish/bury` ایمن و هم‌ارزِ مدلِ مرجع است (آزموده با PostgreSQL واقعی).
- ✅ **`recordFailure` اکنون با `expectedAttempts` تکرارپذیر است** (م۳‑د‑۳الف، ADR-0028؛ بخشِ پایین)؛ بی‌آن همچنان `attempts+1` است. استخرِ برنامه (`src/db/index.ts`) هم `connectionTimeoutMillis` ندارد؛ هر دو در تحویل ۰۰۲۴ برای تصمیمِ مالک ثبت شده‌اند.

## تأییدِ ماندگارِ رسیدگی به مرده‌ها (م۳‑د‑۱، ADR-0025)
```ts
const pending = await outbox.listUnacknowledgedDead({ limit: 100 }); // ترتیبِ (زمان مرگ، شناسه)
for (const e of pending.ok ? pending.value : []) {
  await page(e);                                                      // اعلامِ عملیاتی (ممکن است تکراری برسد)
  await outbox.acknowledgeDead(e, { atMs: clock.nowMs() });           // ماندگار؛ تکرار ⇒ replayed
}
```
- **تحویلِ دست‌کم‌یک‌بار:** تا تأیید ثبت نشده رکورد در فهرست می‌ماند؛ مرگِ فرایند میانِ «فهرست» و «تأیید» زنگ را گم نمی‌کند، فقط ممکن است تکراری برسد.
- تأیید **نوشتن‌یک‌بار** است (اولین `atMs` می‌ماند؛ تکرار با هر زمانی `replayed:true`)، فقط برای `dead` (غیرمرده ⇒ `CONFLICT`، بی‌رکورد ⇒ `NOT_FOUND`) و `listDead`/`get`/`counts` را عوض نمی‌کند.
- PostgreSQL: مهاجرتِ افزایشیِ `0002_dead_ack` جدولِ `settlement_dead_ack` را می‌سازد (**پیش از استفاده `migrate()`**؛ تا آن‌گاه همهٔ عملیات `STORE_FAILURE` است). مرده‌های پیش از ارتقا «تأییدنشده»‌اند. جدولِ outbox و TRIGGERهایش دست‌نخورده‌اند.
- ✅ از م۳‑د‑۲ (ADR-0026) حلقه با گزینهٔ `deadLetters` این‌ها را صدا می‌زند (بخشِ بعد). **بدونِ `deadLetters` همچنان هیچ‌کس صدایشان نمی‌زند** و `onBuried` درون‌حافظه‌ای است و با مرگِ فرایند گم می‌شود.

## زنگِ ماندگارِ مرده‌ها در حلقه (م۳‑د‑۲، ADR-0026)
```ts
createSweepLoop({
  sweeper, timer, clock, graceMs, intervalMs,
  observer: { onBuried: fastPath },            // اختیاری: سریع، درون‌حافظه‌ای، await نمی‌شود، با مرگ گم می‌شود
  deadLetters: {
    outbox,                                    // فقط listUnacknowledgedDead و acknowledgeDead لازم است
    deliver: async (letter) => { await page(letter); },   // await می‌شود (با مهلت)؛ باید idempotent باشد
    // batchLimit: 50, maxBatchesPerRun: 5, deliverTimeoutMs: 30_000   (پیش‌فرض‌ها)
  },
});
```
- هر گذر (از جمله نخستین گذرِ پس از `start`، پس هر ریستارت) **پس از رفتگر** مرده‌های تأییدنشده را می‌خواند، هر کدام را به `deliver` می‌دهد و **فقط پس از موفقیتِ `deliver`** تأیید می‌کند ⇒ تحویلِ **دست‌کم‌یک‌بار**: مرگِ فرایند میانِ تحویل و تأیید ⇒ دوباره می‌رسد؛ پس از تأیید هرگز.
- `deliver` فقط **نامهٔ منجمدِ** `DeadLetter` را می‌بیند (شناسه‌ها، `unit`، `reserved`، `reason`، `errorCode`، `attempts`، `deadAtMs`)؛ هرگز پیامِ خام.
- `deliver` پرتاب/رد/مهلت ⇒ تأیید نمی‌شود، همان رکورد در همان گذر دوباره تلاش نمی‌شود (رکوردِ مسموم گرسنگی نمی‌دهد)، خطای `DEAD_DELIVER_FAILED`؛ بقیهٔ رکوردها ادامه می‌دهند. فهرست/تأیید خراب ⇒ `DEAD_LIST_FAILED` / `DEAD_ACK_FAILED`. همه با عقب‌نشینیِ ADR-0023 (سقفِ `⌊graceMs/2⌋`) ⇒ **خرابیِ زنگ تسویهٔ پول را کند نمی‌کند**.
- بیش از `batchLimit×maxBatchesPerRun` مرده ⇒ گذرِ بعد بی‌انتظار (تخلیه، با سقفِ `maxDrainRuns`). `status().deadLetters` شمارنده‌ها و `lastAckAtMs` را برای پایش می‌دهد.
- ⚠️ حلقه هنوز در هیچ ریشهٔ ترکیبی سیم‌کشی نشده و `deliver`ِ واقعی (پیامک/ایمیل/صف) وجود ندارد؛ این برش «سازوکارِ رسیدنِ مطمئن» است، نه «مقصد».

## ثبتِ شکستِ تکرارپذیر (م۳‑د‑۳الف، ADR-0028)
`recordFailure(ref, { errorCode, dueAtMs, expectedAttempts? })` — `attempts` سقفِ مرگِ مالیِ رکورد را می‌سازد؛ پس دو رفتگرِ هم‌زمان (یا تلاشِ دوبارهٔ پس از قطعِ مبهم) نباید یک شکستِ منطقی را دو بار بشمارند.
- **بی‌`expectedAttempts`**: رفتارِ پیشین (`{attempts}`، همیشه +۱).
- **با آن** (زیرِ قفلِ ردیف، compare-and-set): `attempts === n` ⇒ ثبت، `{attempts:n+1, replayed:false}` · `attempts > n` ⇒ **بی‌نوشتن** (نه شمارنده، نه سررسید، نه کد)، `{attempts:<فعلی>, replayed:true}` · `attempts < n` ⇒ `CONFLICT` · نبودن ⇒ `NOT_FOUND` · نهایی ⇒ `NOT_ACTIVE` (پیش از مقایسه) · نامعتبر ⇒ `INVALID_INPUT` (بی‌تماس با پایگاه؛ `undefined` ≡ نبودن).
- **رفتگر** همیشه `expectedAttempts: e.attempts` می‌فرستد؛ `replayed:true` ⇒ شمارندهٔ `raced` (نه `retryLater`). `SweepReport`/`SweepLoop` بی‌تغییر؛ با یک رفتگر هرگز `replayed` رخ نمی‌دهد.
- **بی‌مهاجرت** (`attempts` خودش نسخهٔ یکنواخت است). ⚠️ این برش **فقط شمارنده** را درست می‌کند؛ حذفِ کارِ تکراریِ دفتر با اجارهٔ رکوردها (م۳‑د‑۳ب، ADR-0029) آمد (بخشِ بعد).

## اجارهٔ رکوردها برای رفتگر (م۳‑د‑۳ب، ADR-0029)
`DueClaimer.claimDue({ nowMs, limit, leaseMs })` (روی `createMemoryOutbox` و `createPgSettlementOutbox`؛ **بخشی از `SettlementOutbox` نیست**، تا outboxِ بیرونیِ موجود معتبر بماند) و `createSettlementSweeper({ …, leaseMs })`.
- **اجاره = تأخیرِ اتمیِ سررسید**: رکوردهای فعالِ سررسیده را به ترتیبِ `(dueAtMs، شناسه)` تا `limit` می‌گیرد و `dueAtMs := nowMs + leaseMs`؛ عکسِ پس از به‌روزرسانی. تأخیرِ محض: وضعیت، قصدها، `attempts` و کدِ خطا دست‌نخورده؛ سررسید هرگز به عقب نمی‌رود. در PostgreSQL یک دستور و یک تراکنش با `FOR UPDATE SKIP LOCKED` (منتظرِ ردیفِ قفل‌شده نمی‌ماند). **بی‌مهاجرت.**
- رکوردِ اجاره‌شده برای `listDue` هم ناسررسیده است ⇒ رفتگرِ قدیمیِ بی‌اجاره هم اجاره را رعایت می‌کند؛ مرگِ دارنده ⇒ پس از `leaseMs` خودبه‌خود آزاد.
- **رفتگر:** `leaseMs` (۱…۸۶٬۴۰۰٬۰۰۰) ⇒ `claimDue` به‌جای `listDue`؛ پیش از هر رکوردِ دسته اجاره را با ساعت می‌سنجد و اگر تمام شده بود **رها** می‌کند (`raced`، رکورد دست‌نخورده). بی‌آن: رفتارِ پیشین. با outboxِ بی‌`claimDue` ⇒ `INVALID_CONFIG`. `leaseMs` را از بدترین زمانِ پردازشِ یک دسته (`limit × زمانِ دفتر`) بزرگ‌تر و از انحرافِ ساعتِ ماشین‌ها بسیار بزرگ‌تر بگیرید؛ پیشنهاد: ≤ `⌊graceMs/2⌋`.
- ⚠️ **اجاره قفلِ درستی نیست.** درستیِ مالی بر idempotencyِ دفتر و CASِ `recordFailure` (ADR-0028) می‌ماند؛ نقضِ اجاره فقط کارِ تکراریِ بی‌ضرر است. نوشتنِ درون‌خطی (`durable.*`) اجاره را نمی‌شناسد. ساعتِ سنجیدنِ اجاره ساعتِ گیرنده است (زمان از فراخواننده می‌آید).

## آزمون‌ها
حلقه (م۳‑ج): `loop-policy` (۶۱ مورد؛ جدول + خاصیتی با مرجعِ مستقل + اعتبارسنجیِ گزارش) · `sweep-loop` (پیکربندی، چرخهٔ عمر، تک‌پروازی، عقب‌نشینی، تخلیه، مشاهده‌گر، خرابیِ زمان‌سنج/ساعت/رفتگر) · `sweep-loop.integration` (دفتر و outbox واقعی، ۳۰+۲۰ بذر) · `sweep-loop.pg` (مرگِ فرایند، دو حلقه، قطعِ پایگاه). `outbox-contract` (۴۳ مورد؛ از طریق `memory-outbox.test` **و** `pg/outbox-contract.pg.test` بی‌تغییر) · `durable-ledger` · `sweeper` · `durable-gateway.integration` (حافظه‌ای و PostgreSQL؛ شکافِ ۰۰۲۰، مرگِ واقعیِ تماس، ۳۰ تماس موازی) · `settlement.property` (۴۰ بذر + ۴ بذر PostgreSQL + ادعای پوشش) · `purity`. آداپتور PostgreSQL (`pg/`): `unit` (بی‌پایگاه) · `guard` (نگهبان منبع) · `schema.pg` (قیدها، TRIGGERها، ایندکس‌ها، مهاجرت) · `concurrency.pg` (چندفرایندی) · `differential.pg` (حافظه‌ای ⇄ PostgreSQL) · `durability.pg` (مرگِ واقعیِ فرایند، اتمی‌بودن). جهشی: `python3 tooling/mutation/settlement.py` و `python3 tooling/mutation/settlement-pg.py`.
تأییدِ مرده‌ها (م۳‑د‑۱): قراردادِ مشترکِ `contract/dead-ack-contract.ts` (۱۷ مورد؛ روی حافظه‌ای و PostgreSQL بی‌تغییر) · `memory-dead-ack.test.ts` (خاصیتی: ۳۰ بذر × ۲۲۰ گام در برابر مدلِ مرجع) · `pg/dead-ack.unit.test.ts` (۱۰ مورد بی‌پایگاه: مرز، خرابی، شکلِ SQL، قفلِ checksum مهاجرتِ 0002) · `pg/dead-ack.pg.test.ts` (ناورداهای پایگاه با SQL خام، ریستارت، **ارتقا از 0001**، تفاضلیِ حافظه‌ای⇄PostgreSQL با ۱۰ بذر) · جهشی: `python3 tooling/mutation/settlement-dead-ack.py` (۳۴ جهش؛ ۳۴ کشته).
ثبتِ شکستِ تکرارپذیر (م۳‑د‑۳الف): قراردادِ مشترکِ `contract/failure-cas-contract.ts` (۱۸ مورد؛ روی حافظه‌ای و PostgreSQL بی‌تغییر) · `memory-failure-cas.test.ts` (خاصیتی: ۳۰ بذر × ۲۵۰ گام در برابر مدلِ مرجع) · `pg/failure-cas.unit.test.ts` (۲۱ مورد بی‌پایگاه: مرز، getterِ بدجنس، شکلِ SQL، خرابی) · `pg/failure-cas.pg.test.ts` (هم‌زمانیِ چندفرایندی، رقابت با `bury`، ریستارت، تفاضلیِ ۱۶ بذر) · `sweeper.failure-cas.test.ts` (دو و شش رفتگرِ هم‌زمان، عکسِ کهنه، پورتِ قدیمی/خراب) · جهشی: `python3 tooling/mutation/settlement-failure-cas.py` (۳۸ جهش؛ ۳۷ کشته + ۱ هم‌ارزِ مستند).
اجارهٔ رکوردها (م۳‑د‑۳ب): قراردادِ مشترکِ `contract/claim-contract.ts` (روی حافظه‌ای و PostgreSQL بی‌تغییر) · `memory-claim.test.ts` (خاصیتی: ۳۰ بذر × ۲۵۰ گام در برابر مدلِ مرجع) · `pg/claim.unit.test.ts` (بی‌پایگاه: مرز، getterِ بدجنس، شکلِ SQL، خرابی، ردیفِ خراب) · `pg/claim.pg.test.ts` (۶ فرایندِ هم‌زمان، `SKIP LOCKED` واقعی، رقابت با `bury`/نوشتن، ریستارت، `EXPLAIN`، تفاضلیِ ۱۶ بذر) · `sweeper.lease.test.ts` و `sweeper.lease.pg.test.ts` (حذفِ کارِ تکراری، پایانِ اجاره، مرگِ دارنده، پورتِ خراب) · جهشی: `python3 tooling/mutation/settlement-sweeper-lease.py` (۶۵ جهش؛ ۶۳ کشته + ۲ هم‌ارزِ مستند).
