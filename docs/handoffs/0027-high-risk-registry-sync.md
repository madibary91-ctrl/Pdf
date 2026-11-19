# یادداشت تحویل ۰۰۲۷ — tooling م۳‑ه: همسوییِ ماشین‌خوانِ مسیرهای پرریسک با registry

**کامیت پایه:** `d1d9cae` (شاخهٔ `main`؛ تحویل ۰۰۲۶، ۲۷۹۵ تست). مخزن: `madibary91-ctrl/Pdf`. کلون تازه، `pnpm install --frozen-lockfile` و `node tooling/git-discipline.ts install` انجام شد. به مخزن پوش **نکرده‌ام** (پچ و bundle در Gofile؛ پیوند در پاسخ تحویل).

## ۱) چرا این برش (تصمیم من)
دو گزینهٔ «گام بعد» در ۰۰۲۶ را سنجیدم: م۳‑د‑۳ (`SKIP LOCKED` + `recordFailure` تکرارپذیر) و ورودِ `settlement`/`metering` به `HIGH_RISK`. م۳‑د‑۳ **مهاجرتِ SQL و کدِ outbox** را عوض می‌کند، یعنی دقیقاً همان مسیرهایی که تا امروز **بدونِ نقطهٔ برگشتِ اجباری** قابل ویرایش بودند. پس نخست باید حفاظ برقرار شود، بعد کارِ خطرناک. هنگام اندازه‌گیری دیدم مسئله بزرگ‌تر از «دو ماژول» است: **۱۱ ماژولِ `humanReview:true` در registry از `HIGH_RISK` بیرون بودند** (`settlement`، `metering`، `ai-orchestrator` + هشت ماژولِ برنامه‌ریزی‌شده). یادآوریِ انسانی (هفت بار) جواب نداده بود چون هیچ تستی آن را نمی‌گرفت. پس به‌جای افزودنِ دو نام، **ناوردای ماشین‌خوان** گذاشتم. دقیقاً یک برش در این گفتگو؛ م۳‑د‑۳ دست‌نخورده ماند.

## ۲) چه ساخته شد
- `tooling/git-discipline.ts`: `HIGH_RISK_MODULES` (منبعِ واحدِ regex؛ ۲۴ نام) و `HIGH_RISK_BEYOND_REGISTRY` (دو استثنای دلیل‌دار: `shared-types`، `legal-kb-store`). `isHighRiskPath` همان امضا و رفتارِ پیشین؛ فقط مجموعه بزرگ‌تر شد.
- `tooling/high-risk-registry-sync.test.ts` (جدید، **۱۸ آزمونِ تازه**): (الف) حالتِ واقعی: registry ⇒ regex، regex ⇒ registry (بی‌شبح، بی‌استثنای کهنه)، registry ⇒ سند، شاهدهای منفی (README/آزمون/نامِ هم‌پیشوند/لنگر)؛ (ب) **آزمونِ آزمون:** `auditHighRiskCoverage` روی سناریوهای ساختگی قرمز می‌شود (شبح، افتادن از فهرست، استثنای کهنه/بی‌دلیل، ردیفِ سندِ گم‌شده، نام نامعتبر/تکراری، ماژولِ تازه در registry) و حالتِ سالمِ ساختگی سبز می‌ماند.
- `docs/high-risk-areas.md`: ۱۱ ردیفِ تازه + بندِ استثناها. `AGENTS.md`: یک جمله.
- `tooling/mutation/high-risk-registry-sync.py`: ۴۸ جهش.
- **اثبات عملی که حفاظ واقعاً کار می‌کند:** در کلونِ موقت، ویرایشِ `src/modules/settlement/sweeper.ts` بدون `Risk-Tag` ⇒ `commit-msg` با `[risk-tag-missing]` رد شد؛ با `Risk-Tag` پذیرفته شد (پیش از این برش هر دو پذیرفته می‌شد).

## ۳) تغییر در تست‌های موجود — **هیچ**
`git diff --name-status d1d9cae..HEAD`: فقط `A` برای فایل‌های آزمون (`M` فقط برای `AGENTS.md`، `docs/high-risk-areas.md`، `tooling/ci-tests.ts`، `tooling/git-discipline.ts`). هیچ `*.test.ts` موجودی لمس نشد؛ `Test-Change-Approved` لازم نبود. فایلی زیر `src/modules/**` (از جمله `registry.ts`) تغییر نکرد.

## ۴) راستی‌آزمایی (PostgreSQL ۱۵ واقعی، Node 22.23)
- دروازهٔ صفر-رد: **۲۸۱۳ سبز، ۰ رد، ۰ شکست، ۱۶ todo** (۲۷۹۵ + ۱۸). `tsc`، `eslint` سبز. کفِ `MIN_PASSED_TESTS`: ۲۷۹۵ ← ۲۸۱۳ (کامیتِ جدا با `Risk-Tag`).
- **G13:** پچ‌ها روی **کلون تازهٔ `d1d9cae`** با `git am` اعمال شد؛ **درختِ نتیجه با درختِ من یکی است** (`caa1c683…`)؛ روی آن `tsc`، `eslint`، دروازهٔ صفر-رد (۲۸۱۳، کف ۲۸۱۳) و `npm run build` سبز.
- **جهشی:** `python3 tooling/mutation/high-risk-registry-sync.py` — ۴۸ جهش، **۴۸ از ۴۸ کشته، زندهٔ توضیح‌نشده ۰.** نخستین اجرا ۴۷ از ۴۸ بود: جهشِ [۲۰] («دلیلِ استثنا کوتاه») **ضعفِ خودِ جهش بود نه آزمون** (دلیلِ باقی‌مانده هنوز بلند بود)؛ جهش اصلاح و کشته شد. در دورِ نخست، دو نقطهٔ ضعفِ واقعی آزمون را پیش از جهش دیدم و بستم: لنگرِ ابتدای regex (`vendor/src/modules/…`) و شکلِ «نام با اسلش» در سند.

