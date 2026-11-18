# دستور کار ۰۰۱۷ — ledger: ذخیرهٔ PostgreSQL (برش ل۲)

## هدف (یک جمله)
پورت `AccountStore` ل۱ روی PostgreSQL پیاده شود (مهاجرت، `transact` سریال و اتمی، ناوردای سمت پایگاه، `audit`) و **همان آزمون قرارداد** بی‌تغییر روی پایگاه واقعی بگذرد.

## زمینه
ADR-0018 ل۲ را «ذخیرهٔ ماندگار» تعریف کرد. تصمیم‌ها: `docs/adr/0019-ledger-postgres-store.md` (**پیش از کد** کامیت می‌شود).

## ماژول و پوشه‌های مجاز
- `src/modules/ledger/pg/**` (فایل‌های تازه)
- `src/modules/ledger/index.ts` (فقط افزودن export)، `src/modules/ledger/README.md`
- `docs/**` (ADR، این دستور کار، یادداشت تحویل)
- `tooling/mutation/ledger-pg.py` (تازه)، `tooling/ci-tests.ts` (**فقط** `MIN_PASSED_TESTS`، کامیت جدا با `Risk-Tag`)
- **تنها تغییر مجاز در تستِ موجود:** فهرست export در `src/modules/ledger/purity.test.ts` (با `Test-Change-Approved`؛ ADR-0019 تصمیم ۱).

## ممنوع
هستهٔ ل۱ (`engine`، `ledger`، `validate`، `invariants`، `types`، `memory-store`، `store-contract.ts`، `test-kit.ts`)، `registry.ts`، `shared-types`، `src/db/`، هر ماژول دیگر، هر تست موجود به‌جز مورد بالا، وابستگی خارجی تازه، تغییر پورت `AccountStore`.

## قرارداد
رابط عمومی (فقط افزوده): `createPgAccountStore(db, { schema? })` ⇒ `PgStoreResult<PgAccountStore>`؛ `PgAccountStore = AccountStore + migrate() + status() + audit(key)`؛ نوع‌های `LedgerDatabase`، `LedgerExecutor`، `PgStoreError`، `AccountAudit`، `PgMigrationReport`؛ ثابت `LEDGER_DEFAULT_SCHEMA`.

## معیار پذیرش (هر مورد با تست)
1. `describeStoreContract` روی PostgreSQL بی‌تغییر سبز (سریال‌بودن ۴۰ transact موازی، اتمی، کپی، جداسازی مستأجر، `fn` دقیقاً یک بار).
2. مهاجرت: idempotent، هم‌زمان امن، checksum ۰۰۰۱ قفل، دست‌کاری/ناشناخته/حفره/معلق ⇒ خطا؛ نام شِمای نامعتبر رد.
3. ماندگاری: حالت/ژورنال/رسیدهای بازتکرار پس از «ریستارت» (فروشگاه و اتصال تازه) دست‌نخورده.
4. هم‌زمانی روی سرویس واقعی: ۵۰ `reserve` موازی ⇒ دقیقاً ۱۰ موفق؛ `charge` هم‌زمان با یک `attemptId` ⇒ یک اثر؛ `openAccount` هم‌زمان ⇒ یک حساب، بقیه `replayed`.
5. پایگاه هر دورزدن را رد می‌کند (UPDATE/DELETE/TRUNCATE ژورنال و کلیدها؛ `seq` حفره‌دار/تکراری؛ کاهش `seq`/totals؛ تغییر `unit`؛ شکستن بقا؛ شکستن حساب رزرو؛ بازکردن رزرو بسته؛ شناسه/واحد نامعتبر).
6. اتمی: شکست درج وسط commit ⇒ هیچ‌چیز نوشته نمی‌شود؛ `fn` پرتاب ⇒ هیچ‌چیز.
7. دادهٔ دست‌کاری‌شده (از مسیر SQL با خاموش‌کردن قید) ⇒ `transact`/`read` می‌پرتابند و چیزی نمی‌نویسند.
8. `audit`: حساب سالم ⇒ ok؛ حالت منحرف از ژورنال ⇒ گزارش دقیق.
9. آزمون خاصیتی (موتور واقعی) روی PostgreSQL ≡ ذخیرهٔ حافظه‌ای پس از هر عملیات؛ `audit` سالم.
10. نگهبان آداپتور؛ مرزهای رجیستری سبز؛ جهشی (`tooling/mutation/ledger-pg.py`) بی‌جهشِ زنده؛ `MIN_PASSED_TESTS` بالا می‌رود.

## خارج از کار
ل۳، ل۴، API/UI، احراز هویت، تغییر registry، بهینه‌سازی خواندن تنبل، پشتیبان‌گیری.

## وابستگی‌ها
ADR-0018 / دستور کار ۰۰۱۶ (ل۱ کامل).

## بازبینی و ریسک
ناحیهٔ پرریسک (دفتر اعتبار + SQL/مهاجرت) ⇒ بازبینی **مالک امنیت و مالک معماری** اجباری؛ تگ `pre-risk/…` پیش از اولین ویرایش کد و پیش از ویرایش `ci-tests.ts`.

## تعریف «تمام شد»
تست‌ها و CI سبز با PostgreSQL واقعی، README ماژول، یادداشت تحویل ۰۰۱۹، پچ اثبات‌شده روی کلون تازه.
