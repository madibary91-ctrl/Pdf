#!/usr/bin/env python3
'''
آزمون جهشیِ «پیش‌بازرسی انتشار سیاست» (ماژول tool-policy-preflight؛ ADR-0078): هر جهش یک تغییر کوچکِ معنادار در منبع است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  python3 tooling/mutation/tool-policy-preflight.py            (همه)
       python3 tooling/mutation/tool-policy-preflight.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22. به پایگاه نیاز ندارد؛ جزو CI نیست. فایل‌ها پس از هر جهش همیشه برمی‌گردند.
'''
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/tool-policy-preflight/"
TESTS = [B, "tooling/tool-policy-preflight-source.test.ts", "tooling/tool-policy-preflight.integration.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


PF, GA = B + "preflight.ts", B + "guarded-admin.ts"
SET_PF = 'if (!pf.ok) return pf;\n      return guard<AppliedVersion>(() => target.set'
# ── preflight.ts
m(PF, 'if (!resolved.ok) return rejection("OVERRIDES_INVALID", resolved.error.issues);', '', 'بازنویسیِ نامعتبر رد نمی‌شود')
m(PF, 'rejection("OVERRIDES_INVALID", resolved.error.issues)', 'rejection("OVERRIDES_INVALID")', 'issues بیرون نمی‌آید')
m(PF, 'if (!projected.ok) return rejection("PROJECTION_INVALID");', '', 'شکستِ نگاشت رد نمی‌شود')
m(PF, 'version: 1, source: "stored"', 'version: 0, source: "stored"', 'نسخهٔ ۰ با منبعِ stored ناسازگار است')
m(PF, 'if (!made.ok) return rejection("CONFIG_INVALID");', '', 'شکستِ ساختِ پیوند (build غیرتابع) نادیده گرفته می‌شود')
m(PF, 'candidate = projected.value;', '', 'projection به منبعِ ساختگی نمی‌رسد')
m(PF, 'rejection(lease.error.reason === "BUILD_FAILED" ? "BUILD_FAILED" : "PROJECTION_INVALID")', 'rejection("PROJECTION_INVALID")', 'شکستِ ساخت PROJECTION_INVALID گزارش می‌شود')
m(PF, 'rejection(lease.error.reason === "BUILD_FAILED" ? "BUILD_FAILED" : "PROJECTION_INVALID")', 'rejection("BUILD_FAILED")', 'ردِ projection به‌صورت BUILD_FAILED گزارش می‌شود')
m(PF, 'projection: lease.value.projection })', 'projection })', 'projectionِ بازساخته به‌جای نگاشتِ اولیه نیست')
m(PF, 'value: Object.freeze({ policy: resolved.value', 'value: ({ policy: resolved.value', 'نتیجه یخ نیست')
m(PF, 'issues: Object.freeze([...issues])', 'issues: [...issues]', 'issues یخ نیست')
m(PF, 'error: Object.freeze({ code:', 'error: ({ code:', 'خطا یخ نیست')
m(PF, '} catch {\n    return rejection("CONFIG_INVALID");', '} catch {\n    throw 1;', 'گزینهٔ پرتاب‌کننده می‌پرتابد')
# ── guarded-admin.ts
m(GA, 'text.length > MAX_INPUT_CHARS', 'text.length > MAX_INPUT_CHARS + 1', 'سقفِ اندازه یکی شل است')
m(GA, 'text.length > MAX_INPUT_CHARS', 'false', 'سقفِ اندازه نیست')
m(GA, 'typeof text !== "string" || ', '', 'undefined سریال‌نشدنی رد نمی‌شود')
m(GA, 'return isRecord(copy) ? copy : null;', 'return copy as Record<string, unknown>;', 'ورودیِ غیرشیء رد نمی‌شود')
m(GA, 'preflightToolPolicy({ overrides: copy.overrides, build: buildFn });\n      if (!pf.ok) return pf;\n      return', 'preflightToolPolicy({ overrides: (input as Record<string, unknown>).overrides, build: buildFn });\n      if (!pf.ok) return pf;\n      return', 'set بازنویسی را از ورودیِ اصلی می‌خواند (TOCTOU)')
m(GA, 'target.set(copy)', 'target.set(input)', 'set ورودیِ اصلی را به مدیر می‌دهد (TOCTOU)')
m(GA, 'target.rollbackTo(copy)', 'target.rollbackTo(input)', 'rollbackTo ورودیِ اصلی را به مدیر می‌دهد (TOCTOU)')
m(GA, SET_PF, 'return guard<AppliedVersion>(() => target.set', 'ردِ پیش‌بازرسی در set به مدیر می‌رسد')
m(GA, 'if (!pf.ok) return pf;\n        }', '}', 'ردِ پیش‌بازرسی در rollbackTo به مدیر می‌رسد')
m(GA, 'to >= 1)', 'to >= 0)', 'toVersion=۰ هم history می‌خواند')
m(GA, 'Number.isSafeInteger(to) && ', '', 'toVersion غیرصحیح هم history می‌خواند')
m(GA, 'beforeVersion: to + 1, limit: 1', 'beforeVersion: to, limit: 1', 'history خودِ هدف را حذف می‌کند')
m(GA, 'beforeVersion: to + 1, limit: 1', 'beforeVersion: to + 1, limit: 2', 'limit بزرگ‌تر از یک')
m(GA, 'if (!page.ok) return page;', '', 'خطای history نادیده گرفته می‌شود')
m(GA, 'entry.version === to', 'true', 'هم‌نسخه بودنِ رکورد سنجیده نمی‌شود')
m(GA, 'entry !== undefined && ', '', 'رکوردِ ناموجود می‌پرتابد')
m(GA, 'return { ok: false, error: STORE_FAILURE };', 'throw 1;', 'پرتابِ مدیر بیرون نشت می‌کند')
m(GA, 'code: "STORE_FAILURE"', 'code: "VERSION_CONFLICT"', 'کدِ خطای پرتابِ مدیر عوض می‌شود')
m(GA, 'guard(() => target.current())', 'target.current()', 'current محافظ ندارد')
m(GA, 'guard(() => target.history(input))', 'target.history(input)', 'history محافظ ندارد')
m(GA, 'value: Object.freeze(preflightedAdmin)', 'value: preflightedAdmin', 'مدیر یخ نیست')
m(GA, 'if (!callable) issues.push', 'if (false) issues.push', 'متدهای مدیر سنجیده نمی‌شود')
m(GA, 'if (typeof build !== "function") issues.push', 'if (false) issues.push', 'build سنجیده نمی‌شود')
m(GA, 'callable = callable && methods.every', 'callable = callable || methods.every', 'یک متدِ موجود کافی است')
m(GA, '"rollbackTo", "current", "history"];', '"rollbackTo", "current"];', 'history لازم نیست')

EQUIVALENT = {
    2: "دفاعِ در عمق: بدونِ این ردِ صریح، projectionِ undefined به منبعِ ساختگی می‌رسد و اعتبارسنجیِ مجددِ پیوند همان PROJECTION_INVALID را می‌دهد (آزمونِ دفاعی نتیجه را ثابت می‌کند)؛ ردِ صریح را برای خوانایی نگه داشتم",
    15: "JSON.stringify(undefined) مقدارِ undefined می‌دهد و text.length می‌پرتابد؛ catch آن را null می‌کند. بررسیِ typeof فقط صریح‌کردنِ همان است",
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
