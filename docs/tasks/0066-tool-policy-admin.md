# 0066 — `tool-policy-admin`: مدیریتِ نسخه‌دارِ سیاستِ دروازهٔ ابزار (CT‑5c‑2b‑1)

## هدف (یک جمله)
هر تغییرِ آستانه‌های دروازهٔ ابزار یک نسخهٔ فقط‌افزودنیِ ممیزی‌پذیر با CAS باشد که فقط از `resolveToolPolicy` می‌گذرد، روی یک پورتِ ذخیره‌ساز.

## زمینه
ADR‑0067 (2b = ذخیره/API)؛ ADR‑0069 (شکستنِ 2b به 2b‑1/2b‑2/2b‑3؛ چرا HTTP تا پیش از `identity` نه).

## ماژول و پوشه‌های مجاز
`src/modules/tool-policy-admin/` (تازه)، `src/modules/registry.ts` (یک سطر)، `tooling/git-discipline.ts` (`HIGH_RISK_MODULES`)، `docs/high-risk-areas.md`، `docs/known-pitfalls.md`، `tooling/ci-tests.ts` (فقط `MIN_PASSED_TESTS`)، `tooling/tool-policy-admin-*.test.ts`، `tooling/mutation/tool-policy-admin.py`، ADR/task/handoff.

## ممنوع
تغییر در ماژول‌های دیگر (به‌ویژه `tool-policy`)، هر آزمونِ موجود، وابستگیِ تازه، PostgreSQL/`process.env`/HTTP، ساعت/تایمر/تصادف در ماژول، قیمت/ارز/حساب/کلید، نام یا عددِ فیلدهای سیاست در کدِ ماژول.

## قرارداد
بی‌تغییر؛ فقط رابطِ عمومیِ `tool-policy` (`resolveToolPolicy`) خوانده می‌شود.

## معیار پذیرش
۱) `set`/`rollbackTo` فقط نسخهٔ بعدیِ دقیق؛ CAS و رقابتِ هم‌زمان؛ ۲) `NO_CHANGE`، پین‌کردنِ پیش‌فرض، جایگزینیِ کامل؛ ۳) بازنویسیِ نامعتبر هرگز ذخیره نمی‌شود و اصلاحِ خودکار ندارد؛ ۴) بی‌TOCTOU (getter/Proxy/`__proto__`)؛ ۵) ذخیره‌سازِ خصمانه ⇒ `STORE_FAILURE` بی‌نشتِ متن؛ ۶) `STORED_POLICY_INVALID` و `drift` و اصلاح با نسخهٔ تازه؛ ۷) آزمونِ قراردادِ پورت قابلِ‌استفادهٔ مجدد؛ ۸) سازگاری با اعتبارسنج‌های واقعیِ پایین‌دست؛ ۹) آزمونِ مدل‌محور؛ ۱۰) جهش‌آزمایی همه کشته؛ ۱۱) هیچ آزمونِ موجود تغییر نکند.

## خارج از کار
آداپتورِ PG (2b‑2)، HTTP/احراز (2b‑3)، ریشهٔ I/O (2c).

## وابستگی‌ها
ADR‑0067/0069.
