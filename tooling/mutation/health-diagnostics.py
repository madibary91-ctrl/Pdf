#!/usr/bin/env python3
"""
آزمون جهشی «تشخیصِ سلامت و حاشیهٔ دودیِ زمانِ واقعی» (ADR-0041) روی `healthDiagnostics` و `SMOKE_GRACE_MS` در
`src/modules/settlement-runtime/test-kit.ts`: هر جهش یک تغییر کوچکِ معنادار است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/health-diagnostics.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/health-diagnostics.py 3 9                     (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL (آزمون‌های توقفِ حلقهٔ رویداد در runtime.pg.test.ts)؛ جزو CI نیست. پیش از هر اجرا پیش‌بازرسی می‌کند که متن اصلیِ
همهٔ جهش‌ها در فایل هست؛ فایل پس از هر جهش همیشه برمی‌گردد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = "src/modules/settlement-runtime/test-kit.ts"
TESTS = ["src/modules/settlement-runtime/health-diagnostics.test.ts", "src/modules/settlement-runtime/runtime.pg.test.ts"]
M = []


def m(old, new, why):
    M.append((SRC, old, new, why))


# --- کران و نشانهٔ «…» ---
m(".slice(0, 8)", ".slice(0, 9)", "نُه دلیل به‌جای هشت")
m(".slice(0, 8)", ".slice(0, 7)", "هفت دلیل به‌جای هشت")
m("rawReasons.length > 8 ?", "rawReasons.length >= 8 ?", "نشانهٔ … برای دقیقاً هشت دلیل")
m("rawReasons.length > 8 ?", "rawReasons.length > 9 ?", "نشانهٔ … برای نُه دلیل گم می‌شود")
m('${rawReasons.length > 8 ? ",…" : ""}', '${""}', "نشانهٔ … هرگز نمی‌آید")
# --- فهرستِ سفید و الگوهای بسته (بی‌نشت) ---
m("const SAFE_UPPER = /^[A-Z][A-Z0-9_]{0,39}$/;", "const SAFE_UPPER = /^[A-Za-z][A-Za-z0-9_ :-]*$/;", "کدِ شمارشی متنِ آزاد را می‌پذیرد (نشت)")
m("const SAFE_LOWER = /^[a-z]{1,20}$/;", "const SAFE_LOWER = /^.+$/;", "الگوی وضعیت هر رشته‌ای را می‌پذیرد (نشت)")
m("const SAFE_UPPER = /^[A-Z][A-Z0-9_]{0,39}$/;", "const SAFE_UPPER = /^[A-Z][A-Z0-9_]{0,3}$/;", "کدها بیش از حد کوتاه می‌شوند")
# --- قالبِ مقدارها ---
m('typeof v === "number" && Number.isFinite(v) ? String(v)', 'typeof v === "number" ? String(v)', "NaN/Infinity چاپ می‌شود")
m('v === true ? "true" : v === false ? "false" : "?"', 'v === true ? "false" : v === false ? "true" : "?"', "بولی وارونه")
m('v === null ? "null" : typeof v === "string" && SAFE_UPPER.test(v)', 'v === null ? "?" : typeof v === "string" && SAFE_UPPER.test(v)', "null چاپ نمی‌شود")
m('silence === null ? "null" : fmtNum(silence)', "fmtNum(silence)", "silenceMs تهی ? می‌شود")
# --- منبعِ هر فیلد ---
m("hr = asRecord(rt.health());", "hr = asRecord(rt.status());", "health از status خوانده می‌شود")
m("st = asRecord(rt.status());", "st = asRecord(rt.status());\n      void rt.status();", "status دو بار خوانده می‌شود")
m("hr = asRecord(rt.health());", "hr = asRecord(rt.health());\n      void rt.health();", "health دو بار خوانده می‌شود")
m('`http=${fmtNum(pick(hr, "httpStatus"))}`', '`http=${fmtNum(pick(h, "httpStatus"))}`', "http از جای اشتباه")
m('`busy=${fmtBool(pick(loop, "busy"))}`', '`busy=${fmtBool(pick(h, "busy"))}`', "busy از جای اشتباه")
m('`runtimeState=${fmtLower(pick(st, "state"))}`', '`runtimeState=${fmtLower(pick(loop, "state"))}`', "وضعیتِ اجرا با وضعیتِ حلقه یکی می‌شود")
m('`loopState=${fmtLower(pick(loop, "state"))}`', '`loopState=${fmtLower(pick(st, "state"))}`', "وضعیتِ حلقه با وضعیتِ اجرا یکی می‌شود")
m('${fmtUpper(pick(x, "code"))}:${fmtLower(pick(x, "severity"))}', '${fmtLower(pick(x, "code"))}:${fmtLower(pick(x, "severity"))}', "کدِ دلیل با الگوی اشتباه")
m('${fmtUpper(pick(x, "code"))}:${fmtLower(pick(x, "severity"))}', '${fmtUpper(pick(x, "code"))}:${fmtUpper(pick(x, "severity"))}', "شدتِ دلیل با الگوی اشتباه")
m('`degradedAfterMs=${fmtNum(pick(h, "degradedAfterMs"))}`', '`degradedAfterMs=${fmtNum(pick(h, "downAfterMs"))}`', "آستانهٔ degraded از downAfterMs")
m('`downAfterMs=${fmtNum(pick(h, "downAfterMs"))}`', '`downAfterMs=${fmtNum(pick(h, "degradedAfterMs"))}`', "آستانهٔ down از degradedAfterMs")
# --- ایمنی و قالبِ کلی ---
m('].join(" ");', '].join("\\n");', "خروجی چندخطی می‌شود")
m("    return o === null ? undefined : o[key];\n  } catch {\n    return undefined;\n  }", "    return o === null ? undefined : o[key];\n  } catch (e) {\n    throw e;\n  }", "خرابیِ تک‌فیلد کلِ خلاصه را می‌ریزد")
m('return "healthDiagnostics: unreadable";', 'return "";', "پیامِ خرابیِ غیرِ قابل‌مهار حذف می‌شود")
m("  } catch {\n    return \"healthDiagnostics: unreadable\";", "  } catch (e) {\n    throw e;", "خرابیِ غیرِ قابل‌مهار پرتاب می‌شود")
# --- حاشیهٔ دودیِ زمانِ واقعی ---
m("export const SMOKE_GRACE_MS = 1_200;", "export const SMOKE_GRACE_MS = 120;", "بازگشت به ۱۲۰ms (علتِ ناپایداری)")
m("export const SMOKE_GRACE_MS = 1_200;", "export const SMOKE_GRACE_MS = 800;", "حاشیه ۲۰۰ms (کمتر از کف)")
m("export const SMOKE_GRACE_MS = 1_200;", "export const SMOKE_GRACE_MS = 1_201;", "مقدارِ غیرِ مضربِ ۴")
m("export const SMOKE_GRACE_MS = 1_200;", "export const SMOKE_GRACE_MS = 3_000;", "دودی بیش از حد کند")

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
