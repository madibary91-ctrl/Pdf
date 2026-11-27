# shared-pool-error-guard — نگهبانِ `error`ِ استخرِ مشترکِ `@/db`

## هدف (یک جمله)
قطعِ اتصالِ پایگاه (ری‌استارت/failover/`pg_terminate_backend`)، چه روی اتصالِ بی‌کار و چه روی اتصالِ اجاره‌شده بینِ دو دستور، فرایندِ برنامه را نیندازد؛ فقط رویدادِ بسته با کدِ کوتاه لاگ شود.

## زمینه
handoff 0082 بند ۴-۱ و «گام بعد» بند ۱؛ ADR-0083 بند ۷؛ ADR-0084 (این برش).

## ماژول و پوشه‌های مجاز
افزودن: `src/db/pool-error-guard.ts` (+ `.test.ts`)، `tooling/db-pool-error-guard.pg.test.ts`، `tooling/db-pool-error-guard.child.ts` (فرایندِ فرزندِ آزمون)، `tooling/db-pool-error-guard-contract.test.ts`، `docs/adr/0084-…`، `docs/tasks/0081-…`، `docs/handoffs/0083-…`. ویرایشِ حداقلی: `src/db/index.ts` (دو خط)، `tooling/ci-tests.ts` (فقط کفِ تست)، `docs/high-risk-areas.md`، `docs/known-pitfalls.md`، `AGENTS.md` (یک سطر).

## ممنوع
تغییرِ هر ماژولِ `src/modules/*`، `registry.ts`، `src/db/schema.ts`، `src/db/pool-lease.ts`، گلوهای `instrumentation*`، قراردادها، **هر تستِ موجود**، وابستگیِ تازه، `message`/رشتهٔ اتصال در لاگ، بلعیدنِ خطای اجاره‌دار.

## معیار پذیرش
1. `@/db` نگهبان را (یک `error`، یک `connect`) روی استخرِ خودش می‌نصبد؛ HMR/`globalThis` شنونده را دو برابر نمی‌کند.
2. اتصالِ بی‌کارِ کشته‌شده ⇒ یک رویدادِ `db.pool.error` با `57P01`؛ پرسشِ بعدی موفق.
3. اتصالِ اجاره‌شده وسطِ تراکنش کشته شود ⇒ فرایند نمی‌افتد، دستورِ بعدیِ اجاره‌دار شکست می‌خورد، `release(err)` استخر را سالم می‌گذارد.
4. کنترلِ منفی در فرایندِ واقعی: بدونِ شنونده فرایند می‌میرد؛ با `@/db` زنده می‌ماند.
5. لاگ فقط `{scope:"db", type:"db.pool.error", code}`؛ هرگز `message`/رمز.
6. هیچ تستِ موجودی تغییر نمی‌کند.

## خارج از کار
استخرِ اختصاصیِ میزبانِ تسویه، متریک/هشدار، محدودیتِ نرخِ لاگ، شنوندهٔ `connect` برای استخرِ میزبانِ سیاست، TLS/PgBouncer، اجباری‌کردنِ `POLICY_DATABASE_URL`.
