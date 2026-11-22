# calc-tools — برش CT‑1 (مرزِ مدل ← محاسبه)

## هدف (یک جمله)
مدل بتواند هزینهٔ دادرسی و خسارت تأخیر تأدیه را فقط از راهِ ابزارِ سنجیده‌شده محاسبه کند و هر عدد از `legal-calc` بیاید، نه از حافظهٔ مدل.

## زمینه
ADR-0016 ردیف ۷‑۴ از تحویل ۰۰۱۶ منتظر `calc-tools` است؛ ADR-0053.

## ماژول و پوشه‌های مجاز
`src/modules/calc-tools/` (کد، README، آزمون‌ها)، `tooling/calc-tools-source.test.ts`، `tooling/ci-tests.ts` (فقط کفِ شمار)، `src/modules/registry.ts` (فقط `dependsOn` ِ calc-tools؛ ADR-0053 §۶)، `docs/`.

## ممنوع
بقیهٔ `registry.ts`، `shared-types`، `legal-calc` (حتی یک خط)، هر عددِ حقوقی، وابستگیِ خارجیِ جدید، ویرایشِ هر آزمونِ موجود، ویندوز، تصمیم‌های معلقِ ۰۰۴۶–۰۰۵۲.

## قرارداد
`CALC_TOOLS`، `executeCalcTool`، `executeCalcToolJson`، `isCalcToolName`، `MAX_ARGS_JSON_LENGTH` و نوع‌های `CalcToolOutput` / `CalcToolDescriptor` (`src/modules/calc-tools/index.ts`).

## معیار پذیرش
1. توصیفِ ابزار ژرف یخ‌زده، JSON-سازگار و همان قاعدهٔ اعتبارسنج است (آزمونِ توافقِ تولیدشده).
2. خروجیِ موفق عیناً خروجیِ `legal-calc` است؛ خطا با `code` و `message` برابر؛ `review`/`notes` بالا آمده؛ `reviewPending` فقط با «legally-verified» false است.
3. ورودیِ بدجنس/خراب/بزرگ هرگز نمی‌پرتابد؛ نامِ `__proto__` ابزار نیست.
4. هیچ عددِ حقوقی و I/O در منبع نیست (آزمونِ منبع).
5. دروازهٔ کامل سبز، `MIN_PASSED_TESTS` بالا رفت.

## خارج از کار
`inheritance`، آداپتورِ ارائه‌دهنده، حلقهٔ ابزار، `finance-calc`.

## وابستگی‌ها
`legal-calc`، `shared-types`.

## بازبینی و ریسک
ماژول طبقِ registry پرریسک نیست؛ مرزِ امنیتی/حقوقی است ⇒ بازبینیِ پیشنهادی در ADR-0053 §۶.
