# tool-policy-refresher (لایهٔ ۶ · خالص · 🔴 بازبینی انسانیِ اجباری: مالک امنیت) — برش CT‑5c‑2c‑2a

**هدف:** `source.refresh()` را با زمان‌سنجِ **تزریقی** دوره‌ای صدا بزند، بی‌آنکه تلاشِ بی‌پاسخ حلقه را قفل کند. تصمیم‌ها: `docs/adr/0072-tool-policy-refresher.md`.

## رابط
```ts
const r = createPolicyRefresher({ source, timer, intervalMs, retryMs, attemptDeadlineMs, refreshTimeoutMs, maxStaleMs });
if (!r.ok) /* INVALID_CONFIG؛ issues فقط نامِ فیلد */;
r.value.start();        // همگام؛ نخستین تلاش بی‌درنگ؛ { started } | { started:false, reason }
await r.value.stop();   // مرتب؛ حداکثر تا attemptDeadlineMs صبر؛ { stopped:true, abandonedInFlight }
r.value.status();       // همگام و بی‌I/O: state، inFlight، attempts، consecutiveFailures، lastOutcome، lastFailure
```
- `timer` = `{ after(fn, ms), cancel(handle) }` (هم‌شکلِ `createNodeTimer`ِ settlement-runtime). ماژول `setTimeout` را نمی‌شناسد.
- پس از موفقیت تلاشِ بعد با `intervalMs`، پس از شکست/بی‌پاسخی/رهاشدن با `retryMs`؛ هرگز هم‌زمان دو تلاش.
- هر تلاش نگهبانِ مهلتِ `attemptDeadlineMs` دارد؛ بی‌پاسخ ⇒ `timed_out` و حلقه ادامه می‌دهد (منبع تلاشِ قدیمی را پس از `refreshTimeoutMs` رها می‌کند).
- نتیجهٔ منبع ورودیِ ناشناخته است؛ فقط `ok === true` موفقیت است؛ `SUPERSEDED` شکست نیست.
- شکستِ زمان‌بندی ⇒ `halted` (`SCHEDULE_FAILED`)؛ منبع به‌زودی `STALE` (بسته) می‌شود؛ `start()` بازیابی می‌دهد.

## رابطه‌های پیکربندی (در ساخت سنجیده می‌شوند)
`retryMs ≤ intervalMs` · `refreshTimeoutMs ≤ attemptDeadlineMs` · `intervalMs + 3·attemptDeadlineMs + retryMs ≤ maxStaleMs` (یک چرخهٔ ازدست‌رفته بدونِ `STALE`؛ دو چرخهٔ پیاپی عمداً `STALE`). `refreshTimeoutMs` و `maxStaleMs` باید همان مقدارهای منبع باشند. عددِ پیش‌فرض نیست.

## آزمون‌ها
`config.test.ts`، `refresher.test.ts`، `property.test.ts` (۳۰۰ بذر × ۶۰ گام در برابرِ ماشینِ حالتِ مستقل)؛ در `tooling/`: `tool-policy-refresher-source.test.ts` (نگهبانِ منبع) و `tool-policy-refresher-admin.test.ts` (منبع و مدیرِ نسخه‌دارِ واقعی). جهش‌آزمایی: `python3 tooling/mutation/tool-policy-refresher.py`.

## خارج از کار
ریشهٔ I/O (ساختنِ زنجیره، `createNodeTimer`، ساعتِ یکنوا، `tuning` واحد)، سیم‌کشیِ `projection`، `requestId`، CLI، jitter.
