# ai-gateway — برش CT‑3a (رمزگذارِ ابزار روی سیم)

## هدف (یک جمله)
توصیفِ ابزار، پاسخِ مدل و نتیجهٔ ابزار بتوانند بدونِ حدس و بدونِ اجرای ابزار میانِ قالبِ OpenAI/Anthropic و شکلِ داخلیِ ما تبدیل شوند.

## زمینه
ADR-0054؛ ادامهٔ ADR-0053 (CT‑1).

## ماژول و پوشه‌های مجاز
`src/modules/ai-gateway/` (فقط فایل‌های تازهٔ `tool-wire*.ts`، `index.ts` برای صادرات، README)، `tooling/tool-wire-calc-tools.test.ts`، `tooling/ci-tests.ts` (فقط کفِ شمار)، `docs/`.

## ممنوع
`registry.ts`، `shared-types`، `calc-tools`/`legal-calc` (حتی یک خط)، تغییرِ `ModelProvider`/`CompletionRequest`/`Completion`/`gateway.ts`/`resilience.ts`، شبکه/env/ساعت، وابستگیِ خارجیِ جدید، ویرایشِ هر آزمونِ موجود، ویندوز، تصمیم‌های معلقِ ۰۰۴۶–۰۰۵۳.

## قرارداد
`encodeTools`، `encodeToolResults`، `decodeToolReply`، `TOOL_LIMITS` و نوع‌های `ToolSpec`، `ToolCall`، `DecodedToolReply`، `ToolWireError` … (`src/modules/ai-gateway/index.ts`).

## معیار پذیرش
1. شکلِ سیمِ هر دو قالب مطابقِ مستندِ رسمی (آزمونِ شکلِ مرجع).
2. فراخوانیِ بریده اجرا نمی‌شود؛ مصرف هرگز حدس زده نمی‌شود و کش‌شدهٔ Anthropic کمتر از واقع ثبت نمی‌شود.
3. ورودی/پاسخِ بدجنس هرگز نمی‌پرتابد؛ پیام‌ها کران‌دار و بی‌نشتِ نامِ کلیدِ مدل‌اند.
4. `CALC_TOOLS` بدونِ وابستگیِ registry از رمزگذار می‌گذرد و یک گامِ کاملِ مدل ← ابزار ← مدل در هر دو قالب کار می‌کند.
5. دروازهٔ کامل سبز، `MIN_PASSED_TESTS` بالا رفت.

## خارج از کار
گسترشِ پورتِ ارائه‌دهنده، HTTP، حلقهٔ ابزار، `inheritance`.

## وابستگی‌ها
هیچ (فقط داخلِ ماژول).

## بازبینی و ریسک
مرزِ امنیتی (پاسخِ نامطمئن) + پول (مصرف) ⇒ بازبینیِ پیشنهادی در ADR-0054.
