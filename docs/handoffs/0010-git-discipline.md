# یادداشت تحویل ۰۰۱۰ — انضباط گیت (Git Discipline)

## چه شد
بخش «انضباط گیت» (قواعد **G1–G15**) به `AGENTS.md` اضافه شد و — چون قاعدهٔ اجرانشده فقط پیشنهاد است — بخش قابل‌اجرایش ساخته شد (ADR-0008):
- `tooling/git-discipline.ts`: توابع خالص برای هر قاعدهٔ قابل‌سنجش + لایهٔ نازک اجرا. دستورها: `install`، `doctor`، `commit-msg`، `pre-commit`، `pre-push`، `check-range`، `check-tag`.
- `tooling/git-hooks/{commit-msg,pre-commit,pre-push}`: هوک‌های `sh` که فقط به بالا ارجاع می‌دهند. نصب (یک‌بار پس از کلون): `node tooling/git-discipline.ts install` (= `git config core.hooksPath tooling/git-hooks`).

| قاعده | چگونه اجرا می‌شود |
|---|---|
| قالب پیام `type(scope): subject`، سرایند ≤ ۱۰۰، بدنهٔ «چرا» برای feat/fix/refactor/perf، بدون WIP/fixup | `commit-msg` |
| **قانون آهنین:** تغییر/حذف/جابه‌جاییِ تستِ موجود ⇒ نیازمند `Test-Change-Approved: <دلیل>` | `commit-msg` |
| **تگ پیش از تغییر پرریسک:** `Risk-Tag: pre-risk/YYYYMMDD-slug` که تگِ حاشیه‌دارِ موجود و پیشینِ HEAD باشد | `commit-msg` |
| یک کامیت، یک ماژول (`Multi-Module: <دلیل>` برای استثنا) | `commit-msg` |
| کاهش `MIN_PASSED_TESTS` ⇒ `Gate-Floor-Lowered: <دلیل>` | `commit-msg` |
| اسرار، `.env*`، `test-results/`، `.next/`، `node_modules/`، `*.tsbuildinfo`؛ `.skip/.only/xit` در تست | `pre-commit` |
| **کامیت با تست قرمز ممنوع:** `tsc` ← `eslint` ← دروازهٔ صفر-رد (کامیت فقط‌مستند معاف) | `pre-commit` |
| بدون `push --force`، بدون حذف ref، تگ فقط حاشیه‌دار با نام `pre-risk/…`/`green/…` و تغییرناپذیر، درخت کثیف، دروازهٔ کامل پیش از پوش | `pre-push` |

## راستی‌آزمایی
- ۴۱ تست تازه (`tooling/git-discipline.test.ts`): واحدِ خالص؛ **همگامی با `docs/high-risk-areas.md`** (مسیر تازه فقط در یکی ⇒ قرمز)؛ و مخزن گیتِ موقت با اجرای واقعیِ CLI و `git commit` با هوک‌ها.
- **از خودش استفاده شد:** همهٔ کامیت‌های این تحویل از همین هوک‌ها گذشتند. هوک دو بار واقعاً جلوی من را گرفت: (۱) رشته‌های نمونهٔ تستِ خودِ ابزار را `.only` پنداشت ⇒ بررسی اصلاح شد تا رشته‌ها/توضیح‌ها را حذف کند (`stripLiteralsAndComments`)؛ (۲) خطای تایپ در یک کامیت ⇒ رد شد.
- کامیت `589a766` یک تست موجودِ خودِ همین تحویل را سخت‌تر کرد (پاک‌کردن `GIT_*` از محیط فرزندها) و با `Test-Change-Approved` رفت — نمونهٔ زندهٔ استثنا.
- نقطهٔ برگشت: تگ `pre-risk/20261117-git-discipline` (کامیت `0ba6088`).

## محدودیت‌ها (صادقانه)
- **هوک محلی دورزدنی است** (`--no-verify`، کلونِ بدون `install`)؛ دروازهٔ واقعی CI و Branch protection است.
- `Risk-Tag` وجود/نوع/نسبِ تگ را می‌سنجد، نه اینکه «پیش از اولین ویرایش» زده شده.
- هوک‌ها Node ≥ ۲۲٫۱۸ می‌خواهند (مثل `ci-tests.ts`).
- من نتوانستم GitHub Actions را اجرا کنم؛ تست‌های تازه `git` و `node` را فرزند‌فرایند اجرا می‌کنند (در ubuntu-latest موجودند) ولی اجرای واقعی CI را ندیده‌ام.

## کار باز برای مالک
1. `verify` را در Branch protection **الزامی** کنید (از ۰۰۰۸/۰۰۰۹ باز است).
2. پیشنهاد: گامی در `ci.yml` که `node tooling/git-discipline.ts check-range <base>..HEAD` را روی کامیت‌های هر PR اجرا کند. `ci.yml` را عمداً دست نزدم (ورک‌فلوِ تازه‌سبز را بدون امکان اجرای واقعی نباید تغییر داد).
3. تگ‌های `pre-risk/*` را همراه کامیت‌ها پوش کنید (`git push origin --tags`؛ هوک پوش آن‌ها را می‌پذیرد).
4. **`MIN_PASSED_TESTS` (۶۰۳) بالا نرفت:** `tooling/ci-tests.test.ts` مقدار را قفل کرده و تغییر تست موجود ممنوع است. اگر بخواهید کف به ۷۳۵ برسد، آن تست باید با تأیید صریح شما عوض شود.
