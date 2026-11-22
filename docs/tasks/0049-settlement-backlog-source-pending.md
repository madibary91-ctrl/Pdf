# م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۳: سیم‌کشیِ `SETTLEMENT_BACKLOG_SOURCE=pending` در bootstrap

## هدف (یک جمله)
پایشِ زندهٔ پسماند بتواند (فقط با کلیدِ صریح و پیش‌فرض‌خاموش) از نمایهٔ مشتقِ `settlement-pending` بخواند، بی‌هیچ بازگشتِ بی‌صدا به outbox.

## زمینه
گامِ بعدیِ اعلام‌شده در تحویل ۰۰۵۰ (بند «گام بعد» ۱)؛ ADR-0047 جدولِ برش‌ها؛ ADR-0051.

## ماژول و پوشه‌های مجاز
`src/modules/settlement-bootstrap/` (`bootstrap.ts`، `env.ts`، `types.ts`، README و آزمون‌های تازهٔ `env.source.test.ts`، `source.test.ts`، `source.pg.test.ts`، `source.guard.test.ts`)، `src/modules/settlement-pending-migrate/args.ts` (فقط یک نامِ env) و `args.source.test.ts`، `src/modules/registry.ts` (یک وابستگی)، `tooling/backlog-source-parity.test.ts`، `tooling/mutation/settlement-bootstrap-source.py`، `tooling/ci-tests.ts` (فقط کفِ شمار)، `docs/`.

## ممنوع
هر آزمونِ موجود (به‌جز دو استثنای مستندِ ADR-0051 با `Test-Change-Approved`)، `settlement`، `settlement-pending` (کد)، `settlement-migrate`، `settlement-backlog*`، `src/app`، `src/instrumentation*`، `vitest.config.ts` و هر چیزِ مربوط به `ERR_IPC_CHANNEL_CLOSED`/`gate-floor` ویندوز، تصمیم‌های معلقِ ۰۰۴۶–۰۰۵۰.

## قرارداد
`SETTLEMENT_BACKLOG_SOURCE` ∈ {نبودن/خالی/`outbox`، `pending`}؛ هر چیزِ دیگر و هر مقدارِ بی‌پایشِ روشن ⇒ `INVALID_ENV`. `backlog.source:"pending"` فقط برای pending. لاگِ `bootstrap.backlog_watch.source` فقط برای pending. بدنهٔ HTTP پروب‌ها **بی‌تغییر**.

## معیار پذیرش
1. بی‌متغیر/outbox: خروجیِ env و لاگ‌ها و سیم‌کشی بایت‌به‌بایت مثلِ پیش؛ آزمون‌های موجود سبز.
2. pending: فقط نمایه ساخته می‌شود (همان پایگاه/شِما/سقفِ ADR-0045)؛ هیچ outboxی برای پایش.
3. PostgreSQL واقعی: شمارِ نمایه (۳−۱ تأییدشده = ۲)، تأیید ⇒ کاهش، `gate_down` ⇒ ۵۰۳ و بازگشت، نصب‌نشده ⇒ هرگز ok، `down` در حینِ اجرا ⇒ degraded و نصبِ دوباره ⇒ ok؛ TRIGGER خاموش ⇒ پایش صفر (حدِّ مستند).
4. CLIِ نمایه با همان envِ برنامه (با `pending`) خروج ۲ نمی‌دهد.
5. آزمونِ جهشی: هیچ جهشِ زنده.

## خارج از کار
`backlog:cost` با منبعِ نمایه و زمانِ backfill (ب‑۲‑۴)؛ بررسیِ نصب در بوت؛ تغییرِ سیاستِ `SAMPLE_UNREADABLE`/`gate_down`؛ `settlement-migrate`.

## وابستگی‌ها
ADR-0043، 0045، 0046–0050.

## بازبینی و ریسک
ناحیهٔ پرریسک (سلامت/پول). بازبینی: مالک امنیت + متخصص مالی + مالک معماری. جزئیات: ADR-0051.
