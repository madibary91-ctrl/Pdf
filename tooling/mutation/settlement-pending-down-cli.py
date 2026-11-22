#!/usr/bin/env python3
"""
آزمون جهشی «دستورِ down در CLIِ settlement-pending-migrate» (برش م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۲‑۲، ADR-0049): هر جهش یک تغییرِ کوچکِ معنادار در
`args.ts`/`execute.ts` است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است. جزو CI نیست.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/settlement-pending-down-cli.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/settlement-pending-down-cli.py 3 9                      (فقط جهش‌های ۳ تا ۹)
هر جهش نخست با آزمون‌های سریعِ بی‌پایگاه سنجیده می‌شود؛ فقط اگر زنده ماند، `down.pg.test.ts` (PostgreSQL واقعی، کُند) هم اجرا می‌شود.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متنِ اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-pending-migrate/"
FAST = [B + "down.test.ts", B + "args.test.ts", B + "cli.test.ts", B + "purity.test.ts"]
SLOW = [B + "down.pg.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


A, X = "args.ts", "execute.ts"
# ── args.ts
m(A, 'const COMMANDS: readonly string[] = ["status", "up", "verify", "down"];', 'const COMMANDS: readonly string[] = ["status", "up", "verify"];', "down پذیرفته نمی‌شود")
m(A, 'if (command === "down" && !seenYes) issues.push(', "if (false) issues.push(", "down بی‌--yes اجرا می‌شود (دستورِ مخرب بی‌تأیید)")
m(A, 'if (command !== null && command !== "down" && seenYes) issues.push(', "if (false) issues.push(", "--yes با دستورِ غیر از down پذیرفته می‌شود")
m(A, "if (eq !== -1) issues.push(`${FLAG_YES} مقدار نمی‌گیرد.`);", "", "--yes=1 پذیرفته می‌شود")
m(A, "else if (seenYes) issues.push(`${FLAG_YES} تکراری است.`);", "", "--yes تکراری پذیرفته می‌شود")
m(A, "          seenYes = true;\n", "", "--yes هرگز ثبت نمی‌شود (down همیشه رد می‌شود)")
m(A, 'if (name === FLAG_YES) {', 'if (name === "--yez") {', "--yes فلگِ ناشناخته می‌شود")
# ── execute.ts (executeDown)
m(X, 'if (command === "down") return executeDown(index, progress, first);', "", "down به مسیرِ up می‌افتد و مهاجرت می‌زند")
m(X, 'if (first.applied.length === 0) return Object.freeze({ code: "OK" as const, phase: "check" as const });', "", "نصب‌نشده هم down() (قفل) می‌زند")
m(X, "      r = await index.down();", "      r = await index.migrate();", "به‌جای down، migrate صدا زده می‌شود")
m(X, '    if (progress.cancelled) return fail(progress, { code: "TIMEOUT" });\n    let r: unknown;\n    try {\n      r = await index.down();', "    let r: unknown;\n    try {\n      r = await index.down();", "پس از مهلت، down (DDL) تازه‌ای شروع می‌شود")
m(X, 'const raced = rec.ok === false && asStoreError(rec.error).code === "NOT_MIGRATED";', "const raced = false;", "مسابقهٔ برگشتِ هم‌زمان ۸ می‌دهد")
m(X, "if (again.applied.length > 0 && raced) {", "if (false) {", "NOT_MIGRATEDِ واقعی ۶ می‌شود نه ۸")
m(X, '    progress.phase = "apply";\n    return fail(progress, classifyError(rec.error, classifyApply));', "    return fail(progress, classifyError(rec.error, classifyApply));", "فازِ PREREQUISITE در مسابقه verify می‌شود")
m(X, 'if (again.applied.length > 0) return fail(progress, { code: "MIGRATION_FAILED" });\n  return Object.freeze({ code: "OK" as const, phase: "verify" as const });', 'return Object.freeze({ code: "OK" as const, phase: "verify" as const });', "ادعای down بی‌راستی‌آزمایی پذیرفته می‌شود")
m(X, "progress.migrations = stateAfterDown(again.applied, again.pending, reverted);", "progress.migrations = stateAfterDown(again.applied, again.pending, []);", "revertedNow پس از راستی‌آزمایی گم می‌شود")
m(X, '  progress.phase = "verify";\n  if (progress.cancelled) return fail(progress, { code: "TIMEOUT" });\n  const again = await readStatus(index);\n  if (again === "malformed") return fail(progress, INTERNAL);\n  if (!again.ok) return fail(progress, classifyError(again.error, classifyVerify));\n  progress.migrations = stateAfterDown', '  progress.phase = "verify";\n  const again = await readStatus(index);\n  if (again === "malformed") return fail(progress, INTERNAL);\n  if (!again.ok) return fail(progress, classifyError(again.error, classifyVerify));\n  progress.migrations = stateAfterDown', "پس از مهلت، status ی پایانی شروع می‌شود")
m(X, 'if (!first.ok && command === "down" && asStoreError(first.error).code === "NOT_MIGRATED") return Object.freeze({ code: "OK" as const, phase: "check" as const });', "", "دفترِ ناپدیدشده در check برای down ۳ می‌دهد")
m(X, 'if (rec.ok === false && !raced) return fail(progress, classifyError(rec.error, classifyApply));', "if (rec.ok === false && !raced) return fail(progress, INTERNAL);", "نگاشتِ خطای down از دست می‌رود")
m(X, "if ((!raced && rec.ok !== true) || !isNames(reverted)) return fail(progress, INTERNAL);", "if (false) return fail(progress, INTERNAL);", "پاسخِ مخدوشِ down پذیرفته می‌شود")
m(X, "[...first.pending, ...reverted.filter((n) => first.applied.includes(n))]", "first.pending", "وضعیتِ میانیِ pending بعد از برگشت درست نیست")
m(X, "first.applied.filter((n) => !reverted.includes(n))", "first.applied", "وضعیتِ میانیِ applied بعد از برگشت درست نیست")
m(X, 'if (typeof index.down !== "function") return fail(progress, INTERNAL);', "", "نبودِ down بی‌صدا به پرتابِ TypeError می‌افتد")

EQUIVALENT_BY_WHY = {
    "نبودِ down بی‌صدا به پرتابِ TypeError می‌افتد": "دفاعِ دوم: `index.down()` در try است و پرتابِ TypeError هم `INTERNAL` می‌دهد؛ رفتارِ بیرونی عوض نمی‌شود (فقط شکلِ نوع و صراحتِ کد).",
}
EQUIVALENT: dict = {}
for _i, (_f, _o, _n, _why) in enumerate(M):
    if _why in EQUIVALENT_BY_WHY:
        EQUIVALENT[_i] = EQUIVALENT_BY_WHY[_why]

env = dict(os.environ)


def passes(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
origs = {}
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
    p = os.path.join(ROOT, B, f)
    origs.setdefault(f, open(p, encoding="utf8").read())
    if origs[f].count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد در {f}: {old[:80]!r}"); sys.exit(2)
    if new == old:
        print(f"[{i}] جهش بی‌اثر است: {why}"); sys.exit(2)
if not passes(FAST + SLOW):
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, B, f)
    open(path, "w", encoding="utf8").write(origs[f].replace(old, new, 1))
    try:
        ok = passes(FAST)
        slow_killed = False
        if ok:
            ok = passes(SLOW)
            slow_killed = not ok
    finally:
        open(path, "w", encoding="utf8").write(origs[f])
    if ok and i not in EQUIVALENT:
        alive.append((i, why)); print(f"[{i:02d}] ✗ زنده: {why}", flush=True)
    else:
        killed += 1
        print(f"[{i:02d}] ✓ کشته{' (فقط PostgreSQL)' if slow_killed else ''}: {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
