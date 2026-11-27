# tool-policy-preflight — پیش‌بازرسیِ انتشارِ سیاستِ ابزار

## هدف (یک جمله)
پیش از ثبتِ هر نسخهٔ سیاست بسنجیم که همان مسیرِ اجرا (پیوند + `build`) آن را می‌سازد، تا انتشارِ ناساخته‌شدنی ترافیک را نبندد.

## زمینه (حداکثر چند خط)
ADR‑0077 بند ۵: `BUILD_FAILED` سراسری و ماندگار است. مدیرِ سیاست فقط `resolveToolPolicy` را می‌سنجد. ADR‑0078 این شکاف را می‌بندد.

## ماژول و پوشه‌های مجاز
`src/modules/tool-policy-preflight/`، `tooling/tool-policy-preflight*.test.ts`، `tooling/mutation/tool-policy-preflight.py`، `docs/` (ADR/task/handoff/ریسک/pitfalls)، یک سطر در `registry.ts` و `HIGH_RISK_MODULES`، `MIN_PASSED_TESTS`.

## ممنوع
تغییرِ `tool-policy`، `tool-policy-admin`، `tool-policy-binding` و هر آزمونِ موجود؛ `src/app`، `src/db`، `src/instrumentation*`.

## قرارداد
`preflightToolPolicy({overrides, build})` و `createPreflightedAdmin({admin, build})`؛ نوع‌ها در `src/modules/tool-policy-preflight/types.ts`.

## معیار پذیرش
- پیش‌بازرسی از همان `createPolicyBinding` و `build` عبور می‌کند؛ مرحله‌های ردّ بسته و بی‌نشتِ مقدار/متنِ خطا.
- `set`/`rollbackTo` ردشده هرگز به مدیر نمی‌رسد؛ ورودی یک بار کلون می‌شود (TOCTOU)؛ rollback با کدِ جاری سنجیده می‌شود.
- مدیر/منبع/پیوند/سرویسِ واقعی در آزمونِ یکپارچگی.

## تست‌های مورد انتظار
مسیر سالم، هر مرحلهٔ ردّ، ورودیِ خصمانه، TOCTOU، سقفِ اندازه (مرز)، مدل‌محور، شاخه‌های دفاعی (`vi.mock`)، نگهبانِ منبع، یکپارچگی، جهش‌آزمایی.

## خارج از کار
وصل به HTTP/برنامه، ریشهٔ ترکیبِ I/O، پیش‌ساخت برای استقرارِ چندنسخه‌ای.

## وابستگی‌ها
0065 (tool-policy)، 0066 (admin)، 0074 (binding).

## فایل‌های مرجع برای خواندن
`docs/adr/0077-tool-policy-binding.md`، `docs/adr/0078-tool-policy-preflight.md`، `src/modules/tool-policy-binding/`.

## بازبینی و ریسک
ناحیهٔ پرریسک؛ بازبینیِ انسانی: مالکِ امنیت.

## تعریف «تمام شد»
تست‌ها و CI سبز، جهش‌آزمایی بی‌زنده، مستند روزآمد، یادداشت تحویل.
