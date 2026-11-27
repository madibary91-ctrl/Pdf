# artifact-integrity — نگهبانِ فایلِ خالی/خراب و سری‌های شماره‌دارِ docs

## هدف (یک جمله)
جلوگیری از کامیتِ بی‌صدای فایلِ مستند/کدِ ۰ بایتی یا خراب و از شکاف/تکرار در شماره‌گذاریِ task/handoff/ADR، با یک آزمونِ زنده در دروازهٔ CI.

## زمینه
دو فایلِ task (0074 در `1b123ec`، 0015 در `a697691`) ۰ بایتی کامیت شدند و هیچ آزمونی نفهمید. ADR-0079 (این برش). به `docs-path-refs` (ADR-0038) تکمیلی است، نه جایگزین.

## ماژول و پوشه‌های مجاز
`tooling/artifact-integrity.ts`، `tooling/artifact-integrity-scan.ts`، دو فایلِ آزمونِ `tooling/artifact-integrity*.test.ts`، `tooling/mutation/artifact-integrity.py`، `docs/`، `AGENTS.md`، و (کامیتِ جدا، `Risk-Tag`) فقط `MIN_PASSED_TESTS` در `tooling/ci-tests.ts`.

## ممنوع
`src/**`، `registry.ts`، `shared-types`، **هر تستِ موجود** (فقط افزودن)، وابستگیِ تازه، هر تغییر برای سه محدودیتِ محیطیِ ویندوز، ویرایشِ هر فایلِ ADR/handoff/task موجود (جز بازگرداندنِ فایلِ خالیِ 0015).

## قرارداد
`checkDocFiles(files) → Violation[]`، `findEmptyFiles(sized, allow?) → Violation[]`، `checkAllowlist`، `hasConflictMarker`، `seriesOf`، `toPersianDigits`، ثابت‌های `SERIES_DIRS`/`MIN_SERIES_BYTES`/`EMPTY_FILE_ALLOWLIST`؛ پویشگر: `collectDocFiles`، `collectSizedFiles`، `listFiles`. کدهای نقضِ بسته: `EMPTY TOO_SHORT BAD_ENCODING CONFLICT_MARKER NO_H1 NO_FINAL_NEWLINE BAD_NAME DUPLICATE_NUMBER NUMBER_GAP HEADING_NUMBER_MISMATCH ALLOWLIST_NO_REASON`.

## معیار پذیرش
1. هیچ مستندِ خالی/فقط‌فاصله (۰ بایت یا فاصله) در مخزن نیست؛ task 0015 از `015acdd` برگردانده شده.
2. نویسهٔ خراب و نشانگرِ تعارض گرفته می‌شود؛ نشانگرِ داخلِ حصارِ بسته نه؛ حصارِ نبسته شکست‌بسته است.
3. سه سریِ شماره‌دار: نام، شمارهٔ یکتا و بی‌شکاف، سرتیتر، حداقلِ ۲۵۶ بایت، خطِ پایانی، همخوانیِ شمارهٔ سرتیتر.
4. فایلِ ۰ بایتیِ کد/آزمون/پیکربندی خطاست؛ allowlist عمداً خالی و مدخل‌ها بادلیل.
5. خروجی قطعی، مرتب و مستقل از ترتیبِ ورودی؛ ورودی تغییر نمی‌کند.
6. منطق بی‌I/O (آزمونِ نگهبانِ منبع)؛ پویشگر پیوندِ نمادین را دنبال نمی‌کند و پوشه‌های تولیدی را نمی‌خواند.
7. آزمونِ زنده روی مخزن با کفِ «پویشِ تهی سبز نمی‌شود».

## تست‌های مورد انتظار
عادی (مجموعهٔ سالم، CRLF/ویندوز)، مرزی (۲۵۵/۲۵۶ بایت، ۸ علامتِ `<`، حصارِ تورفته/نبسته)، خطا (هر کدِ نقض)، مدل‌محور (۲۰۰ بذر)، پویشگر روی درختِ موقت، زنده روی مخزن، و جهشی (۶۵ جهش).

## خارج از کار
سنجشِ معنا/کیفیتِ محتوا، بررسیِ باینری‌ها، اصلاحِ خودکار، هوکِ pre-commit/CI تازه (آزمون جزو `vitest` است و دروازهٔ موجود آن را می‌دود)، ثبتِ ماژول در registry.

## وابستگی‌ها
`docs-path-refs` (ADR-0038) و دروازهٔ صفر-رد (ADR-0006).

## فایل‌های مرجع برای خواندن
`docs/adr/0079-artifact-integrity-guard.md`، `tooling/docs-path-refs.test.ts` (سبکِ پویشگرِ خالص)، `tooling/mutation/tool-policy-binding.py`.

## بازبینی و ریسک
ناحیهٔ پرریسک نیست (آزمون/ابزار). تنها خطر: مثبتِ کاذب که دروازه را بی‌دلیل قرمز کند؛ برای همین هر قاعده با اندازه‌گیریِ روی HEAD سنجیده شد (فقط 0015 نقض بود).

## تعریف «تمام شد»
تست‌ها و CI سبز، جهشِ بی‌بازمانده، مستند (ADR-0079، known-pitfalls، AGENTS.md)، یادداشتِ تحویل ۰۰۷۸، پچ روی کلونِ تازه اثبات‌شده.
