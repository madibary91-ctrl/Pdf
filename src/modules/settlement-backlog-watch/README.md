# settlement-backlog-watch

پایشِ **زندهٔ** پسماندِ زنگِ ماندگار (م۳‑ه‑۴‑الف‑۲‑۱، ADR-0042). `settlement-backlog` می‌تواند پسماند را بسنجد، ولی پروب‌ها **همگام و بی‌I/O**‌اند و خواندنِ پسماند ناهمگام است؛
این ماژول واسطهٔ بین آن دو است: یک حلقهٔ پس‌زمینه نمونه می‌گیرد و کش می‌کند، و `view()` همگام همان کش را با ساعتِ همین لحظه ارزیابی می‌کند.
**هیچ قراردادی عوض نشد** (نه `settlement`، نه `settlement-backlog`، نه `settlement-runtime`/`-host`)؛ و هنوز به `/api/health/*` وصل **نیست** (برش الف‑۲‑۲).

## سیاستِ تأییدشدهٔ مالک (قفل‌شده در کد و آزمون)
**پسماند هرگز liveness را ۵۰۳ نمی‌کند و فقط در `ready` و `startup` گزارش می‌شود.**

| پروب | گزارش | مسدود می‌کند؟ |
|---|---|---|
| `live` (و هر نوعِ ناشناخته) | هرگز | هرگز |
| `startup` | بله | هرگز |
| `ready` | بله | فقط با `readyPolicy:"gate_down"` **و** وضعیتِ `down` (پیش‌فرض `report` ⇒ هرگز) |

نمای خراب/ناخواندنی ⇒ بخشِ `unknown` و **بی‌مسدودسازی** («نمی‌دانم» ۵۰۳ نمی‌سازد).

## استفاده
```ts
const made = createBacklogWatch({
  outbox,            // هر چیزی با listUnacknowledgedDead (مثلاً createPgSettlementOutbox)
  clock,             // { nowMs() } — هم‌منبعِ ساعتِ رفتگر
  timer,             // LoopTimer ({ after, cancel }) — مثلاً createNodeTimer()
  // همهٔ موارد زیر اختیاری‌اند و پیش‌فرضِ امن دارند:
  // intervalMs, timeoutMs, degradedCount, downCount, degradedAfterMs, downAfterMs, sampleMaxAgeMs, sampleLimit, readyPolicy
  ...(parsedEnv.ok ? parsedEnv.value : {}),   // parseBacklogWatchEnv(process.env)
});
if (!made.ok) throw new Error(made.error.issues.join("; "));
made.value.start();                    // همگام؛ نمونهٔ اول بی‌انتظار آغاز می‌شود
// در پروب (همگام، بی‌I/O):
const { section, blocks } = projectBacklogForProbe("ready", made.value.view());
// section ⇒ در بدنه؛ blocks ⇒ ۵۰۳ (فقط ready ∧ gate_down ∧ down)
made.value.stop();                     // همگام؛ هرگز منتظرِ پایگاه نمی‌ماند
```

## پیش‌فرض‌های امن (همه قابل‌تنظیم)
`degradedCount=1`، `downCount=10`، `degradedAfterMs=۱ساعت`، `downAfterMs=۲۴ساعت`، `intervalMs=۳۰ثانیه`، `timeoutMs=۵ثانیه`، `sampleLimit=۱۰۰۰`، `sampleMaxAgeMs=2×interval+4×timeout`، `readyPolicy="report"`.
دلیلِ هر عدد در ADR-0042 تصمیم ۳. اینها پیشنهادِ عملیاتی‌اند، نه عددِ مرجعِ حقوقی/مالی. **کفِ کهنگی:** `sampleMaxAgeMs ≥ intervalMs + 2×timeoutMs` (وگرنه پایشِ سالم هم «کهنه» گزارش می‌شد).

## متغیرهای محیط (برای bootstrapِ برشِ بعد؛ `parseBacklogWatchEnv` خالص است)
`SETTLEMENT_BACKLOG_INTERVAL_MS`، `_TIMEOUT_MS`، `_DEGRADED_COUNT`، `_DOWN_COUNT`، `_DEGRADED_AFTER_MS`، `_DOWN_AFTER_MS`، `_SAMPLE_MAX_AGE_MS`، `_SAMPLE_LIMIT`، `_READY_POLICY` (`report`|`gate_down`).
خالی/نبود ⇒ پیش‌فرض؛ فقط رقمِ لاتینیِ مثبت؛ کلیدِ ناشناختهٔ `SETTLEMENT_BACKLOG_*` خطا؛ مقدار هرگز در پیام نمی‌آید.

## ناورداها
- **بی‌هم‌پوشان:** نمونهٔ بعد پس از پایانِ جاری + `intervalMs` (زنجیرهٔ `after`)؛ پایگاهِ کُند انباشتِ خواندن نمی‌سازد.
- **پروب بی‌I/O:** `view()` فقط کش و ساعت را می‌خواند.
- **شکستِ گذرا شدت را پایین نمی‌آورد:** آخرین نمونهٔ **سالم** می‌ماند و فقط `SAMPLE_UNREADABLE` اضافه می‌شود؛ نمونه خودش کهنه می‌شود (`SAMPLE_STALE`). بی‌نمونه ⇒ `unknown` (هرگز `ok`).
- **نسل:** پاسخِ خواندنِ رهاشده و تیکِ زمان‌سنجِ لغوناپذیرِ نسلِ قبل کش را دست نمی‌زنند.
- **`stop` همگام و بی‌آویز** (`abandonedRead`)؛ `stalled` دیدنی؛ هیچ متدی نمی‌پرتابد؛ ساعتِ خراب در `view` ⇒ `down` (شکستِ بسته).
- **بی‌نشت:** فقط عدد و کد؛ شناسه، مبلغ، پیامِ پایگاه، رشتهٔ اتصال هرگز؛ `catch` همه بی‌متغیرند (آزمونِ منبع).
- **فقط‌خواندنی:** به هیچ متدِ outbox مستقیم دست نمی‌زند (خواندن فقط از راهِ `settlement-backlog`).

## صادرات
`createBacklogWatch`، `projectBacklogForProbe`، `parseBacklogWatchEnv`، `SETTLEMENT_BACKLOG_WATCH_DEFAULTS`، `SETTLEMENT_BACKLOG_WATCH_LIMITS`، `SETTLEMENT_BACKLOG_WATCH_ENV` + نوع‌ها.

## آزمون‌ها
`config.test.ts`، `env.test.ts`، `view.test.ts`، `probe.test.ts` (جدولی/بدجنس/خاصیتی + روی نمای واقعی)، `watch.test.ts` (زمان مجازی؛ outboxِ ساختگی و outboxِ حافظه‌ایِ واقعی)، `purity.test.ts`. همه بی‌پایگاه‌اند. جهشی: `tooling/mutation/settlement-backlog-watch.py`.

## محدودیت‌ها
به `/api/health/*` وصل نیست (الف‑۲‑۲)؛ آزمونِ سرتاسریِ PostgreSQL ندارد (الف‑۲‑۳)؛ پس از `stop`+`start` فوری ممکن است یک خواندنِ رهاشده هم‌زمان باشد (با مهلتِ خودش تمام می‌شود)؛ شمارِ کلِ دقیقِ پسماند فراتر از `sampleLimit` نیست.
