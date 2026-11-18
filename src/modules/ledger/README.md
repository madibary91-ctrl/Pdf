# ledger (لایهٔ ۳ · غیرخالص · **بازبینی انسانیِ اجباری: مالک امنیت**) — **ل۱: هستهٔ دفتر اعتبار + ل۲: ذخیرهٔ PostgreSQL**

**هدف:** دفتر اعتبارِ هر حساب: **اعطا ← رزرو ← مصرف (به ازای هر تلاش) ← بستن ← بازگشت**، با مبلغِ صحیح، یکتاییِ بر پایهٔ شناسهٔ عملیات، ژورنالِ فقط‌افزودنی و ناوردای بقا. تصمیم‌ها و دلیل‌ها: `docs/adr/0018-ledger-core.md`.
**وابستگی:** طبق `registry.ts` فقط `shared-types` (در عمل هیچ import بین‌ماژولی ندارد). به شبکه، فایل، `process.env`، ساعت سیستم و تصادف دست نمی‌زند؛ ساعت و ذخیره **تزریق** می‌شوند (آزمونِ نگهبان این را روی کد منبع می‌سنجد).

> ⚠️ **ل۱ و ل۲ از ۴ برش‌اند.** ذخیرهٔ حافظه‌ای (`createMemoryStore`) فقط برای آزمون/توسعه است و با ریستارت می‌رود. ذخیرهٔ ماندگار PostgreSQL (`createPgAccountStore`، ل۲؛ ADR-0019) اکنون هست، ولی **هنوز به کاربر/پول واقعی وصل نکنید**: بازبینی مالک امنیت/معماری انجام نشده، احراز هویت و آداپتور ارکستراتور (ل۳) و پرداخت/رفتگر/بایگانی (ل۴) نیست، و سیاست پشتیبان‌گیری (RPO) روشن نشده. در `registry.ts` وضعیت `planned` می‌ماند.

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

## ذخیرهٔ PostgreSQL (ل۲؛ ADR-0019)
```ts
import { drizzle } from "drizzle-orm/node-postgres";
const made = createPgAccountStore(drizzle(pool), { schema: "ledger" });   // PgStoreResult<PgAccountStore>؛ schema پیش‌فرض: "ledger"
if (!made.ok) fail(made.error);
const store = made.value;
const m = await store.migrate();                                           // صریح، idempotent، هم‌زمان‌امن؛ فروشگاه خودش هرگز مهاجرت نمی‌کند
const ledger = createLedger({ store, clock });
await store.audit({ tenantId, accountId });                                // ناوردا + بازپخش ژورنال = حالت (اسنپ‌شات یکپارچه)
```
- **جدول‌ها** در شِمای جدا (`account`، `reservation`، `processed` = کلیدهای یکتایی، `journal`، `migration_ledger`) و با **SQL دست‌نویس** (`pg/migrations.ts`، checksum قفل‌شده؛ مهاجرتِ اعمال‌شده هرگز ویرایش نمی‌شود). `drizzle-kit push` به آن‌ها دست نمی‌زند.
- **`transact`** = یک تراکنش: قفل مشورتیِ حساب (حتی حسابِ ناموجود) ← سپر مهاجرت ← `SELECT … FOR UPDATE` ← `fn` دقیقاً یک بار ← نوشتن تفاضل ← commit؛ شکست = rollback کامل. هر پرتابِ پایگاه به `LedgerStoreError` با پیام امن (بی‌SQL/پارامتر/رشتهٔ اتصال) و در سرویس به `STORE_FAILURE` تبدیل می‌شود.
- **پایگاه خودش ناوردا را اجرا می‌کند** (دفاع در عمق): `CHECK` بقا `granted + refunded = available + held + charged + forfeited`؛ `CHECK` حسابداری رزرو؛ دامنه‌های هم‌ارز `ID_RE`/`UNIT_RE`/صحیح‌ایمن؛ TRIGGER: ژورنال و کلیدهای یکتایی فقط‌افزودنی (UPDATE/DELETE/TRUNCATE ممنوع)، `seq` ژورنال دقیقاً `max+1`، `seq`/ساعت/totals هرگز کم نمی‌شوند، `unit` تغییرناپذیر، رزروِ بسته نهایی است (جز رشدِ `refunded`).
- **شکست بسته:** مهاجرتِ ناهمخوان/معلق ⇒ هر عملیات رد؛ ردیف خراب یا حالتی که `checkInvariants` را می‌شکند ⇒ `CORRUPT_DATA` و به موتور داده نمی‌شود؛ هیچ «اصلاح بی‌صدا» نیست.
- **محدودیت‌ها:** هزینهٔ `transact` ∝ اندازهٔ حالت حساب (پورت کل حالت را می‌خواند؛ بایگانی/خواندن تنبل کار ل۴)؛ فقط primary؛ بازیابی از پشتیبان می‌تواند اعتبارِ مصرف‌شده را «برگرداند».

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
ل۳ آداپتور `ai-gateway`/ارکستراتور (`Cost` ← مبلغ، شناسهٔ تلاش، ttl از بودجهٔ زمانی دروازه) · ل۴ پرداخت، رفتگر رزروهای منقضی، انقضای اعتبار اعطاشده، گزارش. هیچ احرازِ هویتی نیست: `tenantId` را لایهٔ بالاتر از نشست می‌آورد.

## آزمون‌ها
`validate` · `engine` (خالص؛ ورودیِ منجمد) · `invariants` · `ledger` (سرویس: جداسازی، یکتایی، انقضا، شکست ذخیره، همزمانی) · `ledger.property` (۲۰۰ بذر × ۶۰ عملیات + ادعای پوشش) · `memory-store` (قرارداد پورت) · `purity` (نگهبان منبع). جهشی: `python3 tooling/mutation/ledger.py`.
آداپتور PostgreSQL (`pg/`، نیازمند پایگاه واقعی؛ شِمای یک‌بارمصرف): `unit` (مهاجرت/نام‌گذاری/نگاشت خطا/ردیف‌ها) · `store-contract.pg` (**همان** `describeStoreContract` بی‌تغییر) · `store` (مهاجرت و سپر، ماندگاری، هم‌زمانی روی سرویس، رد شدن دورزدن‌ها توسط پایگاه، اتمی‌بودن، دادهٔ خراب، ممیزی) · `ledger.pg.property` (موتور واقعی روی PostgreSQL ≡ ذخیرهٔ حافظه‌ای + ادعای پوشش) · `guard` (نگهبان منبع آداپتور). جهشی: `python3 tooling/mutation/ledger-pg.py`.
