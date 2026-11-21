# settlement-pending

نمایهٔ **مشتق و اختیاریِ** «مرده‌هایی که هنوز تأیید رسیدگی نشده‌اند» (م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۱، ADR-0046). پایشِ پسماند (`settlement-backlog`) هر ۳۰ ثانیه
`listUnacknowledgedDead` را می‌خواند؛ آن پرسش در `settlement` ضدپیوندِ outbox × تأییدهاست و هزینه‌اش با **شمارِ مرده‌های تأییدشده** (که هرگز حذف نمی‌شوند)
خطی رشد می‌کند (ADR-0044). این ماژول همان پاسخ را با هزینهٔ **O(تأییدنشده‌ها)** می‌دهد.

**هیچ قراردادی از `settlement` عوض نشد** (نه `MIGRATIONS`ِ آن، نه پورتِ `SettlementOutbox`، نه آزمون‌های قفل‌شده). مهاجرتِ این ماژول **دفترِ جدا**ی خودش را دارد
(`settlement_pending_migration_ledger`). نصب‌نکردنِ آن = رفتارِ امروز. **سیم‌کشی به bootstrap/پایش در این برش نیست** (برشِ ب‑۲).

## استفاده
```ts
const made = createPendingDeadIndex(db, { schema: "settlement", readStatementTimeoutMs: 6_000 }); // هر دو اختیاری
if (!made.ok) throw new Error(made.error.code);
const index = made.value;
await index.migrate();          // پس از migrate ی settlement؛ idempotent، هم‌زمان‌امن؛ backfill زیرِ قفل
const v = await index.verify(); // ابزارِ عملیاتیِ سنگین: { consistent, expected, indexed, missing, stale }
const r = await index.listUnacknowledgedDead({ limit: 1000 }); // هم‌امضا با PgSettlementOutbox؛ پورتِ BacklogOutbox
```

## چگونه کار می‌کند
- جدولِ `settlement_dead_pending(tenant_id, account_id, reservation_id, settled_at_ms)` + ایندکسِ `(settled_at_ms, tenant_id, account_id, reservation_id)`؛ ستون‌ها از دامنه‌های settlement (ترتیبِ `COLLATE "C"` یکسان).
- **TRIGGERهای پایگاه در همان تراکنشِ نویسنده:** ورود به `dead` (درج یا UPDATE) ردیف می‌افزاید؛ درجِ تأیید آن را حذف می‌کند. کدِ رفتگر/آداپتورِ settlement دست‌نخورده است و SQL مستقیم هم پوشش دارد.
- **نگهبانِ نمایه:** درج/حذف/ویرایش/`TRUNCATE` مستقیم رد می‌شود (فقط از درونِ TRIGGERهای بالا، `pg_trigger_depth() ≥ 2`).
- **backfill** در همان تراکنشِ مهاجرت زیرِ `LOCK TABLE … SHARE ROW EXCLUSIVE` (نویسنده‌ها منتظر می‌مانند، خواننده‌ها نه) با `lock_timeout` ۱۵ثانیه ⇒ شکست‌بسته.
- **خواندن:** کلیدها از نمایه، خودِ رکورد با اتصالِ کلیدی از outbox؛ سه شرطِ حقیقت (`dead`، همان `settled_at_ms`، بی‌تأیید) دوباره سنجیده می‌شود ⇒ ردیفِ **کهنه** هرگز خروجی نیست.

## ناورداها
- **حقیقت outbox است، نمایه مشتق:** ردیفِ نمایه ⇔ رکوردِ `dead` بی‌تأیید (`verify()` آن را می‌سنجد). ردیفِ کهنه بی‌خطر است (فیلتر می‌شود)؛ ردیفِ **گم‌شده** خطرناک است (زنگی که پایش نمی‌بیند) و TRIGGER + backfill + نگهبان برای همین‌اند.
- **این ماژول در `settlement_outbox`/`settlement_dead_ack` نمی‌نویسد** (آزمونِ منبع)؛ فقط TRIGGER روی آن‌ها می‌گذارد و می‌خواند.
- **بی‌پرتاب:** `listUnacknowledgedDead` هرگز نمی‌پرتابد (`INVALID_INPUT`/`STORE_FAILURE`)؛ شکستِ پایگاه هرگز «پسماندِ خالی» نیست. پیام‌ها بی‌نشتِ SQL/رشتهٔ اتصال.
- **سقفِ زمانِ سمتِ پایگاه** (`readStatementTimeoutMs`): فقط `SET LOCAL` درونِ تراکنشِ فقط‌خواندنی؛ هم‌ارزِ ADR-0045 (آزمونِ تفاضلیِ مرزها با آداپتورِ settlement).
- **هم‌ارزیِ کامل با پرسشِ فعلی:** آزمونِ تفاضلیِ تصادفی (۴ بذر، گره‌های زمان، شناسه‌های حساس به locale، مهاجرتِ میانهٔ داستان) خروجی را عمیقاً با آداپتورِ settlement می‌سنجد.
- **هزینه:** آزمونِ پذیرشِ `EXPLAIN (ANALYZE, BUFFERS)` روی همان SQLِ ضبط‌شده: ردیف‌های لمس‌شده با ۱۰× تأییدشده دقیقاً ثابت‌اند (کنترل: پرسشِ قدیمی ≈ ۱۰×).

## حدّهای صادقانه
- جدولِ نمایه **پرگردش** است؛ هیپِ آن تا vacuum باد می‌کند (autovacuum روی همین جدول با آستانهٔ ثابتِ ۲۰۰ تنظیم شده). کارِ منطقی ثابت است، بلوک‌های خوانده‌شده نه الزاماً.
- backfill نویسنده‌های outbox را تا پایانِ پیمایشِ O(مرده‌ها + تأییدها) نگه می‌دارد؛ مهاجرت را در پنجرهٔ کم‌بار اجرا کنید.
- `verify()` سنگین است (O(مرده‌ها + تأییدها)): برای ابزارِ عملیاتی، نه حلقهٔ دوره‌ای. مالکِ پایگاه (superuser) می‌تواند TRIGGERها را خاموش کند؛ `verify()` همان را می‌گیرد.
- بی‌سیم‌کشی: تا برشِ ب‑۲، پایش همچنان از `PgSettlementOutbox.listUnacknowledgedDead` می‌خواند.
