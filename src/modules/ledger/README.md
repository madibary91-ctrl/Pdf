# ledger (لایهٔ ۳ · غیرخالص · **بازبینی انسانیِ اجباری: مالک امنیت**) — **برش ل۱: هستهٔ دفتر اعتبار**

**هدف:** دفتر اعتبارِ هر حساب: **اعطا ← رزرو ← مصرف (به ازای هر تلاش) ← بستن ← بازگشت**، با مبلغِ صحیح، یکتاییِ بر پایهٔ شناسهٔ عملیات، ژورنالِ فقط‌افزودنی و ناوردای بقا. تصمیم‌ها و دلیل‌ها: `docs/adr/0018-ledger-core.md`.
**وابستگی:** طبق `registry.ts` فقط `shared-types` (در عمل هیچ import بین‌ماژولی ندارد). به شبکه، فایل، `process.env`، ساعت سیستم و تصادف دست نمی‌زند؛ ساعت و ذخیره **تزریق** می‌شوند (آزمونِ نگهبان این را روی کد منبع می‌سنجد).

> ⚠️ **این برش ل۱ از ۴ برش است و ماندگار نیست.** ذخیرهٔ حافظه‌ای فقط برای آزمون/توسعه است؛ با ریستارت همه‌چیز می‌رود. **به کاربر/پول واقعی وصل نکنید** تا ل۲ (PostgreSQL) و بازبینی مالک امنیت. در `registry.ts` وضعیت `planned` می‌ماند.

## رابط (`index.ts`)
```ts
const r = createLedger({ store: createMemoryStore(), clock: { nowMs: () => /* از بیرون */ } });  // LedgerResult<Ledger>
const l = r.ok ? r.value : fail();
await l.openAccount({ tenantId, accountId, unit: "IRR_MICROS" });
await l.grant({ tenantId, accountId, grantId, unit, amount, source: "purchase" });
await l.reserve({ tenantId, accountId, reservationId, unit, amount, ttlMs });
await l.charge({ tenantId, accountId, reservationId, attemptId, unit, amount });   // به ازای هر تلاش
await l.close({ tenantId, accountId, reservationId, remainder: "release" | "forfeit" });
await l.refund({ tenantId, accountId, refundId, reservationId, attemptId, unit, amount });
await l.balance({ tenantId, accountId });   // انقضا را می‌بیند ولی ماندگار نمی‌کند
await l.journal({ tenantId, accountId });
```
هر متد `Promise<LedgerResult<…>>` است و **هرگز نمی‌پرتابد**. رسیدِ عملیات‌های تغییردهنده `replayed: boolean` دارد.
`checkInvariants(state)` و `foldJournal(entries)` برای ممیزی/پایش؛ `applyCommand`/`viewAt` موتور خالص.

## قواعد (خلاصه)
| قاعده | رفتار |
|---|---|
| **مرز سازگاری** | هر عملیات روی یک حساب؛ کلید ذخیره `(tenantId, accountId)`؛ حساب مستأجر دیگر = `ACCOUNT_NOT_FOUND` |
| **مبلغ** | عدد صحیح ایمن در `unit` حساب؛ `unit` ناهمخوان ⇒ `UNIT_MISMATCH`؛ سرریز ⇒ `OVERFLOW`؛ هیچ تبدیل/گردکردنی نیست |
| **یکتایی** | کلید = `grantId` / `reservationId` / `(reservationId, attemptId)` / `refundId`؛ **هرگز `requestId`**؛ بازتکرار ⇒ `replayed: true` با همان رسید و **بی‌هیچ اثر**؛ محتوای دیگر ⇒ `IDEMPOTENCY_CONFLICT`؛ شکست‌ها ثبت نمی‌شوند |
| **charge** | `min(amount, remaining)`؛ مازاد = `shortfall` (ثبت می‌شود، بدهی نمی‌سازد)؛ موجودی هرگز منفی نمی‌شود |
| **close** | `remainder` **بی‌پیش‌فرض**: `release` (برمی‌گردد) یا `forfeit` (صریحاً مصرف‌شده) |
| **انقضا** | `ttlMs` الزامی؛ انقضای تنبل **آزاد می‌کند، هرگز مصرف نمی‌کند**؛ `charge` پس از انقضا `RESERVATION_EXPIRED`؛ ساعت برای هر حساب یکنواست |
| **ژورنال** | هر تغییر موجودی ورودی دارد؛ بازپخش از صفر = حالت؛ `granted + refunded = available + held + charged + forfeited` |
| **ذخیره** | پورت `AccountStore.transact` سریالیِ هر حساب و اتمی؛ پرتاب ذخیره ⇒ `STORE_FAILURE` و تکرار با همان شناسه بی‌خطر است |
| **سقف‌ها** | ۱۰۰۰ رزرو باز، ۱۶ تلاش برای هر رزرو، ttl از ۱ثانیه تا ۲۴ساعت، شناسه ≤ ۱۲۸ نویسه (`^[A-Za-z0-9][A-Za-z0-9._:-]*$`؛ `#` و `/` مجاز نیست؛ `requestId:n` مجاز است) |

## کدهای خطا
`INVALID_INPUT` · `ACCOUNT_NOT_FOUND` · `UNIT_MISMATCH` · `INSUFFICIENT_CREDIT` · `RESERVATION_NOT_FOUND` · `RESERVATION_CLOSED` · `RESERVATION_EXPIRED` · `TOO_MANY_OPEN_RESERVATIONS` · `TOO_MANY_ATTEMPTS` · `CHARGE_NOT_FOUND` · `REFUND_EXCEEDS_CHARGE` · `IDEMPOTENCY_CONFLICT` · `OVERFLOW` · `STORE_FAILURE` · `INTERNAL_ERROR`. پیام‌ها فارسی، ثابت و بی‌پژواکِ مقدار ورودی/پیام ذخیره‌اند.

## پیاده‌سازی پورت ذخیره (برای ل۲)
`store-contract.ts` یک آزمون قرارداد است (`describeStoreContract(label, make)`)؛ هر ذخیرهٔ تازه باید آن را بی‌تغییر بگذراند: سریال‌بودن همزمانی، اتمی‌بودن (حالت + ژورنال)، کپی‌بودن، جداسازی مستأجر، `fn` دقیقاً یک بار.

## آنچه هنوز نیست (ADR-0018)
ل۲ ذخیرهٔ PostgreSQL · ل۳ آداپتور `ai-gateway`/ارکستراتور (`Cost` ← مبلغ، شناسهٔ تلاش، ttl از بودجهٔ زمانی دروازه) · ل۴ پرداخت، رفتگر رزروهای منقضی، انقضای اعتبار اعطاشده، گزارش. هیچ احرازِ هویتی نیست: `tenantId` را لایهٔ بالاتر از نشست می‌آورد.

## آزمون‌ها
`validate` · `engine` (خالص؛ ورودیِ منجمد) · `invariants` · `ledger` (سرویس: جداسازی، یکتایی، انقضا، شکست ذخیره، همزمانی) · `ledger.property` (۲۰۰ بذر × ۶۰ عملیات + ادعای پوشش) · `memory-store` (قرارداد پورت) · `purity` (نگهبان منبع). جهشی: `python3 tooling/mutation/ledger.py`.
