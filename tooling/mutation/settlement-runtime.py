#!/usr/bin/env python3
"""
آزمون جهشی «اجرای تسویهٔ ماندگار» (ماژول settlement-runtime؛ برش م۳‑ه‑۲، ADR-0031): هر جهش یک تغییر کوچکِ معنادار در منبعِ ماژول است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  python3 tooling/mutation/settlement-runtime.py            (همه)
       python3 tooling/mutation/settlement-runtime.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL (KB_TEST_DATABASE_URL یا DATABASE_URL؛ آزمونِ pg بدونِ آن رد می‌شود و جهش‌های pg-runtime.ts زنده می‌مانند)؛ جزو CI نیست.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-runtime/"
TESTS = [B]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


R, A, N, P = "runtime.ts", "assemble.ts", "node-timer.ts", "pg-runtime.ts"
# ── runtime.ts: چرخهٔ عمر
m(R, 'if (state === "running") return fail("ALREADY_RUNNING");', "", "start روی اجرای در حال کار حلقهٔ دوم می‌سازد")
m(R, 'if (state === "starting") return fail("STARTING");', "", "start هم‌زمان در میانهٔ پیش‌بازرسی پذیرفته می‌شود")
m(R, 'if (state === "stopping") return fail("STOPPING");', "", "start در میانهٔ stop پذیرفته می‌شود")
m(R, 'if (stopRequested) return fail("STOPPED_DURING_START");', "", "stop در میانهٔ start نادیده گرفته می‌شود (حلقهٔ یتیم)")
m(R, 'if (code !== null) return fail("PREFLIGHT_FAILED", code);', "", "شکستِ پیش‌بازرسی حلقه را شروع می‌کند")
m(R, 'if (atMs === null) return fail("CLOCK_INVALID");', "", "ساعتِ نامعتبر پذیرفته می‌شود")
m(R, "if (!r.started) return fail(r.reason);", "", "شکستِ شروعِ حلقه موفق گزارش می‌شود")
m(R, "startedAtMs = atMs;", "startedAtMs = null;", "sinceMs ثبت نمی‌شود")
m(R, "stopRequested = true; // حلقه", "stopRequested = false; // حلقه", "stop هنگامِ starting شروع را لغو نمی‌کند")
m(R, 'if (state === "stopping" && stopping !== null) return stopping;', "", "stop هم‌زمان وعدهٔ مشترک نمی‌دهد")
m(R, 'stopping = p.then((r) => {\n          state = "idle";', 'stopping = p.then((r) => {\n          state = "stopping";', "پس از stop حالت idle نمی‌شود")
m(R, "if (state === \"starting\") state = \"idle\";", "", "پس از شکستِ start حالت starting گیر می‌کند")
m(R, "sinceMs: startedAtMs", "sinceMs: null", "health مرجعِ آغاز را نمی‌داند")
m(R, "httpStatus: sweepHealthHttpStatus(h)", "httpStatus: 200", "health همیشه ۲۰۰ می‌دهد")
m(R, 'if (!r.ok) return "UNAVAILABLE";', "if (!r.ok) return null;", "مهلتِ پیش‌بازرسی موفقیت شمرده می‌شود (شکستِ باز)")
m(R, "if (v.ok === true) return null;", "if (v.ok !== false) return null;", "نتیجهٔ نامعتبرِ بی‌ok موفقیت شمرده می‌شود")
m(R, 'v.code === "NOT_MIGRATED" || v.code === "SCHEMA_MISMATCH" ? v.code : "UNAVAILABLE"', 'v.code === "NOT_MIGRATED" ? v.code : "UNAVAILABLE"', "SCHEMA_MISMATCH به UNAVAILABLE فرومی‌ریزد")
m(R, "Number.isSafeInteger(t) && t >= 0 ? t : null", "Number.isFinite(t) ? t : null", "ساعتِ منفی/اعشاری پذیرفته می‌شود")
m(R, "    if (done) return; // مهلت", "    // مهلت", "با زمان‌سنجِ خراب یا مهلتِ همگام، work بی‌مهلت صدا زده می‌شود")
m(R, "      if (armed) {\n        try {\n          timer.cancel(handle);", "      if (false) {\n        try {\n          timer.cancel(handle);", "تایمرِ مهلت پس از پایان لغو نمی‌شود")
m(R, 'if (preflight !== undefined && !isFn(preflight)) issues.push', "if (false) issues.push", "preflightِ غیرتابع پذیرفته می‌شود")
# ── assemble.ts
m(A, "Math.max(1, Math.floor(grace / 4))", "Math.floor(grace / 2)", "فاصلهٔ پیش‌فرض نصفِ grace می‌شود (گذرِ کُند ارزیاب را degraded می‌کند)")
m(A, "snap[\"leaseMs\"] === undefined ? Math.min", "snap[\"leaseMs\"] == null ? Math.min", "leaseMs=null بی‌صدا پیش‌فرض می‌شود")
m(A, "snap[\"intervalMs\"] === undefined ?", "snap[\"intervalMs\"] == null ?", "intervalMs=null بی‌صدا پیش‌فرض می‌شود")
m(A, "snap[\"startTimeoutMs\"] === undefined ?", "snap[\"startTimeoutMs\"] == null ?", "startTimeoutMs=null بی‌صدا پیش‌فرض می‌شود")
m(A, "isIntIn(startTimeoutMs, 1, ", "isIntIn(startTimeoutMs, 0, ", "startTimeoutMs=۰ پذیرفته می‌شود")
m(A, "defaultStartTimeoutMs: 15_000", "defaultStartTimeoutMs: 16_000", "مهلتِ پیش‌فرضِ مستند تغییر می‌کند")
m(A, "if (dl === false) deadLetters = null;", "if (dl === false || dl === undefined) deadLetters = null;", "نبودنِ deadLetters بی‌صدا غیرفعال می‌شود (شکستِ باز)")
m(A, "deadLetters = { outbox: ports.outbox, deliver: deadSnap[\"deliver\"], ...pick(deadSnap, DEAD_OPTIONAL) };", "deadLetters = { outbox: ports.outbox, deliver: deadSnap[\"deliver\"] };", "گزینه‌های deadLetters نادیده گرفته می‌شود")
m(A, "issues.push(...unknownKeyIssues(deadSnap, DEAD_KEYS, \" (deadLetters)\"));", "", "کلیدِ ناشناختهٔ deadLetters پذیرفته می‌شود")
m(A, "...pick(snap, LOOP_OPTIONAL),", "", "تنظیماتِ حلقه نادیده گرفته می‌شود")
m(A, "...pick(snap, SWEEPER_OPTIONAL),", "", "تنظیماتِ رفتگر نادیده گرفته می‌شود")
m(A, ".slice(0, 40)", ".slice(0, 400)", "نامِ کلیدِ ناشناخته بریده نمی‌شود")
m(A, "healthCfg = pick(hs, HEALTH_KEYS);", "healthCfg = {};", "آستانه‌های سلامت نادیده گرفته می‌شود")
# ── node-timer.ts
m(N, "ms < 0 ||", "ms < -1 ||", "تأخیرِ ‎−۱ پذیرفته می‌شود")
m(N, "ms > MAX_TIMEOUT_MS)", "ms > MAX_TIMEOUT_MS + 1)", "تأخیرِ بیش از سقف پذیرفته می‌شود (setTimeout بی‌صدا ۱ms می‌کند)")
m(N, "!Number.isFinite(ms) ||", "", "NaN/بی‌نهایت پذیرفته می‌شود")
m(N, "const unref = options.unref !== false;", "const unref = options.unref === true;", "پیش‌فرض unref نیست")
m(N, "const unref = options.unref !== false;", "const unref = true;", "unref:false نادیده گرفته می‌شود")
m(N, "|| !live.has(handle)) return;", ") return;", "دستگیرهٔ بیگانه لغو می‌شود")
m(N, "      live.delete(handle);\n", "", "لغوِ تکراری دوباره clearTimeout می‌زند")
m(N, 'if (typeof fn !== "function") throw', "if (false) throw", "fn غیرتابع پذیرفته می‌شود")
m(N, "        } catch {\n          // قرارداد", "        } finally {\n          // قرارداد", "پرتابِ fn فرایند را می‌کُشد")
m(N, "if (typeof handle === \"object\" && handle !== null) live.add(handle);", "", "هیچ دستگیره‌ای قابل‌لغو نیست")
# ── pg-runtime.ts
m(P, 'code === "MIGRATION_TAMPERED" || ', "", "مهاجرتِ دست‌کاری‌شده SCHEMA_MISMATCH نمی‌شود")
m(P, 'return r.value.pending.length > 0 ? "NOT_MIGRATED" : null;', "return null;", "مهاجرتِ معلق نادیده گرفته می‌شود")
m(P, "for (const s of [store.value, outbox.value] as const) {", "for (const s of [store.value] as const) {", "مهاجرتِ outbox در پیش‌بازرسی بررسی نمی‌شود")
m(P, "for (const s of [store.value, outbox.value] as const) {", "for (const s of [outbox.value] as const) {", "مهاجرتِ دفتر در پیش‌بازرسی بررسی نمی‌شود")
m(P, '        stage = "settlement";\n', "", "شکستِ مرحلهٔ outbox به‌نامِ دفتر گزارش می‌شود")
m(P, "const l = await store.value.migrate();", "const l = await outbox.value.migrate() as never;", "مهاجرتِ دفتر اجرا نمی‌شود")
m(P, "...pick(snap, TUNING_KEYS) });", "});", "تنظیمات به اجرا نمی‌رسد")
m(P, 'if (code === "NOT_MIGRATED") return "NOT_MIGRATED";', 'if (code === "NOT_MIGRATED") return "UNAVAILABLE";', "NOT_MIGRATED به UNAVAILABLE فرومی‌ریزد")
m(P, 'if (!hasFns(db, ["execute", "transaction"]))', "if (false)", "db نامعتبر پذیرفته می‌شود")

EQUIVALENT: dict[int, str] = {}

env = dict(os.environ)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
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
if not tests_pass():
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, B, f)
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
