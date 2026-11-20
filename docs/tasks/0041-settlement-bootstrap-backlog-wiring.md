# settlement-bootstrap م۳‑ه‑۴‑الف‑۲‑۲: سیم‌کشیِ پایشِ زندهٔ پسماندِ زنگ به بوت و پروب‌های HTTP

## هدف (یک جمله)
در `settlement-bootstrap`، با کلیدِ صریحِ `SETTLEMENT_BACKLOG_WATCH=on`، پایشِ `settlement-backlog-watch` را روی outboxِ PostgreSQLِ رفتگر بسازد، با چرخهٔ عمرِ host هم‌راستا شروع/متوقف کند و در بدنهٔ `ready/startup` گزارش دهد (`gate_down ∧ down` فقط `ready` را ۵۰۳ کند).

## زمینه
تحویل ۰۰۴۲ «گام بعد ۱» (الف‑۲‑۲)، ADR-0042 (سیاستِ پروب، پیش‌فرض‌ها)، ADR-0039، ADR-0033، ADR-0032، ADR-0043، اختیارِ مالکِ محصول در گفت‌وگوی تحویلِ ۰۰۴۲.

## ماژول و پوشه‌های مجاز
`src/modules/settlement-bootstrap/` (فایل‌های منبعِ موجود: `bootstrap.ts`، `env.ts`، `http.ts`، `types.ts` + آزمون‌ها و README)، `src/modules/registry.ts` (فقط `dependsOn`/توضیحِ همین ماژول)، `tooling/mutation/settlement-bootstrap-backlog.py`، `tooling/ci-tests.ts` (فقط کف)، `docs/`.

## ممنوع
هر فایل در دیگر ماژول‌ها (از جمله `settlement-backlog-watch`، `settlement-host`، `settlement-runtime`، `settlement`)، `src/app/`، `src/instrumentation*.ts`، `package.json`، `vitest.config.ts`، وابستگیِ خارجیِ تازه، فایلِ منبعِ تازه و صادراتِ تازه در `settlement-bootstrap`، **هر آزمونِ موجود به‌جز** فهرستِ importهای مجاز در `purity.test.ts` (با `Test-Change-Approved`)، تغییرِ بدنهٔ `live`.

## قرارداد
بدون کلید: بایت‌به‌بایت بی‌تغییر. با کلید: `BootstrapSettings.backlog?`، `BootstrapErrorCode += "BACKLOG_INVALID"`، `BootstrapEvent += "bootstrap.backlog_watch"`، کلیدِ اختیاریِ `backlog` در بدنهٔ `ready/startup` (ADR-0043).

## معیار پذیرش
1. کلید `on|off` شکست‌بسته؛ آستانهٔ تنظیم‌شده بی‌کلید `INVALID_ENV`؛ نام‌ها از ماژولِ watch؛ مقدار هرگز در پیام؛ حالتِ خاموش خروجیِ پیشین.
2. نقصِ آستانه ⇒ `BACKLOG_INVALID` پیش از ساختنِ میزبان و پایگاه بسته.
3. پایش فقط با `booted` شروع (حتی بوتِ دستی پس از شکست)، با `shutdown.started` و پیش از بستنِ استخر متوقف؛ ثبت‌نشدن در ظرف ⇒ هرگز شروع.
4. بدنه: بی‌پایش بایت‌به‌بایت؛ با پایش `ready/startup` بخشِ شش‌کلیدی؛ `live` هرگز؛ `blocks` فقط ۲۰۰→۵۰۳؛ ثبتِ خراب ⇒ `unknown`؛ بی‌نشت؛ خاصیتیِ ۳۰۰۰ ترکیب.
5. PostgreSQLِ واقعی: بوت ⇒ ready با `backlog`؛ `report` مسدود نمی‌کند؛ `gate_down` مسدود و پس از تأیید برمی‌گردد؛ بوتِ ناموفق ⇒ idle.
6. آزمونِ جهشیِ بدونِ زندهٔ توضیح‌نشده.

## تست‌های مورد انتظار
عادی، مرزی، خطا (Proxy/ظرفِ قفل/نمای خراب)، خاصیتی، PostgreSQLِ واقعی، نگهبانِ منبع.

## خارج از کار
اندازه‌گیریِ هزینهٔ خواندن و ایندکس (الف‑۲‑۳)، `deliver` (ب)، تغییر در `src/app` یا `instrumentation`.

## وابستگی‌ها
ADR-0042، ADR-0033، ADR-0032، تحویل ۰۰۴۲.

## فایل‌های مرجع برای خواندن
`docs/adr/0043-settlement-bootstrap-backlog-wiring.md`، `docs/adr/0042-settlement-backlog-watch.md`، `src/modules/settlement-backlog-watch/types.ts`، `src/modules/settlement-host/types.ts` (`HostEvent`).

## بازبینی و ریسک
ناحیهٔ پرریسک (`settlement-bootstrap`) ⇒ `Risk-Tag`. بازبین: مالک معماری + مالک امنیت + متخصص مالی.
