#!/usr/bin/env python3
"""
آزمون جهشی «مدیریتِ نسخه‌دارِ سیاستِ دروازهٔ ابزار» (ماژول tool-policy-admin؛ برش CT-5c-2b-1، ADR-0069): هر جهش یک تغییر کوچکِ معنادار در
منبعِ ماژول است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است (یا کدِ زائد).
اجرا:  python3 tooling/mutation/tool-policy-admin.py            (همه)
       python3 tooling/mutation/tool-policy-admin.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22. آزمون‌ها به پایگاه نیاز ندارند؛ جزو CI نیست. پیش از اجرا «پیش‌بازرسی» می‌کند که متنِ اصلیِ هر جهش دقیقاً یک‌بار در فایل هست؛
فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/tool-policy-admin/"
TESTS = [B, "tooling/tool-policy-admin-source.test.ts", "tooling/tool-policy-admin-downstream.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


AD, CA, VA, MS = "admin.ts", "canonical.ts", "validate.ts", "memory-store.ts"
# ── admin.ts
m(AD, 'if (current !== p.expectedVersion) return fail("VERSION_CONFLICT", [], current);', "", "set بدون بررسی expectedVersion (به‌روزرسانیِ گمشده)")
m(AD, 'if (same) return fail("NO_CHANGE", [], current);', "", "نسخهٔ تکراریِ بی‌تغییر ساخته می‌شود")
m(AD, ": stable(latest.value.overrides) === stable(overrides);", ": false;", "NO_CHANGE برای نسخه‌های بعدی هرگز نمی‌آید")
m(AD, "latest.value === null ? Object.keys(overrides).length === 0 :", "latest.value === null ? false :", "{} در نسخهٔ ۰ نسخهٔ بی‌اثر می‌سازد")
m(AD, 'if (appended.error.code !== "CONFLICT") return fail("STORE_FAILURE", [], current);', "", "خطای INVALID/UNAVAILABLE ذخیره‌ساز «تعارض» گزارش می‌شود")
m(AD, 'if (nowMs === null) return fail("INVALID_CLOCK");', "", "ساعتِ نامعتبر پذیرفته می‌شود")
m(AD, "drift: stable(resolved.value) !== stable(rec.policy)", "drift: false", "رانشِ پیش‌فرض‌های کد دیده نمی‌شود")
m(AD, "else if (common !== null && toVersion > common.expectedVersion) issues.push(", "else if (false) issues.push(", "rollback به نسخهٔ آینده")
m(AD, 'if (current !== common.expectedVersion) return fail("VERSION_CONFLICT", [], current);', "", "rollback بدون بررسی expectedVersion")
m(AD, 'if (got.value === null) return fail("VERSION_NOT_FOUND", [], current);', "", "نسخهٔ نبوده به‌صورت خرابی گزارش می‌شود")
m(AD, "target.version !== toVersion", "false", "ذخیره‌ساز نسخهٔ دیگری بدهد پذیرفته می‌شود")
m(AD, "last.version > 1 ?", "true ?", "nextBefore برای نسخهٔ ۱ هم می‌آید (صفحهٔ خالیِ اضافه)")
m(AD, "entries.length === lim &&", "", "nextBefore در صفحهٔ ناقص هم می‌آید")
m(AD, "rec.version >= prev", "rec.version > prev", "نسخهٔ تکراری در تاریخچه پذیرفته می‌شود")
m(AD, "r.value.length > lim", "false", "ذخیره‌ساز بیش از limit بدهد پذیرفته می‌شود")
m(AD, "limit > ADMIN_LIMITS.maxHistoryLimit", "false", "limit بدون سقف")
m(AD, '(e as { code?: unknown }).code === "CONFLICT" ? conflict : unavailable', '(e as { code?: unknown }).code === "CONFLICT" ? unavailable : conflict', "CONFLICT و خطای دیگر جابه‌جا می‌شوند")
m(AD, "if (flag === true) return", "if (flag) return", "ok غیرِ بولی پذیرفته می‌شود")
m(AD, "version: current + 1,", "version: current + 2,", "شکافِ نسخه")
m(AD, "diffPolicies(prevPolicy.ok ? prevPolicy.value : null, resolved.value)", "diffPolicies(null, resolved.value)", "changes نسبت به هیچ، نه نسخهٔ پیشین")
m(AD, "latest.value === null ? resolveToolPolicy(undefined) : { ok: true as const, value: latest.value.policy }", "resolveToolPolicy(undefined)", "changes همیشه نسبت به پیش‌فرض‌های کد")
m(AD, 'typeof clock.nowMs === "function"', "true", "ساعتِ بدون nowMs پذیرفته می‌شود")
m(AD, 'if (before !== null && !isSafeInt(before, 1)) issues.push(', "if (false) issues.push(", "beforeVersion نامعتبر")
m(AD, "readFields(input === undefined ? {} : input,", "readFields(input,", "history بدون ورودی خطا می‌دهد")
m(AD, "if (!resolved.ok) return fail(\"INVALID_OVERRIDES\", resolved.error.issues);\n  const overrides", "const overrides", "بازنویسیِ نامعتبر ذخیره می‌شود")
m(AD, 'if (!isSafeInt(expectedVersion, 0)) issues.push(', "if (false) issues.push(", "expectedVersion نامعتبر پذیرفته می‌شود")
m(AD, 'return rec === null ? fail("STORE_FAILURE", ["آخرین نسخهٔ ذخیره‌شده خراب است."]) : ok(rec);', "return ok(rec as never);", "رکوردِ خرابِ آخر پذیرفته می‌شود")
# ── canonical.ts
m(CA, "for (const k of Object.keys(sec)) o[k] = leaf(sec[k]);", "for (const k of Object.keys(sec)) o[k] = sec[k];", "برگِ شیء/تابع عبور می‌کند (TOCTOU)")
m(CA, "const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;\n    for (const s of Object.keys(raw))", "const out: Record<string, unknown> = {};\n    for (const s of Object.keys(raw))", "عکسِ ریشه پروتوتایپ دارد (__proto__)")
m(CA, "if (keys.length === 0) continue;", "", "بخشِ خالی در شکلِ کانونی می‌ماند")
m(CA, "for (const s of Object.keys(snapshot).sort())", "for (const s of Object.keys(snapshot))", "ترتیبِ بخش‌ها کانونی نیست")
m(CA, "const keys = Object.keys(sec).sort();", "const keys = Object.keys(sec);", "ترتیبِ کلیدها کانونی نیست")
m(CA, "if (from !== to) out.push", "if (true) out.push", "changes شاملِ مقدارهای بی‌تغییر")
m(CA, "const paths = [...new Set([...a.keys(), ...b.keys()])].sort();", "const paths = [...new Set([...a.keys(), ...b.keys()])];", "changes مرتب نیست")
m(CA, "return p === Object.prototype || p === null;", "return p === Object.prototype;", "شیءِ بی‌پروتوتایپ ساده شمرده نمی‌شود")
m(CA, "      .sort()\n      .map((k) => `${JSON.stringify(k)}", "      .map((k) => `${JSON.stringify(k)}", "stable به ترتیبِ کلید وابسته است")
m(CA, "const to = b.has(path) ? (b.get(path) as Leaf) : null;", "const to = b.has(path) ? (b.get(path) as Leaf) : (a.get(path) as Leaf);", "حذفِ مسیر دیده نمی‌شود")
# ── validate.ts
m(VA, "return v.length <= MAX_STRING ? v : BAD;", "return v;", "رشتهٔ بی‌سقف در رکورد")
m(VA, "if (--budget.n < 0) return BAD;", "", "رکوردِ بی‌سقفِ گره")
m(VA, 'if (k === "__proto__") return BAD;\n', "", "کلیدِ __proto__ در رکورد پروتوتایپ را عوض می‌کند")
m(VA, "Object.keys(o).length === keys.length &&", "", "کلیدِ اضافه در رکورد پذیرفته می‌شود")
m(VA, "normalizeReason(reason) !== reason", "false", "دلیلِ ناکانونی (با فاصله) از ذخیره‌ساز پذیرفته می‌شود")
m(VA, "return isSafeInt(t, 1) && t <= version ?", "return isSafeInt(t, 1) ?", "rollback به نسخهٔ آینده در رکورد")
m(VA, "changes.length > ADMIN_LIMITS.maxChanges", "false", "changesِ بی‌سقف")
m(VA, "path.length < 1 || path.length > ADMIN_LIMITS.maxPathChars", "path.length < 1", "مسیرِ بی‌سقف")
m(VA, "\\u202a-\\u202e\\u2066-\\u2069", "\\u202a-\\u202e", "isolateهای جهت مجازند")
m(VA, "\\u2028\\u2029", "", "جداکنندهٔ خط/بند مجاز است")
m(VA, "{0,127}$/", "{0,128}$/", "actor ۱۲۹ نویسه مجاز")
m(VA, "/^[A-Za-z0-9][A-Za-z0-9._:@-]", "/^[A-Za-z0-9._:@-][A-Za-z0-9._:@-]", "actor با نماد شروع می‌شود")
m(VA, "if (t.length < 1 || t.length > ADMIN_LIMITS.maxReasonChars ||", "if (t.length > ADMIN_LIMITS.maxReasonChars ||", "دلیلِ تهی مجاز")
m(VA, "maxReasonChars: 500", "maxReasonChars: 501", "سقفِ دلیل یکی بیش‌تر")
m(VA, "Object.values(s).every(isLeaf)", "true", "برگِ نامعتبر در رکورد")
m(VA, "if (!isPlain(raw)) {\n      issues.push(\"ورودی باید یک شیء ساده باشد.\");", "if (false) {\n      issues.push(\"ورودی باید یک شیء ساده باشد.\");", "ورودیِ غیرِ شیء پذیرفته می‌شود")
m(VA, 'if (!allowed.includes(k)) issues.push', "if (false) issues.push", "کلیدِ ناشناختهٔ ورودی نادیده گرفته می‌شود")
# ── memory-store.ts
m(MS, 'if (parsed.version !== records.length + 1) return fail("CONFLICT");', "", "ذخیره‌ساز شکاف/تکرار می‌پذیرد")
m(MS, "Math.min(beforeVersion - 2, records.length - 1)", "Math.min(beforeVersion - 1, records.length - 1)", "beforeVersion انحصاری نیست")
m(MS, "if (!isSafeInt(limit, 1) ||", "if (", "limit نامعتبر")
m(MS, "if (parsed === null) return fail(\"INVALID\");", "", "رکوردِ بدشکل پذیرفته می‌شود")

M = [x for x in M if x is not None]


def run_tests():
    p = subprocess.run(["npx", "vitest", "run", *TESTS], cwd=ROOT, capture_output=True, text=True)
    return p.returncode


def main():
    lo, hi = 1, len(M)
    if len(sys.argv) >= 3:
        lo, hi = int(sys.argv[1]), int(sys.argv[2])
    for i, (f, old, new, why) in enumerate(M, 1):
        path = os.path.join(ROOT, B + f)
        n = open(path, encoding="utf-8").read().count(old)
        if n != 1:
            print(f"پیش‌بازرسی ناموفق: جهش {i} ({why}) — متنِ اصلی {n} بار یافت شد")
            sys.exit(2)
    if run_tests() != 0:
        print("آزمون‌ها بدونِ جهش قرمزند؛ ابتدا درست کنید.")
        sys.exit(2)
    live = []
    for i, (f, old, new, why) in enumerate(M, 1):
        if not (lo <= i <= hi):
            continue
        path = os.path.join(ROOT, B + f)
        src = open(path, encoding="utf-8").read()
        try:
            open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
            killed = run_tests() != 0
        finally:
            open(path, "w", encoding="utf-8").write(src)
        print(f"{'کشته  ' if killed else 'زنده! '} {i:3d}  {f:16s} {why}", flush=True)
        if not killed:
            live.append((i, f, why))
    print(f"\nجهش‌ها: {hi - lo + 1}  زنده: {len(live)}")
    for i, f, why in live:
        print(f"  زنده: {i} {f} — {why}")
    sys.exit(1 if live else 0)


if __name__ == "__main__":
    main()
