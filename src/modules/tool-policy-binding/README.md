# tool-policy-binding (لایهٔ ۷ · خالص · 🔴 بازبینی انسانیِ اجباری: مالک امنیت) — برش CT‑5c‑2c‑2b‑2a

**هدف:** سیاستِ آستانه‌های دروازهٔ ابزار (`snapshot()` منبع) را **به‌ازای هر درخواست پین کند**، پس از اعتبارسنجیِ مجدد و **شکست‌بسته**. تصمیم‌ها: `docs/adr/0077-tool-policy-binding.md`.
**وابستگی:** فقط رابطِ عمومیِ `tool-policy` (`projectToolPolicy` و نوع‌ها). ساعت، تایمر، I/O، `process.env`، شبکه، پایگاه، قیمت، ارز، حساب، سقفِ هزینه و کلید ندارد؛ منبع و سازنده تزریق می‌شوند.

> ⚠️ هنوز به مسیرِ محصول وصل نیست (`planned`): ریشهٔ ترکیبِ I/O (بودجهٔ هزینه، قیمت، ارائه‌دهنده، `requestId`، دفتر) تصمیمِ مالک است و برشِ بعدی (2b‑2b) است. بازبینیِ مالک امنیت انجام نشده.

## رابط
```ts
import { createPolicyBinding } from "@/modules/tool-policy-binding";

const made = createPolicyBinding<CalcAnswerService>({
  source,                       // { snapshot(): unknown } — مثلاً PolicySource یا ToolPolicyRuntime
  build: (projection) => createCalcAnswerService({ /* ... از projection.service/loop ... */ }), // برای هر نسخه یک بار؛ { ok:true, value:<شیء> }
  observer: (e) => log(e),      // اختیاری؛ رویدادِ بسته، هرگز مسیر را نمی‌شکند
});
const binding = made.ok ? made.value : null;

const lease = binding.acquire(); // همگام، هرگز نمی‌پرتابد
// ok:true  ⇒ { version, source, drift, ageMs, projection (یخ‌زده، بازساخته), instance }
// ok:false ⇒ { code:"POLICY_UNAVAILABLE", reason, message }
binding.status();                // { activeVersion, highestVersion, lastUnavailable, activations, buildFailures, acquired, rejected }
```

## قراردادها
1. **ورودی ناقابل‌اعتماد:** `snapshot()` هرچه بدهد، `projection` با `projectToolPolicy` (کرانِ هر فیلد + چهار رابطهٔ پول) دوباره ساخته می‌شود؛ شکلِ دقیق (کلیدِ کم/اضافه ⇒ رد)؛ هر کلید یک بار خوانده می‌شود؛ `version === 0 ⇔ source === "defaults"`.
2. **شکست‌بسته با دلیلِ بسته:** `NOT_LOADED | STALE | CLOCK_INVALID` (از منبع)، `SOURCE_INVALID`، `PROJECTION_INVALID`، `VERSION_REGRESSED`، `VERSION_CONTENT_MISMATCH`، `BUILD_FAILED`. هرگز بازگشت به نسخهٔ قبلی، پیش‌فرضِ کد یا مقدارِ حدسی؛ پیام‌ها ثابت‌اند و مقدار/متنِ خطا نشت نمی‌کنند.
3. **پین:** اجارهٔ هر درخواست نمونه و projectionِ همان لحظه را نگه می‌دارد؛ فعال‌شدنِ نسخهٔ تازه درخواستِ در جریان را عوض نمی‌کند.
4. **یک ساخت به‌ازای هر نسخه**؛ شکستِ ساخت برای همان نسخه ماندگار است (`build` قطعی و بی‌I/O است) و با نسخهٔ بالاترِ بعدی بهبود می‌یابد.
5. **ترازوی ضدعقب‌گرد** فقط با projectionِ **معتبر** بالا می‌رود.
6. **رویدادها:** `policy.activated` (نسخه + قبلیِ سالم)، `policy.unavailable` و `policy.recovered` فقط روی تغییرِ حالت (نه به‌ازای هر درخواست).

## آزمون‌ها
واحد (`validate`، `binding`)، مدل‌محور (۳۰۰ بذر × ۶۰ گام)، نگهبانِ منبع (`tooling/tool-policy-binding-source.test.ts`)، و یکپارچگی با منبعِ واقعی و `createCalcAnswerService` واقعی در `tooling/tool-policy-binding.integration.test.ts`. اسکریپتِ جهش: `tooling/mutation/tool-policy-binding.py`.
