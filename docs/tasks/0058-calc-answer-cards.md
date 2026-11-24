# calc-answer-cards — برش CT‑5b (کارتِ پاسخِ محاسبه)

## هدف (یک جمله)
کارتِ پاسخ را از رویدادِ بی‌واسطهٔ legal-calc بسازد و با گزارشِ اجرا ترکیب کند تا عدد و هشدارِ نمایش‌داده‌شده هرگز از متنِ مدل نباشد و پاسخِ بی‌کارت نمایش داده نشود.

## زمینه
ADR-0060؛ ادامهٔ ADR-0059 بند ۴.

## ماژول و پوشه‌های مجاز
`src/modules/calc-answer-cards/` (تازه)، `tooling/calc-answer-cards-source.test.ts` و `tooling/calc-answer-cards-e2e.test.ts` (تازه)، یک ردیف در `src/modules/registry.ts`، یک نام در `HIGH_RISK_MODULES`، یک ردیف در `docs/high-risk-areas.md`، `known-pitfalls.md`، `MIN_PASSED_TESTS`، ADR/یادداشت.

## ممنوع
هر ماژولِ دیگرِ `src/modules/*`، تغییرِ هر آزمونِ موجود، وابستگیِ خارجیِ تازه، `process.env`/شبکه/ساعت/تصادف، هر عددِ حقوقی یا قالب‌بندیِ عددی، وصل‌کردن به مسیرِ محصول.

## قرارداد
`createCardCollector({maxCards})` ⇒ `{observe, snapshot, compose}`؛ `MAX_CARDS_CEILING`، `TOOL_TITLES`، `NOTICES`، `REVIEW_PENDING_LABEL`، `COMPOSE_MESSAGES` و نوع‌های `CalcCard`/`ComposedAnswer`/… (README ماژول).

## معیار پذیرش
1. کارت = کپیِ JSONِ ژرف‌یخ‌زدهٔ رویداد؛ رویدادِ نامعتبر/`callId` تکراری/سقفِ پر ⇒ پرتابِ پیامِ ثابت؛ هیچ استثنای بومی‌ای بازتاب نمی‌شود.
2. «تأییدشده» فقط با پرچم، وضعیت، بازبین و تاریخِ موافق؛ در `compose` تأییدنشدگی فقط بالا می‌رود (کارت ∨ رکورد ∨ outcome).
3. اجرای موفقِ بی‌کارت ⇒ `CARD_MISSING` (و `TOOL_MISMATCH`/`DUPLICATE_CALL_ID`)؛ کارتِ اجرای ناموفق نمایش داده نمی‌شود و شمرده می‌شود.
4. متنِ مدل دست‌نخورده؛ `stopped` ⇒ `text:null`؛ اعلان‌ها ثابت و به ترتیب.
5. گزارشِ نامعتبر/Proxy بدجنس ⇒ `INVALID_REPORT` بی‌پرتاب.
6. سرتاسری با مجریِ واقعی در هر دو قالبِ سیم: مدلِ نقل‌کنندهٔ غلط، جدولِ تزریقیِ تأییدشده، سقفِ کارت، نتیجهٔ بزرگ‌تر از سقف، جمع‌آورندهٔ وصل‌نشده، استفادهٔ دوباره، لغو، ابزارِ بیرون از فهرست.

## تست‌های مورد انتظار
گزینه‌ها، ساختِ کارت و شکست‌بستگیِ مرزی، ترکیب، تأییدنشدگیِ یک‌طرفه، گزارشِ نامعتبر، تصادفیِ قطعی با داورِ مستقل (۶۰۰ بذر با پوششِ فضای حالت)، مرزِ کد منبع، سرتاسری.

## خارج از کار
ریشهٔ ترکیب، `metering`، `Answer.reviewPending`، تطبیقِ عددِ متنِ مدل با کارت، قراردادِ زنده، ابزارهای تازه.

## وابستگی‌ها
ADR-0059/0058.

## فایل‌های مرجع برای خواندن
`src/modules/calc-tool-executor/README.md`، `src/modules/tool-runner/types.ts`، `tooling/calc-tool-executor-e2e.test.ts`.

## بازبینی و ریسک
ناحیهٔ پرریسک (`humanReview:true`): حقوقدان + مالک امنیت. تگِ `pre-risk/20261204-calc-answer-cards`.
