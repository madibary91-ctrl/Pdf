#!/usr/bin/env python3
"""
آزمون جهشی «ثبتِ شکستِ تکرارپذیر» در ماژول settlement (برش م۳‑د‑۳الف؛ ADR-0028): هر جهش یک تغییر کوچکِ معنادار در کد منبع است؛ آزمون‌های تازهٔ این برش باید قرمز شوند.
اجرا:  python3 tooling/mutation/settlement-failure-cas.py            (همه)
       python3 tooling/mutation/settlement-failure-cas.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و پایگاه (DATABASE_URL یا KB_TEST_DATABASE_URL)؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل‌ها هست؛ فایل اصلی پس از هر جهش همیشه برمی‌گردد.
هر جهش فقط با آزمون‌های مربوط به فایلِ خودش سنجیده می‌شود (سرعت)؛ پیش از شروع، همهٔ آزمون‌های تازه بدونِ جهش باید سبز باشند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement/"
MEM = [B + "memory-failure-cas.test.ts"]
PGT = [B + "pg/failure-cas.unit.test.ts", B + "pg/failure-cas.pg.test.ts"]
SWP = [B + "sweeper.failure-cas.test.ts"]
NEW_TESTS = MEM + PGT + SWP
M = []


def m(f, old, new, why, tests=None):
    default = {"memory-outbox.ts": MEM, "pg/store.ts": PGT, "sweeper.ts": SWP, "validate.ts": MEM + PGT}[f]
    M.append((f, old, new, why, tests or default))


# ── memory-outbox.ts
GT = "if (a.value.attempts > expected) return ok({ attempts: a.value.attempts, replayed: true });"
LT = 'if (a.value.attempts < expected) return conflict("شمارندهٔ تلاشِ مورد انتظار از شمارندهٔ رکورد بیشتر است.");'
RES = "return ok(expected === undefined ? { attempts: a.value.attempts } : { attempts: a.value.attempts, replayed: false });"
m("memory-outbox.ts", GT, "if (a.value.attempts >= expected) return ok({ attempts: a.value.attempts, replayed: true });", "حالتِ برابر هم replayed می‌شود (ثبتِ اول هرگز نمی‌شمارد)")
m("memory-outbox.ts", GT, "if (a.value.attempts > expected) return ok({ attempts: a.value.attempts, replayed: false });", "replayed همیشه false در حالتِ کهنه")
m("memory-outbox.ts", GT, "", "حالتِ کهنه دوباره می‌شمارد (ریشهٔ باگِ دو رفتگر)")
m("memory-outbox.ts", GT, "if (a.value.attempts > expected) return ok({ attempts: expected, replayed: true });", "replayed شمارندهٔ مورد انتظار را برمی‌گرداند نه فعلی")
m("memory-outbox.ts", GT, "if (a.value.attempts > expected) { a.value.dueAtMs = want.dueAtMs; return ok({ attempts: a.value.attempts, replayed: true }); }", "replayed سررسید را بازنویسی می‌کند")
m("memory-outbox.ts", GT, "if (a.value.attempts > expected) { a.value.lastErrorCode = want.errorCode; return ok({ attempts: a.value.attempts, replayed: true }); }", "replayed کدِ خطا را بازنویسی می‌کند")
m("memory-outbox.ts", LT, "", "شمارندهٔ «آینده» پذیرفته می‌شود")
m("memory-outbox.ts", LT, LT.replace("<", "<="), "حالتِ برابر CONFLICT می‌شود")
m("memory-outbox.ts", LT, LT.replace('conflict("شمارندهٔ تلاشِ مورد انتظار از شمارندهٔ رکورد بیشتر است.")', "ok({ attempts: a.value.attempts, replayed: true })"), "شمارندهٔ آینده replayed می‌شود نه CONFLICT")
m("memory-outbox.ts", LT, LT.replace("بیشتر است.", "بیشتر است (${expected}).").replace('conflict("', "conflict(`").replace('");', '`);'), "پیامِ CONFLICT مقدارِ ورودی را بازتاب می‌دهد")
m("memory-outbox.ts", RES, "return ok({ attempts: a.value.attempts, replayed: false });", "مسیرِ بی‌expected هم replayed می‌دهد")
m("memory-outbox.ts", RES, "return ok({ attempts: a.value.attempts });", "مسیرِ CAS بی‌replayed می‌ماند")
m("memory-outbox.ts", RES, "return ok(expected === undefined ? { attempts: a.value.attempts } : { attempts: a.value.attempts, replayed: true });", "ثبتِ واقعی replayed:true می‌دهد")
m("memory-outbox.ts", "const expected = want.expectedAttempts;\n        if (expected !== undefined) {", "const expected = want.expectedAttempts;\n        if (false) {", "CAS هرگز اجرا نمی‌شود")
# ── validate.ts
m("validate.ts", "    if (expectedAttempts === undefined) return { ok: true, value: Object.freeze({ errorCode, dueAtMs }) };\n", "", "undefined دیگر مثلِ نبودن نیست")
m("validate.ts", "    if (!isCount(expectedAttempts)) return invalid();\n", "", "expectedAttempts نامعتبر اعتبارسنجی نمی‌شود")
m("validate.ts", "if (!isCount(expectedAttempts)) return invalid();", "if (typeof expectedAttempts !== \"number\") return invalid();", "اعداد منفی/اعشاری/ناایمن پذیرفته می‌شوند")
m("validate.ts", "Object.freeze({ errorCode, dueAtMs, expectedAttempts })", "Object.freeze({ errorCode, dueAtMs })", "expectedAttempts در خروجیِ اعتبارسنجی حذف می‌شود")
# ── pg/store.ts
PGE = "const expected = want.expectedAttempts;\n      return run("
m("pg/store.ts", "if (a.value.attempts > expected) return ok({ attempts: a.value.attempts, replayed: true });", "if (a.value.attempts >= expected) return ok({ attempts: a.value.attempts, replayed: true });", "حالتِ برابر هم replayed می‌شود")
m("pg/store.ts", "if (a.value.attempts > expected) return ok({ attempts: a.value.attempts, replayed: true });", "", "حالتِ کهنه دوباره می‌شمارد")
m("pg/store.ts", "if (a.value.attempts > expected) return ok({ attempts: a.value.attempts, replayed: true });", "if (a.value.attempts > expected) return ok({ attempts: a.value.attempts, replayed: false });", "replayed همیشه false")
m("pg/store.ts", "if (a.value.attempts > expected) return ok({ attempts: a.value.attempts, replayed: true });", "if (a.value.attempts > expected) return ok({ attempts: expected, replayed: true });", "replayed شمارندهٔ مورد انتظار را برمی‌گرداند")
m("pg/store.ts", 'if (a.value.attempts < expected) return conflict("شمارندهٔ تلاشِ مورد انتظار از شمارندهٔ رکورد بیشتر است.");', "", "شمارندهٔ آینده پذیرفته می‌شود")
m("pg/store.ts", "a.value.attempts < expected", "a.value.attempts <= expected", "حالتِ برابر CONFLICT می‌شود")
m("pg/store.ts", "return ok(expected === undefined ? { attempts } : { attempts, replayed: false });", "return ok({ attempts });", "مسیرِ CAS بی‌replayed")
m("pg/store.ts", "return ok(expected === undefined ? { attempts } : { attempts, replayed: false });", "return ok({ attempts, replayed: false });", "مسیرِ بی‌expected هم replayed می‌دهد")
m("pg/store.ts", "const expected = want.expectedAttempts;", "const expected = undefined as number | undefined;", "CAS هرگز اجرا نمی‌شود")
m("pg/store.ts", "        const a = await lockActive(tx, ref2);\n        if (!a.ok) return a;\n        if (expected !== undefined) {", "        const e0 = await select(tx, ref2, false);\n        if (e0 === null) return notFound();\n        if (!isActive(e0)) return notActive();\n        const a = { ok: true as const, value: e0 };\n        if (expected !== undefined) {", "CAS بی‌قفلِ ردیف (دو فرایند هر دو می‌شمارند)")
m("pg/store.ts", "SET attempts = attempts + 1, last_error_code = ${want.errorCode}, due_at_ms = ${want.dueAtMs}\n          WHERE ${keyWhere(ref2)} RETURNING attempts", "SET attempts = ${expected === undefined ? sql`attempts + 1` : expected}, last_error_code = ${want.errorCode}, due_at_ms = ${want.dueAtMs}\n          WHERE ${keyWhere(ref2)} RETURNING attempts", "UPDATE شمارنده را به expected می‌نویسد (نه +۱)")
# ── sweeper.ts
SW = "dueAtMs: now + cfg.retryDelayMs * (e.attempts + 1), expectedAttempts: e.attempts }"
m("sweeper.ts", SW, "dueAtMs: now + cfg.retryDelayMs * (e.attempts + 1) }", "رفتگر expectedAttempts نمی‌فرستد")
m("sweeper.ts", SW, "dueAtMs: now + cfg.retryDelayMs * (e.attempts + 1), expectedAttempts: e.attempts + 1 }", "expectedAttempts یکی جلوتر")
m("sweeper.ts", SW, "dueAtMs: now + cfg.retryDelayMs * (e.attempts + 1), expectedAttempts: 0 }", "expectedAttempts ثابت صفر")
m("sweeper.ts", '(recorded as { replayed?: unknown }).replayed === true ? { kind: "raced" } : { kind: "retry" };', '(recorded as { replayed?: unknown }).replayed === true ? { kind: "retry" } : { kind: "retry" };', "replayed هرگز raced نمی‌شود")
m("sweeper.ts", '(recorded as { replayed?: unknown }).replayed === true ? { kind: "raced" } : { kind: "retry" };', '(recorded as { replayed?: unknown }).replayed !== undefined ? { kind: "raced" } : { kind: "retry" };', "هر replayed غیرتهی raced است")
m("sweeper.ts", '(recorded as { replayed?: unknown }).replayed === true ? { kind: "raced" } : { kind: "retry" };', '(recorded as { replayed?: unknown }).replayed === true ? { kind: "raced" } : { kind: "raced" };', "همه raced")
m("sweeper.ts", 'typeof recorded === "object" && recorded !== null && ', "", "ارزشِ خرابِ پورت می‌پرتابد")
m("sweeper.ts", 'if (!rf.ok) return { kind: "outbox-failure" };', 'if (!rf.ok) return { kind: "raced" };', "خطای outbox (CONFLICT) raced حساب می‌شود")
m("sweeper.ts", 'if (!rf.ok) return { kind: "outbox-failure" };', 'if (!rf.ok) return { kind: "retry" };', "خطای outbox retry حساب می‌شود")

EQUIVALENT: dict[int, str] = {
    35: "حفاظِ نوعِ ارزشِ پورت دفاعِ در عمق است؛ بدونِ آن، `undefined.replayed` پرتاب می‌شود و `catch`ِ بیرونیِ settleEntry (خطای برنامه‌نویسی ⇒ retry) همان نتیجهٔ `retry` را می‌دهد؛ رفتارِ قابل‌مشاهده یکی است.",
}

env = dict(os.environ)
if not (env.get("KB_TEST_DATABASE_URL") or env.get("DATABASE_URL")):
    print("پایگاه تنظیم نشده است (DATABASE_URL)."); sys.exit(2)


def tests_pass(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
for i, (f, old, new, why, _t) in enumerate(M):  # پیش‌بازرسی
    src = open(os.path.join(ROOT, B, f), encoding="utf8").read()
    if src.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {f}: {old[:70]!r}"); sys.exit(2)
if not tests_pass(NEW_TESTS):
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why, tests) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, B, f)
    src = open(path, encoding="utf8").read()
    open(path, "w", encoding="utf8").write(src.replace(old, new, 1))
    try:
        ok = tests_pass(tests)
    finally:
        open(path, "w", encoding="utf8").write(src)
    if ok and i not in EQUIVALENT:
        alive.append((i, f, why)); print(f"[{i:02d}] ✗ زنده: {f} — {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {f} — {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
