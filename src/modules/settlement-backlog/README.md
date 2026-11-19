# settlement-backlog

پایشِ **پسماندِ زنگِ ماندگار** (م۳‑ه‑۴‑الف‑۱، ADR-0039): چند رکوردِ مرده (`dead`) هنوز **تأیید رسیدگی نشده‌اند** و قدیمی‌ترینشان چند وقت است منتظر است؟
`SweepLoopStatus.deadLetters` فقط شمارنده است و «تخلیهٔ کُندِ پسماند بدونِ شکست» را `ok` می‌دید (محدودیتِ ADR-0030)؛ این ماژول همان شکاف را می‌بندد.
**هیچ قراردادی از `settlement` عوض نشد** (نه `SweepLoopStatus`، نه `SweepHealth`)؛ ماژول فقط‌خواندنی است و به `settlement` (رابط عمومی) وابسته است.

## استفاده
```ts
const made = createDeadLetterBacklogMonitor({
  outbox,                 // هر چیزی با listUnacknowledgedDead (مثلاً createPgSettlementOutbox)
  clock,                  // { nowMs() }
  degradedCount: 10, downCount: 50,            // شمار: ≥ ۱ و ≤ sampleLimit
  degradedAfterMs: 900_000, downAfterMs: 3_600_000, // سنِ قدیمی‌ترین؛ اکیداً «>»
  sampleMaxAgeMs: 120_000,                     // نمونهٔ قدیمی‌تر از این ⇒ SAMPLE_STALE
  // اختیاری: sampleLimit (۱…۱۰۰۰؛ پیش‌فرض ۱۰۰۰)، timer + timeoutMs (مهلتِ خواندن)
});
if (!made.ok) throw new Error(made.error.issues.join("; "));
const health = await made.value.check();   // نمونه‌گیری + ارزیابی؛ هرگز نمی‌پرتابد
// یا جدا: const s = await monitor.sample();  …  monitor.evaluate({ sample: s, nowMs })  (خالص، همگام)
```
اعداد بالا فقط **مثال‌اند**؛ آستانه‌ها عمداً الزامی‌اند و پیش‌فرض ندارند (قاعدهٔ ۹ AGENTS.md): سیاستِ «چند مرده و چه مدت قابل‌تحمل است» تصمیمِ عملیاتیِ مالک است.

## ناورداها
- **فقط‌خواندنی:** تنها I/O یک فراخوانیِ `listUnacknowledgedDead` است؛ هیچ‌چیز را تأیید/ثبت نمی‌کند (آزمونِ منبع و آزمونِ دیدنیِ «outbox دست‌نخورده»).
- **بی‌پرتاب:** `sample`، `evaluate` و `check` هرگز نمی‌پرتابند؛ ساعتِ خراب، outboxِ خراب، Proxy/getterِ بدجنس و پاسخِ بدشکل همه کدِ بسته‌اند.
- **شکستِ بسته:** فهرستِ بدشکل (رکوردِ غیرِ‌مرده، تکراری، دلیلِ ناشناخته، بیش از سقف) ⇒ کلِ نمونه `BAD_LIST`؛ نمونهٔ ناسازگار (جمعِ دلیل‌ها ≠ شمار، `truncated` ناهمخوان با سقف، …) ⇒ `INPUT_INVALID` (`down`). «نمی‌دانم» هرگز `ok` نیست.
- **بی‌نشت:** نتیجه فقط عدد و کدِ شمارشی دارد؛ شناسه‌ها، مبلغ‌ها، کدِ خطای رکورد و پیامِ پورت هرگز نمی‌آیند.
- **یکنوایی:** با ثابت‌ماندنِ نمونه، جلو رفتنِ ساعت هرگز سلامت را بهتر نمی‌کند. نمونهٔ کهنه (`SAMPLE_STALE`) «پسماندِ صفر» را سالم اعلام نمی‌کند.
- **بریدنِ فهرست آستانه را پنهان نمی‌کند:** `downCount ≤ sampleLimit` الزامی است؛ فهرستِ به‌سقف‌رسیده (`truncated`) دست‌کم `down` است. `count` در این حالت «حداقل» است؛ قدیمی‌ترین همچنان دقیق است (کمینهٔ `settledAtMs`، بی‌اتکا به ترتیب).
- **بی‌تایمرِ سراسری:** مهلتِ خواندن فقط با `timer` تزریقی؛ تایمرِ ساخته‌شده در هر مسیرِ پایانی لغو می‌شود و پاسخِ دیرهنگام نادیده است.

## دلیل‌ها (`BacklogReasonCode`)
`COUNT_HIGH` (degraded) / `COUNT_CRITICAL` (down)، `OLDEST_AGED` (degraded) / `OLDEST_STUCK` (down)، `SAMPLE_STALE`، `CLOCK_BEHIND`، `AGE_UNKNOWN` و `SAMPLE_UNREADABLE` (همه degraded)، `INPUT_INVALID` (down).
ساعتِ نامعتبر در `check()` ⇒ `down` (مثلِ `health.ts`)؛ outbox ناخوانا ⇒ `degraded` (ریستارت خواندنِ outbox را درست نمی‌کند).

## صادرات
`createDeadLetterBacklogMonitor`، `SETTLEMENT_BACKLOG_LIMITS` + نوع‌ها.

## آزمون‌ها
`config.test.ts` (مرزها و الزامی‌بودنِ آستانه‌ها)، `sample.test.ts` (outbox حافظه‌ای واقعی، outboxهای خراب، ساعت، مهلت)، `evaluate.test.ts` (هر قاعده و مرزِ `>`/`≥`، ترتیب، شکستِ بسته، `check()`)، `evaluate.property.test.ts` (مرجعِ مستقل، یکنوایی، خراب‌سازی)، `backlog.integration.test.ts` (روی `createSweepLoop` واقعی با زمانِ مجازی)، `backlog.pg.test.ts` (PostgreSQL واقعی)، `purity.test.ts` (نگهبانِ منبع). جهشی: `python3 tooling/mutation/settlement-backlog.py`.

## محدودیت‌ها (صادقانه)
- **به `/api/health` وصل نیست.** ترکیب با `SweepHealth`، نگاشتِ `down`ِ پسماند به کدِ HTTP (پروبِ liveness یا readiness؟) و نمونه‌گیریِ پس‌زمینه با کشِ `health()` همگام، برشِ بعد است و **تصمیمِ معماری** می‌خواهد (ADR-0039).
- `deliver`ِ واقعی (مقصدِ زنگ) نیست؛ این ماژول فقط می‌سنجد که زنگ **نرسیده**.
- شمار فقط تا `sampleLimit` دقیق است (بعد از آن «حداقل»)؛ شمارِ کلِ دقیقِ تأییدنشده‌ها نیازمندِ متدِ تازه در پورتِ outbox است که قرارداد را عوض می‌کند و عمداً ساخته نشد.
- ساعتِ تزریقی و outbox باید هم‌منبع باشند (`settledAtMs` را همان ساعتِ رفتگر می‌نویسد)؛ ناهمخوانی ساعت‌ها در `CLOCK_BEHIND` دیده می‌شود، نه جبران.
