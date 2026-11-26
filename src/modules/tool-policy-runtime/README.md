# tool-policy-runtime (لایهٔ ۷ · I/O · 🔴 بازبینی انسانیِ اجباری: مالک امنیت) — برش CT‑5c‑2c‑2b‑1

**هدف:** زنجیرهٔ `ذخیره‌ساز PG ← مدیر ← منبع ← حلقه` را روی **یک `db` و یک `tuning`** بسازد و چرخهٔ عمرِ مرتبِ آن را بدهد. تصمیم‌ها: `docs/adr/0073-tool-policy-runtime.md`.

## رابط
```ts
const r = createPgToolPolicyRuntime({ db, schema?, statementTimeoutMs?, tuning, clock?, wallClock?, timer? });
if (!r.ok) /* INVALID_CONFIG؛ issues فقط نامِ فیلد، هرگز مقدار */;
const rt = r.value;
await rt.start();   // پیش‌بازرسیِ فقط‌خواندنی ← آغازِ حلقه؛ { started:true } | { started:false, reason }
rt.health();        // همگام: { state, ready, reason, source, refresher } — فقط کد و عدد
rt.snapshot();      // مسیرِ داغِ همگام (همان source.snapshot؛ کهنه‌تر از maxStaleMs هرگز)
await rt.stop();    // مرتب، idempotent؛ { stopped:true, abandonedInFlight }
```
- `tuning = { intervalMs, retryMs, attemptDeadlineMs, refreshTimeoutMs, maxStaleMs }` — **یک بار** خوانده می‌شود و همان به منبع و حلقه می‌رسد. رابطه‌ها (`interval + 3·deadline + retry ≤ maxStale`، `retry ≤ interval`، `refreshTimeout ≤ deadline`) را خودِ حلقه می‌سنجد؛ issues با پیشوندِ `tuning:`. عددِ پیش‌فرض نیست.
- `statementTimeoutMs ≤ refreshTimeoutMs` (پایگاه تلاش را پیش از رهاکردنِ منبع قطع کند)؛ پیش‌فرض `min(۵۰۰۰، refreshTimeoutMs)`.
- ساعت دو تاست: `clock` **یکنوا** (پیش‌فرض `createMonotonicClock()`) برای سنِ تأییدِ منبع؛ `wallClock` فقط برای مهرِ نوشتنِ مدیر که این ریشه هرگز صدا نمی‌زند.
- **هرگز مهاجرت نمی‌کند و نمی‌نویسد.** `start` فقط `store.status()` را (با نگهبانِ مهلتِ `attemptDeadlineMs`) می‌خواند: `NOT_MIGRATED` | `SCHEMA_MISMATCH` | `UNAVAILABLE` ⇒ حلقه راه نمی‌افتد.
- `start` نخستین تازه‌سازی را منتظر نمی‌ماند؛ آمادگی از `health().ready` (فقط وقتی `RUNNING` + حلقهٔ `running` + منبعِ `FRESH`). دلیلِ ناآمادگی کدِ ثابت است.
- `stop` در میانهٔ `start` ⇒ حلقه هرگز راه نمی‌افتد (`STOPPED_DURING_START`). پس از `stop`، `snapshot()` خودبه‌خود پس از `maxStaleMs` بسته می‌شود.
- ماژول اتصال نمی‌سازد و استخر را نمی‌بندد (مالکِ استخر برنامه است).

## آزمون‌ها
`runtime.test.ts` (چرخهٔ عمر، سلامت، مدل‌محور ۲۰۰ بذر)، `config.test.ts`، `clock.test.ts`؛ در `tooling/`: `tool-policy-runtime-source.test.ts` (نگهبانِ منبع) و `tool-policy-runtime.pg.test.ts` (PostgreSQL واقعی). جهش‌آزمایی: `python3 tooling/mutation/tool-policy-runtime.py`.

## خارج از کار
سیم‌کشیِ `snapshot().projection` به زنجیرهٔ دروازه، `requestId`/ثبتِ `version` در لاگِ رزرو، CLIِ مهاجرتِ جدا (2c‑3)، HTTP/UI، بوتِ فرایندی (نگه‌داریِ singleton و SIGTERM)، jitter.
