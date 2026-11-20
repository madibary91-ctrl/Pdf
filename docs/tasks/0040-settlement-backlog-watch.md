# settlement-backlog-watch م۳‑ه‑۴‑الف‑۲‑۱: پایشِ زندهٔ پسماندِ زنگ برای پروب‌ها

## هدف (یک جمله)
ماژولِ `settlement-backlog-watch` که پایشِ پسماندِ زنگ را در پس‌زمینه زنده نگه می‌دارد (نمونه‌گیریِ بی‌هم‌پوشان + کش)، نمای همگامِ بی‌I/O برای پروب‌ها می‌دهد، پیش‌فرض‌های امنِ قابل‌تنظیم دارد و سیاستِ تأییدشدهٔ مالک را قفل می‌کند: «پسماند هرگز liveness را ۵۰۳ نمی‌کند و فقط در ready و startup گزارش می‌شود».

## زمینه
تحویل ۰۰۴۱ «گام بعد ۱»، ADR-0039 (تصمیم ۶: «نگاشتِ HTTP و ترکیب عمداً ساخته نشد»)، ADR-0030، ADR-0032/0033، تأییدِ مالکِ محصول در گفت‌وگوی تحویلِ ۰۰۴۱، ADR-0042.

## ماژول و پوشه‌های مجاز
`src/modules/settlement-backlog-watch/` (ماژولِ تازه، کاملاً)، `src/modules/registry.ts` (فقط یک ردیف)، `tooling/git-discipline.ts` (فقط افزودنِ نامِ ماژول به `HIGH_RISK_MODULES`)، `tooling/mutation/settlement-backlog-watch.py`، `tooling/ci-tests.ts` (فقط کف)، `docs/`.

## ممنوع
هر فایل در دیگر ماژول‌ها (از جمله `settlement`، `settlement-backlog`، `settlement-runtime`، `settlement-host`، `settlement-bootstrap`)، `src/app/`، `package.json`، **هر آزمونِ موجود**، `vitest.config.ts`، افزودنِ وابستگیِ خارجی، تغییرِ بدنهٔ پروب‌ها.

## قرارداد
بی‌تغییر برای همهٔ ماژول‌های موجود. قراردادِ تازه: `src/modules/settlement-backlog-watch/types.ts`؛ صادرات: `createBacklogWatch`، `projectBacklogForProbe`، `parseBacklogWatchEnv`، `SETTLEMENT_BACKLOG_WATCH_{DEFAULTS,LIMITS,ENV}`.

## معیار پذیرش
1. پیش‌فرض‌های امن (۱/۱۰/۱ساعت/۲۴ساعت/۳۰ثانیه/۵ثانیه/`report`) قفل و همه قابل‌تنظیم (کد و env)؛ کفِ کهنگی `sampleMaxAgeMs ≥ intervalMs + 2×timeoutMs`؛ مقدارِ اشتباه هرگز در پیام نمی‌آید.
2. `live` هرگز گزارش یا مسدود نمی‌شود؛ `startup` گزارش می‌شود و هرگز مسدود نمی‌کند؛ `ready` فقط با `gate_down` و `down` مسدود می‌کند؛ نمای خراب ⇒ `unknown` و بی‌مسدودسازی؛ خاصیتی روی ۳۰۰۰ نما.
3. حلقه: نمونهٔ اول بی‌تأخیر، یک خواندن در هر فاصله، بی‌هم‌پوشانی، `stop` بی‌آویز با `abandonedRead`، نسل (پاسخ و تیکِ لغوناپذیرِ قدیمی بی‌اثر)، `stalled` دیده‌شدنی، زمان‌سنج بی‌نشت.
4. شکستِ گذرا شدتِ شناخته‌شده را پایین نمی‌آورد؛ بی‌نمونه `unknown`؛ نمونهٔ سالم با گذشتِ زمان کهنه می‌شود (مرزِ اکیدِ `>`)؛ حلقهٔ سالم هرگز کهنه گزارش نمی‌شود.
5. نما منجمد، JSON‌پذیر و بی‌نشت (شناسه، مبلغ، پیامِ پایگاه، رشتهٔ اتصال).
6. روی outboxِ حافظه‌ایِ واقعیِ `settlement`: مرده‌ها دیده، با تأیید تخلیه، و پایش هیچ‌چیز را عوض نمی‌کند.
7. نگهبانِ منبع: فقط رابطِ عمومیِ `settlement`/`settlement-backlog`، بی‌ساعت/تایمرِ سراسری/`process`، `catch` بی‌متغیر، بی‌دست‌زدن به متدهای outbox.
8. آزمونِ جهشی بدونِ زنده‌ٔ توضیح‌نشده.

## تست‌های مورد انتظار
عادی، مرزی (`>`، سقف‌ها، ۱۶ دلیل)، خطا (outbox/ساعت/زمان‌سنج/Proxy/getter)، خاصیتی (سیاستِ پروب)، زمان مجازی برای حلقه، نگهبانِ منبع.

## خارج از کار
اتصال به `settlement-bootstrap`/`/api/health/*`، تغییرِ بدنهٔ HTTP، آزمونِ سرتاسریِ PostgreSQL (الف‑۲‑۲/۳)، `deliver`ِ واقعی (ب)، شمارِ کلِ دقیق.

## وابستگی‌ها
ADR-0039، ADR-0030، ADR-0032، ADR-0033، تحویل ۰۰۴۱.

## فایل‌های مرجع برای خواندن
`docs/adr/0042-settlement-backlog-watch.md`، `docs/adr/0039-settlement-backlog-monitor.md`، `src/modules/settlement-backlog/types.ts`، `src/modules/settlement-host/probes.ts` (سیاستِ پروب‌ها).

## بازبینی و ریسک
ناحیهٔ پرریسک (`settlement-backlog-watch`) ⇒ `Risk-Tag`. بازبین: مالک معماری + متخصص مالی + مالک امنیت.
