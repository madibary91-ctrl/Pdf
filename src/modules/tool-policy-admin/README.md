# tool-policy-admin (لایهٔ ۵ · خالص · 🔴 بازبینی انسانیِ اجباری: مالک امنیت) — برش CT‑5c‑2b‑1

**هدف:** هر تغییرِ آستانه‌های دروازهٔ ابزار (`tool-policy`) یک **نسخهٔ فقط‌افزودنی** با CAS، بازیگر، دلیل و تفاوتِ مؤثر باشد؛ ذخیره‌ساز و ساعت **تزریق** می‌شوند. تصمیم‌ها: `docs/adr/0069-tool-policy-admin.md`.
**وابستگی:** فقط رابطِ عمومیِ `tool-policy` (`resolveToolPolicy`). I/O، ساعت، تصادف، `process.env`، HTTP و پایگاه ندارد. **نامِ فیلد یا عددِ کرانِ سیاست در این ماژول نیست.**

> ⚠️ هنوز به مسیرِ محصول وصل نیست (`planned`)؛ **آداپتورِ PostgreSQL (2b‑2) در ماژولِ `tool-policy-store-pg` ساخته شده (هنوز به محصول وصل نیست)؛ مسیرِ HTTP (2b‑3، پس از `identity`) ساخته نشده است.** بازبینیِ مالک امنیت انجام نشده.

## رابط
```ts
import { createToolPolicyAdmin, createMemoryPolicyStore } from "@/modules/tool-policy-admin";

const made = createToolPolicyAdmin({ store, clock });        // store: PolicyVersionStore، clock: { nowMs() }
const admin = made.ok ? made.value : null;

await admin.current();                                       // { version, source, policy, overrides, drift, updatedAtMs }
await admin.set({ expectedVersion: 0, overrides: {...}, actor: "admin:alice", reason: "…" });   // جایگزینیِ کامل؛ {} = پیش‌فرض‌های کد
await admin.rollbackTo({ expectedVersion: 3, toVersion: 1, actor, reason });                     // نسخهٔ تازه؛ تاریخچه دست‌نخورده
await admin.history({ beforeVersion: null, limit: 20 });    // نزولی؛ nextBefore برای صفحهٔ بعد
```
همه `Result` برمی‌گردانند و هرگز نمی‌پرتابند. `actor` را **فراخواننده** از هویتِ احرازشده می‌دهد؛ این ماژول فقط شکلش را می‌سنجد.

## قواعد
- نسخهٔ ۰ = پیش‌فرض‌های کد (رکوردی ندارد). نسخهٔ پیشنهادی باید دقیقاً «آخرین+۱» باشد؛ `expectedVersion` اجباری است ⇒ `VERSION_CONFLICT` (با `currentVersion`).
- بازنویسیِ برابرِ نسخهٔ فعلی (کانونی) ⇒ `NO_CHANGE` (نسخه نمی‌سازد). پین‌کردنِ مقدارِ پیش‌فرض نیتِ تازه است و نسخه می‌سازد.
- بازنویسیِ نامعتبر ⇒ `INVALID_OVERRIDES` و **هیچ نسخه‌ای ساخته نمی‌شود**؛ هرگز خودکار اصلاح نمی‌شود (`timingFromGrace` از `tool-policy` برای مجموعهٔ سازگار).
- `reason`: ۱ تا ۵۰۰ نویسهٔ بی‌کنترل (کنترل‌های جهتِ دوسویه رد؛ نیم‌فاصلهٔ فارسی مجاز). **اسرار، کلید و دادهٔ کاربران را در `reason` ننویسید** (متنِ آزاد و ماندگار است).
- `current()`: بازنویسیِ ذخیره‌شده با **کدِ جاری** دوباره حل می‌شود. نامعتبر ⇒ `STORED_POLICY_INVALID` (بسته‌شدنِ شکست؛ ریشهٔ I/O نباید بی‌صدا به پیش‌فرض برگردد؛ اصلاح با `set` تازه). تفاوتِ سیاستِ مؤثر با عکسِ لحظهٔ ثبت ⇒ `drift:true`.
- پرتابِ ذخیره‌ساز/ساعت یا پاسخِ بدشکل ⇒ `STORE_FAILURE`/`INVALID_CLOCK` بدونِ نشتِ متنِ استثنا.

## پورتِ ذخیره‌ساز و آزمونِ قرارداد
`PolicyVersionStore` (`latest`/`get`/`append`/`list`): `append` اتمی و CAS؛ بی‌شکاف؛ بی‌بازنویسی. هر پیاده‌سازی باید `describePolicyStoreContract` (در `store-contract.ts`؛ فقط آزمون) را بگذراند. اکنون: `createMemoryPolicyStore()` (آزمون/توسعه؛ **ماندگار نیست**). PG: `createPgPolicyVersionStore` در `tool-policy-store-pg` (همین آزمونِ قرارداد را می‌گذراند). `parsePolicyRecord` برای آداپتورهای ذخیره‌ساز صادر شده است.

## محدودیت‌های شناخته‌شده (صادقانه)
- `createMemoryPolicyStore` **ماندگار نیست** (با ریستارت همه‌چیز می‌رود)؛ ماندگاری با `tool-policy-store-pg`. به محصول وصل نکنید (ریشهٔ I/O برشِ 2c).
- **احراز هویت/مجوز ندارد** (نقش با `identity`)؛ هر فراخواننده‌ای که `actor` بدهد پذیرفته می‌شود.
- **تایم‌اوتِ ذخیره‌ساز** با ریشهٔ I/O است (ماژول تایمر ندارد): ذخیره‌سازِ بی‌پاسخ، `set` را معلق نگه می‌دارد.
- چندنمونه‌ای: هر نمونه باید `current()` را دوره‌ای بخواند؛ اعلانِ تغییر نیست.
- `release` برای `onUnknownCost` همچنان مجاز است (تصمیمِ ادمین؛ ADR‑0067 بند ۸)؛ این ماژول فقط آن را ثبت و ممیزی می‌کند.
