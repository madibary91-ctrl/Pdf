#!/usr/bin/env python3
"""
آزمون جهشیِ «نگهبانِ یکپارچگیِ مصنوعات» (tooling/artifact-integrity*.ts؛ برش ۰۰۷۸، ADR-0079): هر جهش یک تغییر کوچکِ معنادار در منبع است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  python3 tooling/mutation/artifact-integrity.py            (همه)
       python3 tooling/mutation/artifact-integrity.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22. به پایگاه نیاز ندارد؛ جزو CI نیست. فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TESTS = ["tooling/artifact-integrity.test.ts", "tooling/artifact-integrity.repo.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


A, S = "tooling/artifact-integrity.ts", "tooling/artifact-integrity-scan.ts"
# ── ثابت‌ها و نام‌ها
m(A, "export const MIN_SERIES_BYTES = 256;", "export const MIN_SERIES_BYTES = 255;", "حداقل اندازه یکی کمتر")
m(A, "export const MIN_SERIES_BYTES = 256;", "export const MIN_SERIES_BYTES = 257;", "حداقل اندازه یکی بیشتر")
m(A, 'export const SERIES_DIRS: readonly string[] = ["docs/tasks", "docs/handoffs", "docs/adr"];', 'export const SERIES_DIRS: readonly string[] = ["docs/tasks", "docs/handoffs"];', "سریِ ADR نگهبانی نمی‌شود")
m(A, 'Object.freeze({});', '({});', "allowlist منجمد نیست")
m(A, r"const NUMBERED = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;", r"const NUMBERED = /^(\d{4})-[a-z0-9-]+\.md$/;", "slugِ با خط‌تیرهٔ دوتایی/پایانی پذیرفته می‌شود")
m(A, r"const TEMPLATE = /^_[A-Z]+\.md$/;", r"const TEMPLATE = /^_[A-Za-z]+\.md$/;", "قالبِ کوچک‌حرف پذیرفته می‌شود")
m(A, "p.replace(/\\\\/g, \"/\")", "p", "بک‌اسلشِ ویندوز عادی‌سازی نمی‌شود")
m(A, "PERSIAN_DIGITS.charAt(Number(d))", "PERSIAN_DIGITS.charAt(0)", "همهٔ ارقام صفر می‌شوند")
# ── کدگذاری و تعارض
m(A, "text.charCodeAt(0) === 0xfeff", "text.charCodeAt(0) === 0xfffe", "BOM شناسایی نمی‌شود")
m(A, 'text.includes("\\ufffd")', 'text.includes("\\ufffe")', "U+FFFD شناسایی نمی‌شود")
m(A, 'text.includes("\\u0000")', 'text.includes("\\u0001")', "NUL شناسایی نمی‌شود")
m(A, r"/^(?:<{7}|>{7})(?: |$)/.test(l)", r"/^(?:<{7})(?: |$)/.test(l)", "نشانگرِ «>>>>>>>» شناسایی نمی‌شود")
m(A, r"/^(?:<{7}|>{7})(?: |$)/.test(l)", r"/^(?:>{7})(?: |$)/.test(l)", "نشانگرِ «<<<<<<<» شناسایی نمی‌شود")
m(A, r"/^(?:<{7}|>{7})(?: |$)/.test(l)", r"/^(?:<{7}|>{7})/.test(l)", "هشت‌تایی/چسبیده نشانگر حساب می‌شود")
m(A, r"/^(?:<{7}|>{7})(?: |$)/.test(l)", r"/^(?:<{7}|>{7})(?: )/.test(l)", "نشانگرِ تنها در خط شناسایی نمی‌شود")
m(A, 'l.replace(/\\r$/, "")', "l", "CRLF در تعارض نادیده می‌ماند")
m(A, "if (!inFence && isMarker(line)) found = true;", "if (isMarker(line)) found = true;", "نشانگرِ داخلِ حصارِ کد هم نقض است")
m(A, "return inFence && lines.some((l) => isMarker(l));", "return false;", "حصارِ نبسته بقیهٔ فایل را پنهان می‌کند")
m(A, 'if (line.trimStart().startsWith("```"))', 'if (line.startsWith("```"))', "حصارِ تورفته دیده نمی‌شود")
m(A, "    if (line.trimStart().startsWith(\"```\")) {\n      inFence = !inFence;\n      continue;\n    }\n    if (!inFence && isMarker", "    if (line.trimStart().startsWith(\"```\")) {\n      inFence = !inFence;\n    }\n    if (!inFence && isMarker", "خطِ حصار خودش بررسی می‌شود (بی‌اثر؟)")
# ── خالی و اندازه
m(A, "if (file.text.trim().length === 0) {", "if (file.text.length === 0) {", "فقط‌فاصله خالی حساب نمی‌شود")
m(A, 'byteLength(file.text) === 0 ? "فایل ۰ بایت است."', 'true ? "فایل ۰ بایت است."', "جزئیاتِ فقط‌فاصله هم «۰ بایت» می‌شود")
m(A, "      continue;\n    }\n    const enc = encodingProblem(file.text);", "    }\n    const enc = encodingProblem(file.text);", "فایلِ خالی بررسی‌های دیگر را هم می‌گیرد")
m(A, "if (byteLength(file.text) < MIN_SERIES_BYTES)", "if (byteLength(file.text) <= MIN_SERIES_BYTES)", "مرزِ اندازه: برابر رد می‌شود")
m(A, "if (byteLength(file.text) < MIN_SERIES_BYTES)", "if (file.text.length < MIN_SERIES_BYTES)", "اندازه بر پایهٔ نویسه، نه بایت")
m(A, "if (byteLength(file.text) < MIN_SERIES_BYTES)", "if (false)", "کوتاه‌شدگی نادیده است")
# ── سرتیتر، خط پایانی، نام
m(A, r"if (!/^# \S/.test(first))", r"if (!/^#/.test(first))", "هر «#…» سرتیتر است")
m(A, r"if (!/^# \S/.test(first))", r"if (!/^# /.test(first))", "«# » بی‌عنوان سرتیتر است")
m(A, 'if (!file.text.endsWith("\\n"))', "if (false)", "خطِ پایانی نادیده است")
m(A, "(m === null || Number(m[1]) === 0)", "m === null", "شمارهٔ ۰۰۰۰ مجاز است")
m(A, "if (!TEMPLATE.test(name) && ", "if (", "قالب مجاز نیست")
# ── همخوانی شماره
m(A, 'if (dir === "docs/handoffs" && !first.includes(toPersianDigits(n4)))', "if (false)", "همخوانیِ شمارهٔ یادداشتِ تحویل سنجیده نمی‌شود")
m(A, "!first.includes(toPersianDigits(n4))", "!first.includes(n4)", "رقمِ لاتین به‌جای فارسی")
m(A, 'if (dir === "docs/adr" && !new RegExp', "if (false && !new RegExp", "همخوانیِ شمارهٔ ADR سنجیده نمی‌شود")
m(A, r"${n4}(?!\\d)", r"${n4}", "ADR-00011 با 0001 همخوان است")
m(A, r"ADR[-\\u2011]", r"ADR[-]", "خط‌تیرهٔ ناشکن پذیرفته نمی‌شود")
# ── سری: شماره‌ها
m(A, "Number(m[1]) > 0) {\n      const byNum", "Number(m[1]) >= 0) {\n      const byNum", "شمارهٔ ۰ در شمارش می‌آید")
m(A, "Number(m[1]) > 0) {\n      const byNum", "Number(m[1]) > 0 && file.text.trim().length > 0) {\n      const byNum", "فایلِ خالی شمارهٔ خود را اشغال نمی‌کند")
m(A, "if (paths.length > 1)", "if (paths.length > 2)", "تکرارِ دوتایی دیده نمی‌شود")
m(A, "if (paths.length > 1)", "if (paths.length >= 1)", "هر شماره تکراری است")
m(A, "for (let i = 1; i <= max; i++)", "for (let i = 2; i <= max; i++)", "نبودنِ ۰۰۰۱ دیده نمی‌شود")
m(A, "for (let i = 1; i <= max; i++)", "for (let i = 1; i < max; i++)", "حذفِ آخرین شماره (اشتباه) — شکافِ پایانی")
m(A, "if (missing.length > 0)", "if (missing.length >= 0)", "شکافِ خالی گزارش می‌شود")
m(A, "[...paths].sort().join", "paths.join", "مسیرهای تکراری نامرتب")
m(A, "return out.sort(byPathThenCode);\n}\n\n/** فایل‌های ۰", "return out;\n}\n\n/** فایل‌های ۰", "خروجیِ checkDocFiles مرتب نیست")
m(A, "a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code", "a.path < b.path ? 1 : a.path > b.path ? -1 : a.code < b.code", "ترتیبِ مسیر برعکس")
m(A, "a.code < b.code ? -1 : a.code > b.code ? 1 : 0", "0", "ترتیبِ کد نادیده")
m(A, "if (p.startsWith(`${dir}/`)) {", "if (p.startsWith(dir)) {", "docs/taskset هم سری است")
m(A, 'if (!name.includes("/")) return { dir, name };', "return { dir, name };", "زیرپوشه هم سری است")
# ── findEmptyFiles / allowlist
m(A, "if (f.bytes === 0 && !Object", "if (f.bytes === 1 && !Object", "فایلِ ۰ بایتی رد نمی‌شود")
m(A, "!Object.prototype.hasOwnProperty.call(allow, p)", "!(p in allow)", "کلیدهای prototype معاف می‌شوند")
m(A, "f.bytes === 0 && !Object.prototype.hasOwnProperty.call(allow, p)", "f.bytes === 0", "allowlist نادیده است")
m(A, "typeof why !== \"string\" || why.trim().length === 0", "typeof why !== \"string\" || why.length === 0", "دلیلِ فقط‌فاصله پذیرفته می‌شود")
# ── پویشگر
m(S, "if (!SKIP_DIRS.has(e.name)) walk(root, childRel, out);", "walk(root, childRel, out);", "پوشه‌های node_modules/.git هم پویش می‌شوند")
m(S, "} else if (e.isFile()) {", "} else {", "پیوندِ نمادین/غیرفایل هم فایل است")
m(S, 'new Set(["node_modules", ".git", ".next", "dist", "test-results", "coverage"])', 'new Set(["node_modules", ".git", "dist", "test-results", "coverage"])', ".next نادیده نیست")
m(S, "|py|md|json|", "|py|json|", "پسوندِ md بررسی نمی‌شود")
m(S, "|py|md|json|sql|yml|yaml|", "|py|md|json|sql|", "پسوندِ yml/yaml بررسی نمی‌شود")
m(S, "!p.includes(\"/\") ||", "false ||", "فایل‌های ریشه بررسی نمی‌شوند")
m(S, r"/^(?:src|tooling|docs|public|\.github)\//.test(p))", r"/^(?:src|tooling|docs|\.github)\//.test(p))", "public پویش نمی‌شود")
m(S, r"/^(?:src|tooling|docs|public|\.github)\//.test(p))", r"/^(?:src|tooling|docs|public)\//.test(p))", ".github پویش نمی‌شود")
m(S, '|| p === "AGENTS.md"', "", "AGENTS.md خوانده نمی‌شود")
m(S, r"/^src\/modules\/[^/]+\/README\.md$/.test(p)", r"/^src\/modules\/.+\/README\.md$/.test(p)", "README عمیق‌تر هم خوانده می‌شود")
m(S, '(p.startsWith("docs/") && p.endsWith(".md"))', '(p.startsWith("docs/") || p.endsWith(".md"))', "هر md خوانده می‌شود")
m(S, "  } catch {\n    return; // پوشهٔ ناموجود", "  } catch (err) {\n    throw err; // پوشهٔ ناموجود", "پوشهٔ ناموجود می‌پرتابد")

EQUIVALENT = {
    19: "خطِ حصار («```») نشانگرِ تعارض نیست؛ بدونِ continue هم همان نتیجه (فقط یک بررسیِ اضافه)",
    41: "آخرین شمارهٔ سری (max) همیشه در byNum هست؛ پس تکرارِ تا max یا max-1 یک گزارشِ یکسان می‌دهد",
}
env = dict(os.environ)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
origs = {}
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
    p = os.path.join(ROOT, f)
    origs.setdefault(f, open(p, encoding="utf8").read())
    if origs[f].count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد در {f}: {old[:80]!r}"); sys.exit(2)
    if new == old:
        print(f"[{i}] جهش بی‌اثر است: {why}"); sys.exit(2)
if not tests_pass():
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, f)
    open(path, "w", encoding="utf8").write(origs[f].replace(old, new, 1))
    try:
        ok = tests_pass()
    finally:
        open(path, "w", encoding="utf8").write(origs[f])
    if ok and i not in EQUIVALENT:
        alive.append((i, why)); print(f"[{i:02d}] ✗ زنده: {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
