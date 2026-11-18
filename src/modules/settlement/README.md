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
- چند رفتگرِ هم‌زمان ایمن‌اند ولی کار را دوباره می‌کنند (lease نیست؛ قفلِ ردیف تکرارِ هم‌زمانِ یک رکورد را سریال می‌کند). هویت، خرید: برش‌های بعد.
- رکوردهای `done` هرگز حذف نمی‌شوند (TRIGGER حذف را می‌بندد) و جدول رشد می‌کند؛ بایگانی باید با مسیرِ آگاهانه و تأییدشده بیاید. ایندکس‌های جزئی هزینهٔ رفتگر را ثابت نگه می‌دارند ولی `counts()` کل جدول را می‌شمارد.
- «ثبتِ قصد» و «تغییرِ دفتر» دو تراکنشِ جدا هستند (طراحیِ write-ahead، بسته‌شکست)؛ ادغام در یک تراکنش نیازمند تغییرِ قرارداد ledger است (کارِ جدا).
- فقط روی PostgreSQL ۱۵٫۱۹ و لینوکس آزموده شده (ویندوز نه).

## آزمون‌ها
حلقه (م۳‑ج): `loop-policy` (۶۱ مورد؛ جدول + خاصیتی با مرجعِ مستقل + اعتبارسنجیِ گزارش) · `sweep-loop` (پیکربندی، چرخهٔ عمر، تک‌پروازی، عقب‌نشینی، تخلیه، مشاهده‌گر، خرابیِ زمان‌سنج/ساعت/رفتگر) · `sweep-loop.integration` (دفتر و outbox واقعی، ۳۰+۲۰ بذر) · `sweep-loop.pg` (مرگِ فرایند، دو حلقه، قطعِ پایگاه). `outbox-contract` (۴۳ مورد؛ از طریق `memory-outbox.test` **و** `pg/outbox-contract.pg.test` بی‌تغییر) · `durable-ledger` · `sweeper` · `durable-gateway.integration` (حافظه‌ای و PostgreSQL؛ شکافِ ۰۰۲۰، مرگِ واقعیِ تماس، ۳۰ تماس موازی) · `settlement.property` (۴۰ بذر + ۴ بذر PostgreSQL + ادعای پوشش) · `purity`. آداپتور PostgreSQL (`pg/`): `unit` (بی‌پایگاه) · `guard` (نگهبان منبع) · `schema.pg` (قیدها، TRIGGERها، ایندکس‌ها، مهاجرت) · `concurrency.pg` (چندفرایندی) · `differential.pg` (حافظه‌ای ⇄ PostgreSQL) · `durability.pg` (مرگِ واقعیِ فرایند، اتمی‌بودن). جهشی: `python3 tooling/mutation/settlement.py` و `python3 tooling/mutation/settlement-pg.py`.
