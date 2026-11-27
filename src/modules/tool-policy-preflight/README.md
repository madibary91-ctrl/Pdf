# tool-policy-preflight (لایهٔ ۸ · خالص · 🔴 بازبینی انسانیِ اجباری: مالک امنیت) — برش CT‑5c‑2c‑2b‑2a′

**هدف:** پیش از ثبتِ هر نسخهٔ سیاستِ ابزار، با **همان مسیرِ اجرا** بسنجیم که ساخته می‌شود؛ ردّ ⇒ هیچ نسخه‌ای ثبت نمی‌شود. تصمیم‌ها: `docs/adr/0078-tool-policy-preflight.md`.
**وابستگی:** فقط رابط‌های عمومیِ `tool-policy`، `tool-policy-binding` و `tool-policy-admin`. ساعت، تایمر، I/O، `process.env`، شبکه، پایگاه، قیمت، ارز، حساب و کلید ندارد؛ `build` و مدیر تزریق می‌شوند.

> ⚠️ هنوز به مسیرِ محصول وصل نیست (`planned`). بازبینیِ مالک امنیت انجام نشده.

## رابط
```ts
import { preflightToolPolicy, createPreflightedAdmin } from "@/modules/tool-policy-preflight";

// ۱) تک‌بازنویسی (همان build تولید):
const r = preflightToolPolicy({ overrides, build });
// ok:true  ⇒ { policy, projection }  (ژرف‌یخ‌زده)
// ok:false ⇒ { code:"PREFLIGHT_REJECTED", stage, message, issues }
//   stage ∈ CONFIG_INVALID | INPUT_UNREADABLE | OVERRIDES_INVALID | PROJECTION_INVALID | BUILD_FAILED

// ۲) مدیر با دروازهٔ پیش‌بازرسی (جایگزینِ مدیرِ خام در مسیرِ ادمین):
const made = createPreflightedAdmin({ admin, build });   // admin: ToolPolicyAdmin
const pre = made.ok ? made.value : null;
await pre.set({ expectedVersion, overrides, actor, reason });      // ردّ ⇒ مدیر صدا زده نمی‌شود
await pre.rollbackTo({ expectedVersion, toVersion, actor, reason }); // بازنویسیِ هدف با کدِ جاری سنجیده می‌شود
await pre.current(); await pre.history();                           // عبور
```

## قراردادها
1. **همان مسیرِ اجرا:** `resolveToolPolicy` ← `projectToolPolicy` ← `createPolicyBinding` + `build` (یک بار؛ نمونه دور ریخته می‌شود). هیچ قاعده‌ای کپی نشده.
2. **ردّ ⇒ ثبت نمی‌شود.** خطا مرحلهٔ بسته دارد؛ مقدار و متنِ خطای `build` هرگز بازتاب نمی‌شود.
3. **یک عکس (TOCTOU):** کلِ ورودی یک بار JSON‑کلون می‌شود؛ پیش‌بازرسی و مدیر همان کلون را می‌بینند. سقفِ ۱۶٬۳۸۴ نویسه.
4. **rollback** بازنویسیِ نسخهٔ هدف را از `history` می‌خواند و با کدِ جاری می‌سنجد؛ خطای `history` ⇒ همان خطا بی‌صدا زدنِ `rollbackTo`.
5. هرگز نمی‌پرتابد؛ پرتابِ مدیر ⇒ `STORE_FAILURE`.
6. **محدودیت:** سنجش با کدِ همین فرایند است و اتمی با ثبت نیست؛ ریسک را کم می‌کند، حذف نمی‌کند (ADR‑0078 بند ۸).

## آزمون‌ها
واحد (`preflight`، `guarded-admin`)، شاخه‌های دفاعی با `vi.mock` (`defensive`)، نگهبانِ منبع (`tooling/tool-policy-preflight-source.test.ts`)، یکپارچگی با مدیر/منبع/پیوند/سرویسِ واقعی (`tooling/tool-policy-preflight.integration.test.ts`). جهش: `tooling/mutation/tool-policy-preflight.py`.
