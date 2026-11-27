# tool-policy-dedicated-pool — استخرِ اختصاصیِ میزبانِ سیاستِ ابزار

## هدف (یک جمله)
میزبانِ سیاستِ ابزار در تولید بتواند با رشتهٔ اتصالِ جدا و نقشِ کمترینِ امتیازِ ADR-0081 وصل شود، شکست‌بسته و بی‌نشتی، بی‌آن‌که رفتارِ امروز (استخرِ مشترک) تغییر کند.

## زمینه
handoff 0081 («یافتهٔ معماری»، «گام بعد» بند ۱) و ADR-0082. ADR-0083 (این برش).

## ماژول و پوشه‌های مجاز
افزودن: `src/instrumentation-policy-db.ts` (+ دو فایلِ آزمونِ هم‌جوار)، `tooling/tool-policy-dedicated-pool.pg.test.ts`، `tooling/tool-policy-dedicated-pool-contract.test.ts`، `docs/adr/0083-…`، `docs/tasks/0080-…`، `docs/handoffs/0082-…`؛ ویرایشِ حداقلی: `src/instrumentation-policy.ts` (یک فراخوانی)، `docs/runbooks/tool-policy-roles.md`، `docs/high-risk-areas.md`، `AGENTS.md`، `docs/known-pitfalls.md`، `tooling/ci-tests.ts` (فقط `MIN_PASSED_TESTS`).

## ممنوع
تغییرِ هر ماژولِ `src/modules/*`، `registry.ts`، `src/db/*`، `src/instrumentation-shared.ts`/`instrumentation-node.ts` (تسویه)، قراردادها، **هر تستِ موجود**، وابستگیِ تازه، رشتهٔ اتصال/رمز در لاگ یا مستند، بازگشتِ بی‌صدا به استخرِ مشترک.

## معیار پذیرش
1. متغیر نبود/خالی ⇒ همان `openSharedDatabase` (هویتِ شیء).
2. متغیر معتبر ⇒ استخرِ جدا با `max=2` و `application_name` ثابت؛ `@/db` بارگذاری نمی‌شود؛ `release`/`close` استخر را یک بار می‌بندند.
3. نامعتبر/رمزِ غلط ⇒ شکست‌بسته؛ هرگز استخرِ مشترک؛ لاگ و پیام بی‌مقدار.
4. با نقشِ LOGINِ واقعی روی PostgreSQL: ready ۲۰۰، همان استخر نمی‌نویسد، خاموشی نشتی ندارد، قطعِ اتصال فرایند را نمی‌اندازد.
5. هیچ تستِ موجودی تغییر نمی‌کند.

## خارج از کار
اجباری‌کردنِ رشتهٔ جدا، استخرِ جدا برای تسویه، شنوندهٔ `error` برای `@/db`، کدِ `PERMISSION_DENIED`، pooler/TLS سفارشی.
