# tool-call-deadline — سقفِ سختِ مهلتِ تماسِ مدل (رفعِ «گامِ زامبی»)

## هدف (یک جمله)
تماسِ مدلی که از `maxCallMs < graceMs` بگذرد لغو و با هزینهٔ نامعلوم بسته شود تا رفتگر هرگز رزروِ تماسِ زنده را نبندد، و رابطه‌های زمانی `maxCallMs < graceMs` و `ttl ≥ ۲×graceMs` یک منبعِ حقیقتِ خالص داشته باشند.

## زمینه
ADR-0065 (یافتهٔ الف)، ADR-0063/0064؛ پیش‌نیازِ CT‑5c‑2 (آستانه‌ها).

## ماژول و پوشه‌های مجاز
`src/modules/tool-call-deadline/` (تازه)، `src/modules/registry.ts` (یک سطر)، `tooling/git-discipline.ts` (`HIGH_RISK_MODULES`)، `docs/high-risk-areas.md`، `docs/known-pitfalls.md`، `tooling/ci-tests.ts` (فقط `MIN_PASSED_TESTS`)، آزمون‌های تازهٔ `tooling/tool-call-deadline-*.test.ts`، ADR/task/handoff.

## ممنوع
هر تغییر در `durable-tool-gateway`/`metered-tool-gateway`/`settlement*`/`metering`/`ai-gateway`، هر آزمونِ موجود، وابستگیِ تازه، هر عددِ پول/قیمت، تغییرِ قرارداد.

## قرارداد
بی‌تغییر؛ ماژولِ تازه فقط `ToolGateway`ِ موجود را می‌پوشاند (خودش هم `ToolGateway` است).

## معیار پذیرش
۱) سقف: تماسِ آویزان درست در `maxCallMs` `TIMEOUT` می‌دهد، لغو می‌کند، تایمر پاک؛ ۲) هزینه «نامعلوم» (نه «هیچ»)؛ ۳) جوابِ دیرهنگام بی‌اثر و فقط رویدادِ بی‌متن؛ ۴) با دروازهٔ ماندگار: بی‌پوشش زامبی (شاهدِ کنترل)، با پوشش settlement-failed/SETTLEMENT_PENDING ناممکن، رفتگر هرگز کار ندارد؛ ۵) روی PG و حلقهٔ واقعی؛ ۶) `checkTimingRelations` مرزِ دقیق؛ ۷) جهش‌آزمایی روی کدِ تولیدی همه کشته؛ ۸) هیچ آزمونِ موجود تغییر نکند.

## تست‌های مورد انتظار
ماژول: config، relations، deadline، property؛ tooling: نگهبانِ منبع، ترکیبِ حافظه‌ای، PG+حلقه (بدونِ پایگاه رد می‌شوند؛ دروازهٔ صفر-رد قرمز می‌کند).

## خارج از کار
خودِ آستانه‌ها و تنظیماتِ ادمین (CT‑5c‑2a/b)، ریشهٔ I/O، `LATE_AFTER_CLOSE`، قطعِ TCP.

## وابستگی‌ها
ADR-0063/0064/0065.
