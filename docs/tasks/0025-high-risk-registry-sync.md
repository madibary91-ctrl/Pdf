# tooling م۳‑ه: همسوییِ ماشین‌خوانِ مسیرهای پرریسک با registry

## هدف (یک جمله)
فاصلهٔ موجود میان `humanReview` در `registry.ts`، `HIGH_RISK` در `tooling/git-discipline.ts` و `docs/high-risk-areas.md` را ببندد و با یک آزمونِ ماشین‌خوان نگذارد دوباره باز شود.

## زمینه
تحویل ۰۰۲۶ («گام بعد ۲» و هفتمین یادآوری): `settlement`/`metering` هنوز `HIGH_RISK` نیستند. اندازه‌گیری نشان داد ۱۱ ماژولِ `humanReview:true` بیرون از `HIGH_RISK` بودند. ADR-0027 تصمیم‌ها را ثبت کرده است.

## ماژول و پوشه‌های مجاز
`tooling/git-discipline.ts` (فقط `HIGH_RISK_MODULES`، `HIGH_RISK_BEYOND_REGISTRY` و ساختنِ regex)، `tooling/high-risk-registry-sync.test.ts` (جدید)، `tooling/mutation/high-risk-registry-sync.py` (جدید)، `docs/high-risk-areas.md`، `AGENTS.md` (فقط نمونه‌های «نواحی پرریسک»)، `tooling/ci-tests.ts` (فقط کفِ دروازه؛ کامیتِ جدا).

## ممنوع
هر فایلِ `src/modules/**` (از جمله `registry.ts`)؛ تغییرِ هر آزمونِ موجود؛ وابستگیِ تازه؛ import کردنِ registry در `git-discipline.ts` یا هوک‌ها؛ تغییرِ رفتارِ مسیرهای پرریسکِ پیشین.

## قرارداد
افزایشی: دو ثابتِ صادرشدهٔ تازه در `git-discipline.ts`. `isHighRiskPath(path)` همان امضا؛ فقط مجموعهٔ ماژول‌ها بزرگ‌تر می‌شود.

## معیار پذیرش
1. هر ماژولِ `humanReview:true` در registry پرریسک است (آزمون، همهٔ ماژول‌ها).
2. هر نامِ `HIGH_RISK_MODULES` در registry هست و یا `humanReview:true` است یا استثنای دلیل‌دار.
3. هر استثنا دلیل دارد و واقعاً `humanReview:false` است.
4. هر ماژولِ `humanReview:true` در `docs/high-risk-areas.md` ذکر شده است.
5. `settlement/pg/migrations.ts`، `metering/…`، `ai-orchestrator/…` ⇒ پرریسک؛ آزمون/README همان ماژول‌ها و ماژول‌های بی‌بازبینی و نام‌های هم‌پیشوند ⇒ نه.
6. نام‌ها معتبر و بی‌تکرارند؛ regex ساخته‌شده شاهدهای پیشین را بدون تغییر می‌گذراند.
7. آزمونِ جهشی: هر جهشِ معنادار (حذفِ نام، افزودنِ شبح، حذفِ ردیفِ سند، حذفِ استثنا، سست‌کردنِ لنگرِ regex، …) آزمون را قرمز کند یا با دلیل هم‌ارز باشد.
8. هیچ آزمونِ موجودی تغییر نکند؛ دروازهٔ صفر-رد سبز؛ کفِ دروازه بالا برود.

## تست‌های مورد انتظار
عادی (تطابقِ کامل)، مرزی (نامِ هم‌پیشوند، `registry.ts`، آزمون/README)، خطا (نامِ شبح، استثنای کهنه، ماژولِ بی‌ردیفِ سند)، و «آزمونِ آزمون» با جهش.

## خارج از کار
مشتق‌کردنِ HIGH_RISK در زمانِ اجرای هوک؛ ویرایشِ `registry.ts` (`status` ناهمخوانِ سه ماژول)؛ م۳‑د‑۳؛ ریشهٔ ترکیب.

## وابستگی‌ها
ADR-0001، ADR-0008؛ تحویل ۰۰۲۶.

## فایل‌های مرجع برای خواندن
`tooling/git-discipline.ts` (`HIGH_RISK`)، `tooling/git-discipline.test.ts` («مسیرهای پرریسک»)، `docs/high-risk-areas.md`، `src/modules/registry.ts`، `tooling/mutation/settlement-dead-ack.py` (قالبِ جهشی).

## بازبینی و ریسک
**بله.** `tooling/git-discipline.ts` ناحیهٔ پرریسک است: تگ `pre-risk/20261119-high-risk-registry-sync` روی HEAD سبز پیش از اولین ویرایش زده شد؛ کامیت `Risk-Tag` دارد. بازبین: مالک معماری + مالک امنیت.
