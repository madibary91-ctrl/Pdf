# settlement (لایهٔ ۴ · غیرخالص · **بازبینی انسانیِ اجباری: مالک امنیت/مالی**) — **م۳‑الف: outbox و رفتگر تسویه**

**هدف:** هیچ تغییرِ دفتر بدون ردّ ماندگارِ پیشین؛ تسویه‌های شکست‌خورده و رزروهای یتیمِ مرگِ فرایند با تکرارِ idempotent بسته می‌شوند؛ هر مرگِ خودکار صدا می‌دهد. تصمیم‌ها و دلیل‌ها: `docs/adr/0021-settlement.md`.
**وابستگی:** طبق `registry.ts` فقط `ledger` و `metering` (رابط عمومی). به شبکه، فایل، `process.env`، ساعت سیستم، تایمر و تصادف دست نمی‌زند؛ **ساعت و outbox و دفتر تزریق می‌شوند** (آزمونِ نگهبان این را می‌سنجد).

> ⚠️ **ماندگاریِ واقعی هنوز نیست.** `createMemoryOutbox` با ریستارت می‌رود؛ outbox PostgreSQL برش م۳‑ب است (همان `describeOutboxContract`). تا آن‌گاه «مرگِ فرایند» فقط وقتی پوشش داده می‌شود که outbox از فرایند زنده‌تر باشد. بازبینی مالک امنیت/مالی انجام نشده؛ **هنوز به پول واقعی وصل نکنید.**

## ترکیب
```ts
const outbox = createMemoryOutbox();                         // م۳‑ب: PostgreSQL
const made = createDurableMeteredGateway({                    // = MeteringConfig + outbox + clock + graceMs
  gateway, ledger /* دفتر خام */, account, currency, models, scopeId,
  reservationTtlMs: 60_000, maxProviderCalls: 1, perMessageOverheadTokens: 10, onUnknownCost: "forfeit",
  outbox, clock, graceMs: 10_000,                             // graceMs > زمانِ کل یک تماس؛ ≤ ttl/2
});                                                           // SettlementResult<MeteredGateway> — ارکستراتور بی‌تغییر آن را می‌گیرد
const sweeper = createSettlementSweeper({ ledger /* همان دفتر خام */, outbox, clock });
const report = await sweeper.sweep();                         // هر ≤ graceMs از ریشهٔ ترکیب؛ report.buried غیرتهی ⇒ زنگ
```
رفتگر دفتر **خام** می‌گیرد (دفتر دکوراته‌شده رد می‌شود). `createDurableLedger` همان دکوراتور را جدا می‌دهد (برای کاربردی بی‌metering).

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

## محدودیت‌های صادقانه
- `graceMs` باید از زمانِ کل تماس بیشتر باشد (وگرنه رفتگر زیرِ دستِ تماسِ زنده می‌بندد و تماس طبق سیاست تسویه می‌شود) و رفتگر باید **پیش از سررسید رزرو** (≤ `ttl − graceMs`) اجرا شود (وگرنه `EXPIRED_UNBILLED`).
- سیاستِ `release` + از کار افتادنِ outbox پس از تماس ⇒ هزینهٔ معلوم گم می‌شود (`forfeit` می‌پوشاندش، با جریمهٔ کاربر): تصمیمِ محصول/مالی.
- هزینهٔ **نامعلومِ** با کفِ معلوم که پیش از `close` فرایندش بمیرد: بخش نامعلوم `release` می‌شود (بی‌بیش‌اخذ) نه سوخت.
- چند رفتگرِ هم‌زمان ایمن‌اند ولی کار را دوباره می‌کنند (lease نیست). زمان‌بند، هویت، خرید، بایگانی: برش‌های بعد.

## آزمون‌ها
`outbox-contract` (۴۳ مورد؛ از طریق `memory-outbox.test`) · `durable-ledger` · `sweeper` · `durable-gateway.integration` (حافظه‌ای و PostgreSQL؛ شکافِ ۰۰۲۰، مرگِ واقعیِ تماس، ۳۰ تماس موازی) · `settlement.property` (۴۰ بذر + ۴ بذر PostgreSQL + ادعای پوشش) · `purity`. جهشی: `python3 tooling/mutation/settlement.py`.
