# settlement م۳‑د‑۳ب: اجارهٔ رکوردها برای رفتگر (`claimDue`)

## هدف (یک جمله)
رفتگرهای هم‌زمان رکوردِ سررسیدهٔ یکسان را دوباره پردازش نکنند: `claimDue` اتمی (`FOR UPDATE SKIP LOCKED`) رکوردها را می‌گیرد و سررسیدشان را تا `leaseMs` عقب می‌برد — بی‌مهاجرت، افزایشی و با اجارهٔ خودبه‌خود تمام‌شونده.

## زمینه
تحویل ۰۰۲۸ «گام بعد ۱» و ADR-0028 «آنچه این برش نیست». ADR-0029 تصمیم‌ها (از جمله ردِ مهاجرتِ `0003`) را ثبت کرده است.

## ماژول و پوشه‌های مجاز
`src/modules/settlement/` فقط: `types.ts`، `validate.ts`، `config.ts`، `memory-outbox.ts`، `pg/store.ts`، `pg/types.ts`، `sweeper.ts`، `index.ts` (صادرکردنِ نوع‌ها)، `README.md`، و فایل‌های **جدید**: `contract/claim-contract.ts`، `memory-claim.test.ts`، `pg/claim.unit.test.ts`، `pg/claim.pg.test.ts`، `sweeper.lease.test.ts`، `sweeper.lease.pg.test.ts`، `tooling/mutation/settlement-sweeper-lease.py`. تنها ویرایشِ آزمونِ موجود: `pg/unit.test.ts` (یک کلید در فهرستِ کلیدهای خروجی؛ `Test-Change-Approved`). بعلاوه `docs/` و `tooling/ci-tests.ts` (فقط کفِ دروازه؛ کامیتِ جدا).

## ممنوع
مهاجرتِ تازه؛ تغییرِ هر آزمونِ موجود جز مورد بالا؛ تغییرِ `outbox-contract.ts`؛ تغییرِ `SweepReport`/`SweepLoop`؛ افزودنِ متدِ اجباری به `SettlementOutbox`؛ ماژولی جز `settlement`؛ وابستگیِ تازه؛ `now()` پایگاه.

## قرارداد
افزایشی: نوع‌های `DueClaimer`/`ClaimQuery` (صادر می‌شوند)، `SweeperConfig.leaseMs?`، `SETTLEMENT_LIMITS.maxLeaseMs`.

## معیار پذیرش
1. `claimDue` فقط رکوردهای فعالِ `dueAtMs ≤ now` را به ترتیبِ (سررسید، شناسه) تا `limit` می‌گیرد؛ `dueAtMs := now + lease` (هرگز عقب)؛ عکسِ پس از به‌روزرسانی؛ بی‌تغییرِ وضعیت/قصد/`attempts`/کد؛ done/dead هرگز.
2. در طولِ اجاره نه `listDue` و نه `claimDue` رکورد را می‌بینند؛ دقیقاً در `now+lease` دوباره سررسیده است؛ `recordFailure`/`finish`/`bury`/نوشتنِ درون‌خطی روی رکوردِ اجاره‌شده کار می‌کنند.
3. اعتبارسنجیِ مرزی: `leaseMs` ۱…۸۶٬۴۰۰٬۰۰۰، `limit` ۱…۱۰۰۰، `now+lease` صحیحِ ایمن؛ ورودیِ نامعتبر ⇒ `INVALID_INPUT` بی‌تماس با پایگاه.
4. **هم‌زمانیِ واقعی (PostgreSQL):** ۶ فرایند ⇒ هر رکورد دقیقاً یک‌بار؛ `SKIP LOCKED` منتظر نمی‌ماند؛ رقابت با `bury`/`recordFailure`/نوشتنِ درون‌خطی بی‌خطا و بی‌بن‌بست؛ نقشهٔ اجرا از ایندکسِ جزئی.
5. رفتگر: `leaseMs` ⇒ `claimDue`؛ بی‌آن ⇒ `listDue` (رفتارِ پیشین)؛ N رفتگر ⇒ یک `close` به ازای هر رکورد؛ اجارهٔ ازدست‌رفته وسطِ دسته ⇒ رها (`raced`) و بی‌تکرار؛ پورتِ خراب/قدیمی ⇒ بی‌پرتاب؛ `leaseMs` با outboxِ بی‌`claimDue` ⇒ `INVALID_CONFIG`.
6. حافظه‌ای و PostgreSQL یک قرارداد را بی‌تغییر می‌گذرانند؛ آزمونِ تفاضلی و خاصیتی.
7. فقط یک آزمونِ موجود تغییر کند (کلیدِ خروجی) با `Test-Change-Approved`؛ دروازهٔ صفر-رد سبز؛ کفِ دروازه بالا برود؛ آزمونِ جهشی بی‌زندهٔ توضیح‌نشده.

## تست‌های مورد انتظار
عادی (گرفتن، ترتیب، limit)، مرزی (`dueAtMs==now`، `now+lease==MAX_SAFE`، `leaseMs` ۱ و سقف، COLLATE C)، خطا (نامعتبر، getterِ بدجنس، خرابیِ پایگاه، ردیفِ خراب، پورتِ خراب)، هم‌زمانی چندفرایندی، `SKIP LOCKED`، رقابت، ماندگاری، تفاضلی، نقشهٔ `EXPLAIN`، و رفتگر (حذفِ کارِ تکراری، پایانِ اجاره، مرگِ دارنده).

## خارج از کار
ریشهٔ ترکیب، مالک/فنسینگ، `status` در registry، بایگانی.

## وابستگی‌ها
ADR-0021/0022/0023/0027/0028؛ تحویل ۰۰۲۸.

## بازبینی و ریسک
**بله.** پول (`settlement`). تگ `pre-risk/20261120-sweeper-lease` روی HEAD سبز پیش از اولین ویرایش زده شد؛ کامیت‌های کد `Risk-Tag` دارند. بازبین: مالک معماری + مالک امنیت/مالی.
