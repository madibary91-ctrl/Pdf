# settlement-runtime م۳‑ه‑۴‑د: علتِ ناپایداریِ دودیِ زمانِ واقعی (ثبتِ علت، رفع، آزمونِ قطعی)

## هدف (یک جمله)
آزمونِ دودیِ زمانِ واقعیِ `runtime.pg.test.ts` زیرِ بار بی‌دلیل قرمز نشود و هر شکستِ سلامت علتِ خود را در پیام بدهد، بدونِ ضعیف‌شدنِ هیچ ادعا و بدونِ دست‌زدن به کدِ محصول.

## زمینه
تحویل ۰۰۴۰ بند ۶‑۱ و «گام بعد ۱»، `docs/known-pitfalls.md`، ADR-0041.

## ماژول و پوشه‌های مجاز
`src/modules/settlement-runtime/` فقط: `test-kit.ts` (کمک‌تست)، `health-diagnostics.test.ts` (تازه)، `runtime.pg.test.ts` (تازه‌ها + **فقط** آزمونِ دودی؛ `Test-Change-Approved`)، `README.md`؛ `tooling/mutation/health-diagnostics.py` (تازه)؛ `tooling/ci-tests.ts` (فقط کف)؛ `docs/`.

## ممنوع
هر فایلِ محصولیِ `src/` (حتی `health.ts`، `runtime.ts`)، `purity.test.ts`، `vitest.config.ts`، `package.json`، `retry`، `.skip`، ضعیف‌کردنِ ادعا، ساعتِ مجازی برای دودی، آستانهٔ صریحِ `health` در دودی.

## قرارداد
`healthDiagnostics(rt: { health(): unknown; status(): unknown }): string` و `SMOKE_GRACE_MS` در `test-kit.ts` (از `index` صادر نمی‌شوند).

## معیار پذیرش
1. علت با **داده** (نه حدس) بازتولید و ثبت شود.
2. توقفِ قطعیِ حلقهٔ رویداد روی PostgreSQL واقعی: ۱۲۰ms ⇒ `STALE_SUCCESS`؛ `SMOKE_GRACE_MS` ⇒ ok؛ توقفِ بیش از `graceMs` ⇒ `down/503`.
3. `healthDiagnostics` هرگز نمی‌پرتابد، نمی‌نشتد، کران‌دار و تک‌خطی است؛ هر متد یک بار خوانده می‌شود.
4. حاشیهٔ تحملِ `SMOKE_GRACE_MS` ≥ ۲۵۰ms و از سازندهٔ واقعی سنجیده می‌شود.
5. جهشیِ بدونِ زندهٔ توضیح‌نشده.
6. دروازهٔ کاملِ صفر-رد سبز؛ هیچ آزمونِ موجودی حذف/ضعیف نشد؛ تنها آزمونِ دودی (سه نقطه) عوض شد.

## تست‌های مورد انتظار
قالب/مرز/خطا/نشت، اجرای واقعیِ حافظه‌ای با زمانِ مجازی، قفلِ حاشیه، سه آزمونِ قطعیِ PostgreSQL.

## خارج از کار
اتصالِ پایشِ پسماند به `/api/health` (تصمیمِ مالک)، `deliver`، ناپایداریِ `settlement-migrate/process.pg.test.ts`، آزمون‌های ساعتِ واقعیِ دیگر.

## وابستگی‌ها
تحویل ۰۰۴۰، ADR-0030/0031.

## فایل‌های مرجع برای خواندن
`docs/adr/0041-smoke-health-flake.md`، `src/modules/settlement/health.ts`، `src/modules/settlement-runtime/runtime.pg.test.ts`.

## بازبینی و ریسک
ناحیهٔ پرریسک (`settlement-runtime`)؛ تغییرِ غیرتستی تنها `test-kit.ts` و کفِ `ci-tests.ts` ⇒ `Risk-Tag`. بازبین: مالک امنیت + متخصص مالی.
