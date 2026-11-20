#!/usr/bin/env python3
"""
آزمون جهشی «رفعِ ناپایداریِ دروازه: انتظارِ قفلِ کانونی» (ADR-0040) روی `tooling/lock-wait.ts`: هر جهش یک تغییر کوچکِ معنادار است و باید
دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/lock-wait.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/lock-wait.py 3 9                     (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL (برای آزمونِ lock-wait.pg.test.ts)؛ جزو CI نیست. پیش از هر اجرا پیش‌بازرسی می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛
فایل پس از هر جهش همیشه برمی‌گردد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = "tooling/lock-wait.ts"
TESTS = ["tooling/lock-wait.test.ts", "tooling/lock-wait.pg.test.ts"]
M = []


def m(old, new, why):
    M.append((SRC, old, new, why))


# --- منطقِ اصلی ---
m("if (seen.includes(true)) return seen;", "if (seen.length > 0) return seen;", "بازگشت به روشِ قدیم: تا اولین انتظارِ هر کلیدی (باگِ اصلی)")
m("if (seen.includes(true)) return seen;", "if (seen.includes(false)) return seen;", "کانونی با غیرِ کانونی عوض می‌شود")
m("if (seen.includes(true)) return seen;", "if (seen.every((x) => x)) return seen;", "فقط وقتی همه true‌اند (مشاهدهٔ مختلط گم می‌شود)")
m("if (seen.includes(true)) return seen;", "if (seen.includes(true)) return [true];", "مشاهده بازنویسی می‌شود (ادعای «دقیقاً» پنهان می‌شود)")
m("    if (seen.length > 0) {\n      lastNonEmpty = seen;", "    if (seen.length >= 0) {\n      lastNonEmpty = seen;", "مشاهدهٔ تهی هم «دیده‌شده» حساب می‌شود")
m("      lastNonEmpty = seen;\n", "", "آخرین مشاهدهٔ غیرِ تهی ثبت نمی‌شود (شکستِ بسته گم می‌شود)")
m("      if (firstSeenAt < 0) firstSeenAt = poll;", "      firstSeenAt = poll;", "بودجهٔ گذرا با هر دیدن از نو شروع می‌شود")
m("      if (firstSeenAt < 0) firstSeenAt = poll;", "      if (firstSeenAt < 0) firstSeenAt = 0;", "نخستین دیدن همیشه پرسشِ صفر فرض می‌شود")
m("const budget = firstSeenAt < 0 ? idlePolls : firstSeenAt + transientPolls;", "const budget = firstSeenAt < 0 ? idlePolls : transientPolls;", "بودجهٔ گذرا از ابتدای کار شمرده می‌شود نه از نخستین دیدن")
m("const budget = firstSeenAt < 0 ? idlePolls : firstSeenAt + transientPolls;", "const budget = firstSeenAt <= 0 ? idlePolls : firstSeenAt + transientPolls;", "دیدنِ در پرسشِ نخست بودجهٔ گذرا نمی‌گیرد")
m("const budget = firstSeenAt < 0 ? idlePolls : firstSeenAt + transientPolls;", "const budget = idlePolls;", "بودجهٔ گذرا هرگز تمدید نمی‌شود (باگِ قدیم با فرجهٔ کوتاه)")
m("const budget = firstSeenAt < 0 ? idlePolls : firstSeenAt + transientPolls;", "const budget = transientPolls;", "بودجهٔ بیکاری هم گذرا می‌شود")
m("if (poll + 1 >= budget) return lastNonEmpty;", "if (poll + 1 > budget) return lastNonEmpty;", "یک پرسشِ اضافه (off-by-one)")
m("if (poll + 1 >= budget) return lastNonEmpty;", "if (poll >= budget) return lastNonEmpty;", "یک پرسشِ اضافه (off-by-one، شکلِ دوم)")
m("if (poll + 1 >= budget) return lastNonEmpty;", "if (poll + 2 >= budget) return lastNonEmpty;", "یک پرسشِ کمتر")
m("if (poll + 1 >= budget) return lastNonEmpty;", "if (poll + 1 >= budget) return null;", "پایانِ بودجه همیشه null (شکستِ بسته گم می‌شود)")
m("    await sleep(pollMs);\n", "", "خواب میانِ پرسش‌ها حذف می‌شود (حلقهٔ داغ)")
m("    await sleep(pollMs);\n", "    await sleep(0);\n", "pollMs نادیده گرفته می‌شود")
m("  let firstSeenAt = -1;", "  let firstSeenAt = 0;", "پیش‌فرضِ «دیده شده» از آغاز")
m("  let lastNonEmpty: readonly boolean[] | null = null;", "  let lastNonEmpty: readonly boolean[] | null = [];", "پیش‌فرضِ آخرین مشاهده تهی (null از بین می‌رود)")
# --- اعتبارسنجیِ پیکربندی ---
m('typeof n === "number" && Number.isSafeInteger(n) && n >= 1', 'typeof n === "number" && Number.isSafeInteger(n) && n >= 0', "صفر پذیرفته می‌شود")
m('typeof n === "number" && Number.isSafeInteger(n) && n >= 1', 'typeof n === "number" && Number.isFinite(n) && n >= 1', "اعشاری پذیرفته می‌شود")
m('typeof n === "number" && Number.isSafeInteger(n) && n >= 1', 'typeof n === "number" && Number.isSafeInteger(n)', "منفی پذیرفته می‌شود")
m("if (!isPositiveInt(o.idlePolls)) throw", "if (false) throw", "idlePolls اعتبارسنجی نمی‌شود")
m("if (!isPositiveInt(o.transientPolls)) throw", "if (false) throw", "transientPolls اعتبارسنجی نمی‌شود")
m("if (o.transientPolls < o.idlePolls) throw", "if (o.transientPolls <= o.idlePolls) throw", "برابری ردّ می‌شود")
m("if (o.transientPolls < o.idlePolls) throw", "if (false) throw", "ترتیبِ بودجه‌ها اعتبارسنجی نمی‌شود")
m("typeof o.pollMs !== \"number\" || !Number.isFinite(o.pollMs) || o.pollMs < 0", "typeof o.pollMs !== \"number\" || !Number.isFinite(o.pollMs) || o.pollMs <= 0", "pollMs صفر ردّ می‌شود")
m("typeof o.pollMs !== \"number\" || !Number.isFinite(o.pollMs) || o.pollMs < 0", "typeof o.pollMs !== \"number\" || o.pollMs < 0", "pollMs نامتناهی/NaN پذیرفته می‌شود")
m("typeof o.pollMs !== \"number\" || !Number.isFinite(o.pollMs) || o.pollMs < 0", "typeof o.pollMs !== \"number\" || !Number.isFinite(o.pollMs)", "pollMs منفی پذیرفته می‌شود")
m("  assertOptions(options);\n", "", "اعتبارسنجی اصلاً صدا زده نمی‌شود")

env = dict(os.environ)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return r.returncode == 0


# هم‌ارزهای توضیح‌داده‌شده (شمارهٔ جهش ← دلیلِ رفتاری)
EQUIVALENT: dict = {}
lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
origs = {}
for i, (f, old, new, why) in enumerate(M):
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