## ۵) انحراف‌ها و نکته‌ها (برای بازبینی)
1. **بازبینِ ردیف‌های سند پیشنهادِ من است** (از `purpose`ی registry برداشتم)؛ تست نامِ بازبین را نمی‌سنجد. لطفاً اصلاح/تأیید کنید.
2. **از این به بعد** هر تغییرِ کدِ غیرتست در `settlement`/`metering`/`ai-orchestrator` `Risk-Tag` می‌خواهد. کامیت‌های پیشینِ این ماژول‌ها عطف به ماسبق نمی‌شوند.
3. **ناهمخوانیِ کشف‌شدهٔ `status` در registry (عمداً اصلاح نشد؛ قرارداد است):** `metering`، `settlement`، `ai-orchestrator` روی دیسک و کامل‌اند ولی `status:"planned"`. آیا به `done` تغییر کنند؟ (کارِ جدا با تأییدِ معماری.)
4. `HIGH_RISK` هنوز **regexِ ساخته‌شده از آرایه** است، نه import از registry (ADR-0027؛ هوک بی‌وابستگی می‌ماند). اگر مالک مایل است مشتق‌کردنِ مستقیم، کارِ جدا.
5. `npm run build` بدونِ `DATABASE_URL` در `/api/health` می‌شکند («Failed to collect page data»)؛ در CI تعریف است. رفتارِ پیشین و بی‌ربط به این برش، فقط یادآوری.

## محدودیت‌های صادقانه
- این برش **هیچ رفتارِ زمان‌اجرا** را عوض نکرد؛ فقط انضباطِ تغییر را سفت کرد. شکاف‌های «پولیِ» م۳‑د‑۳ (دو حلقهٔ هم‌زمان کارِ تکراری می‌کنند؛ `recordFailure` تکرارپذیر نیست) **همچنان باز است**.
- ردیف‌های سند برای ماژول‌های هنوز-ساخته‌نشده (پوستهٔ دسکتاپ، لایسنس، …) حدسِ نقش‌اند.
- فقط لینوکس + PostgreSQL ۱۵. CI گیت‌هاب را نمی‌بینم؛ تگِ `green/<slug>` (G9) را نزدم و **پس از سبز دیدنِ CI باید خودتان بزنید**.
- بازبینی انسانیِ مالک معماری و امنیت انجام نشده است (`tooling/git-discipline.ts` ناحیهٔ پرریسک است).

## تأیید لازم از شما
1. **معماری/امنیت:** ADR-0027 تصمیم ۱ و ۲ (آرایه + آزمونِ همگامی به‌جای import از registry)، و بازبین‌های پیشنهادیِ ۱۱ ردیفِ سند.
2. **تصمیم:** `status` سه ماژولِ `settlement`/`metering`/`ai-orchestrator` در registry (بند ۳).

## گام بعد (پیشنهاد)
۱) **م۳‑د‑۳** (اکنون با `Risk-Tag` الزامی و نقطهٔ برگشت): نخست `recordFailure` تکرارپذیر (کوچک‌تر، بی‌مهاجرت؛ شمارندهٔ مورد انتظار یا توکنِ تلاش)، سپس lease/`SKIP LOCKED` (مهاجرت `0003`). ۲) ریشهٔ ترکیب: تایمرِ واقعی، `/api/health` (با `status().deadLetters`)، تنظیمِ استخر، `deliver`ِ واقعی. ۳) سپس م۲ (هویت) و م۴ (خرید).

## پچ‌ها
`git format-patch -N d1d9cae..HEAD` (چهار پچ؛ چهارمی همین یادداشت) + bundle (تگ `pre-risk/20261119-high-risk-registry-sync`) در Gofile (`SHA256SUMS` کنار پچ‌ها). SHA-256 سه پچ نخست:
```
ec2a681c84c220e4e1f62981afd5ac7072cab54f4c17551aa68e47125bd5dd5a  0001-docs-git-ADR-0027-and-task-0025-for-the-high-risk-re.patch
1f5b8c0de0a645666c06e8637994c73a0a0bea9a7fc40e508a507c105416131e  0002-ci-git-derive-high-risk-module-coverage-from-the-reg.patch
757521e80f4b931daca3c3a499166d7bef67aa4a572a9cf171b9d09d7db9001e  0003-chore-ci-raise-MIN_PASSED_TESTS-from-2795-to-2813.patch
```
اعمال: `git clone https://github.com/madibary91-ctrl/Pdf && cd Pdf && git checkout d1d9cae && git tag -a pre-risk/20261119-high-risk-registry-sync -m "…" && git am /path/000*.patch`، یا `git pull <bundle> main`. `git am` هوک‌ها را اجرا نمی‌کند.
