# پایدارسازیِ آزمون‌های PostgreSQLِ گرم (انتظارِ قفلِ مشورتیِ با دامنه + کنترلِ منفیِ کشِ کاتالوگ)

## هدف (یک جمله)
دروازهٔ CI دیگر به‌خاطرِ تداخلِ فایل‌های آزمونِ موازی (انتظارِ سراسریِ `pg_locks`) یا سردشدنِ اتصالِ گرمِ استخر شانسی قرمز نشود، بی‌آنکه هیچ آزمونی ضعیف شود.

## زمینه
مورد باز بندِ ۵‑۲ و ۵‑۷ تحویل ۰۰۵۱؛ ADR-0052.

## ماژول و پوشه‌های مجاز
`tooling/advisory-wait-scope.ts` (+ `.test.ts`، `.pg.test.ts`)، `tooling/ci-tests.ts` (فقط کفِ شمار)، و **فقط متنِ پرسشِ `pg_locks`** در سه آزمونِ `src/modules/settlement-migrate/process.pg.test.ts`، `src/modules/settlement-pending-migrate/process.pg.test.ts`، `src/modules/settlement-pending-migrate/down.process.pg.test.ts`؛ یک دستور در کنترلِ منفیِ `src/modules/settlement-pending/regclass.pg.test.ts`؛ آزمونِ تازهٔ `src/modules/settlement-pending/regclass.cold.pg.test.ts`؛ `docs/`.

## ممنوع
کدِ محصول، `registry.ts`، `vitest.config.ts`، `retry`، ضعیف‌کردنِ هر `expect`، تغییرِ نامِ `it`ها، `down.pg.test.ts` (بازتولید نشد)، ویندوز (`ERR_IPC_CHANNEL_CLOSED`/`gate-floor`)، تصمیم‌های معلقِ ۰۰۴۶–۰۰۵۱.

## قرارداد
انتظارِ قفلِ مشورتی در آزمون‌ها فقط با `pid =` یا کلیدِ هش (`hashtextextended`) پرسیده می‌شود؛ SQLِ مشترک: `SCOPED_ADVISORY_WAITERS_SQL` (`$1` = آرایهٔ متنیِ کلیدها).

## معیار پذیرش
1. پرسشِ سراسریِ قدیم انتظارِ فایلِ دیگر را می‌بیند و دامنه‌دار نه (PostgreSQL واقعی، هشِ منفی و مثبت).
2. هیچ آزمونی در مخزن `NOT granted` را بی‌دامنه نمی‌پرسد؛ سه فایل عینِ SQLِ مشترک را دارند.
3. اتصالِ گرمِ بی‌نگهداری واقعاً سرد می‌شود (pid دیگر) و کنترلِ منفیِ اصلاح‌شده با همان فاصله همچنان «کهنه» را نشان می‌دهد.
4. دروازهٔ کامل سبز؛ `MIN_PASSED_TESTS` بالا رفت؛ هیچ `it`ی نامش عوض نشد.

## خارج از کار
`down.pg.test.ts › activeBackends`، `process.pg` در مقیاسِ دیگر ماژول‌ها، ب‑۲‑۴ (`backlog:cost` با منبعِ نمایه).

## وابستگی‌ها
ADR-0024، 0040، 0050، 0052.

## بازبینی و ریسک
دروازهٔ CI (نه کدِ محصول). بازبینی: مالک معماری. جزئیات: ADR-0052.
