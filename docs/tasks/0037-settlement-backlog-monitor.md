# settlement-backlog م۳‑ه‑۴‑الف‑۱: پایشِ پسماندِ زنگِ ماندگار

## هدف (یک جمله)
ماژولِ فقط‌خواندنیِ `settlement-backlog` که شمارِ مرده‌های تأییدنشدهٔ outbox و سنِ قدیمی‌ترینشان را بی‌پرتاب نمونه‌گیری و با آستانه‌های الزامیِ مالک به `ok/degraded/down` ارزیابی کند.

## زمینه
تحویل ۰۰۳۸ «گام بعد ۱» (م۳‑ه‑۴‑الف)، ADR-0030 («پسماندِ زنگ دیده نمی‌شود»)، ADR-0025/0026 (تأیید و زنگِ ماندگار)، ADR-0039.

## ماژول و پوشه‌های مجاز
`src/modules/settlement-backlog/` (ماژولِ تازه، کاملاً)، `src/modules/registry.ts` (فقط یک ردیف)، `tooling/git-discipline.ts` (فقط افزودنِ نامِ ماژول به `HIGH_RISK_MODULES`)، `tooling/ci-tests.ts` (فقط کف)، `tooling/mutation/` (اسکریپتِ تازه)، `docs/` (ADR، task، `high-risk-areas.md`، `known-pitfalls.md`، یادداشتِ تحویل).

## ممنوع
هر فایل در `src/modules/settlement/` و دیگر ماژول‌ها (از جمله `SweepLoopStatus`، `SweepHealth`، پورتِ `SettlementOutbox`)، `src/app/`، `package.json`، **هر آزمونِ موجود**، ADR/یادداشت/taskِ قدیمی، نگاشتِ HTTP و ترکیب با `/api/health`.

## قرارداد
بی‌تغییر برای همهٔ ماژول‌های موجود. قراردادِ تازه: `src/modules/settlement-backlog/types.ts`.

## معیار پذیرش
1. هر آستانه الزامی و اعتبارسنجی‌شده؛ `degradedCount ≤ downCount ≤ sampleLimit`، `degradedAfterMs ≤ downAfterMs`؛ کلیدِ ناشناخته و `timeoutMs` بدونِ `timer` رد؛ مقدار هرگز پژواک نمی‌شود.
2. نمونه‌گیری فقط `listUnacknowledgedDead` را می‌خواند؛ هر خرابیِ outbox/ساعت/زمان‌سنج یک کدِ بسته است و هیچ‌چیز نمی‌پرتابد؛ فهرستِ بدشکل کلِ نمونه را `BAD_LIST` می‌کند.
3. مرزهای دقیقِ `≥` (شمار) و `>` (سن، کهنگی)؛ قدیمی‌ترین کمینهٔ `settledAtMs` است و با بریدنِ فهرست دقیق می‌ماند؛ فهرستِ بریده‌شده دست‌کم `down` است.
4. نمونهٔ ناسازگار/ناخوانا هرگز `ok` نیست؛ ساعتِ نامعتبر در `check()` `down` است؛ نتیجه بی‌نشت و منجمد است.
5. با حلقهٔ واقعیِ `createSweepLoop`: `deliver`ِ خراب ⇒ حلقه `running` ولی پایش `down` (پسماندِ پیر)؛ بهبود ⇒ `ok`.
6. روی PostgreSQL واقعی همان معنا؛ تأیید ماندگار؛ قطعِ پایگاه ⇒ `degraded`.
7. نگهبانِ منبع: فقط رابطِ عمومیِ `settlement`، بی‌ساعت/تایمرِ سراسری/`process`، تنها متدِ خوانده‌شده `listUnacknowledgedDead`.
8. آزمونِ جهشی بدونِ زنده‌ٔ توضیح‌نشده.

## تست‌های مورد انتظار
عادی (پسماندِ صفر/کم/زیاد)، مرزی (برابری، یک میلی‌ثانیه بالا/پایین، سقفِ فهرست)، خطا (outbox/ساعت/زمان‌سنج/Proxy)، خاصیتی (مرجعِ مستقل، یکنوایی، خراب‌سازیِ تصادفی)، یکپارچگی (حلقهٔ واقعی، PostgreSQL).

## خارج از کار
اتصال به `/api/health`، نمونه‌گیریِ پس‌زمینه، نگاشتِ HTTP، `deliver`ِ واقعی، شمارِ کلِ دقیق (تغییرِ پورت)، هشدار/ارسالِ اعلان.

## وابستگی‌ها
ADR-0025، ADR-0026، ADR-0030، تحویل ۰۰۳۸.

## فایل‌های مرجع برای خواندن
`docs/adr/0039-settlement-backlog-monitor.md`، `src/modules/settlement/health.ts` (قراردادِ `>`/شکستِ بسته)، `src/modules/settlement/types.ts` (`OutboxEntry`، `listUnacknowledgedDead`، `LoopTimer`).
