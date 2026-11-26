#!/usr/bin/env python3
"""
آزمون جهشی «میزبان فرایندیِ سیاستِ ابزار» (ماژول tool-policy-host؛ برش CT‑5c‑2c‑2b‑3، ADR-0075): هر جهش یک تغییر کوچکِ معنادار در منبعِ ماژول است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  python3 tooling/mutation/tool-policy-host.py            (همه)
       python3 tooling/mutation/tool-policy-host.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22. آزمون‌های این ماژول به پایگاه نیاز ندارند؛ جزو CI نیست.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/tool-policy-host/"
TESTS = [B]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


H, P, S, C = "host.ts", "probes.ts", "singleton.ts", "config.ts"
RETRY = 'r.reason === "UNAVAILABLE" && attempts < cfg.maxAttempts'
OK_LINE = 'const ok = clean && !timedOut && (closed === "none" || closed === "ok");'
EXIT_LINE = "if (exitRequested) callExit(r.ok);"
LATCH_START = 'if (kind === "startup" && !hasBeenReady && state === "running" && readReadiness(read).ready) latch();'
# ── host.ts: بوت
m(H, 'if (state === "booting" && bootPromise !== null) return bootPromise;', "", "boot هم‌زمان start دوم می‌زند")
m(H, 'if (state === "stopping" || state === "stopped") return Promise.resolve(shuttingDown());', "", "boot پس از خاموشی دوباره راه می‌افتد")
m(H, 'if (state === "running") return Promise.resolve(bootSuccess as HostBootResult);', "", "boot پس از موفقیت دوباره start می‌زند")
m(H, 'if (!installSignals()) return failBoot("SIGNALS_UNAVAILABLE");', "", "ریشه بدونِ خاموشیِ مرتب شروع می‌شود")
m(H, "if (signals === false || listeners.size > 0) return true;", "if (signals === false) return true;", "بوتِ دوباره شنونده‌ها را تکراری نصب می‌کند")
m(H, "      } catch {\n        removeSignals();\n        return false;", "      } catch {\n        return false;", "شنونده‌ی نیمه‌نصب برگردانده نمی‌شود")
m(H, "for (const sig of SIGNALS) {", 'for (const sig of ["SIGTERM"] as const) {', "SIGINT نصب نمی‌شود")
m(H, RETRY, "attempts < cfg.maxAttempts", "هر شکستی (حتی NOT_MIGRATED) بازتلاش می‌شود")
m(H, RETRY, 'r.reason === "UNAVAILABLE"', "بازتلاشِ بی‌پایان")
m(H, "attempts < cfg.maxAttempts", "attempts <= cfg.maxAttempts", "یک تلاشِ اضافه")
m(H, 'if (waited === "broken") return failBoot(r.reason);', "", "با زمان‌سنجِ خراب حلقهٔ داغِ بی‌انتظار")
m(H, '      for (;;) {\n        if (state !== "booting") return shuttingDown();', "      for (;;) {", "پس از خاموشی تلاشِ تازه شروع می‌شود")
m(H, 'if (state !== "booting") return shuttingDown(); // shutdown() خودش', "// shutdown() خودش", "start موفقِ هنگامِ خاموشی running می‌شود")
m(H, "hasBooted = true;", "hasBooted = false;", "hasBooted هرگز true نمی‌شود")
m(H, "bootSuccess = done;", "", "نتیجهٔ موفقِ کش‌شده نیست")
m(H, "      lastFailure = null;\n      if (!installSignals())", "      if (!installSignals())", "شکستِ قدیمی پس از موفقیت می‌ماند")
m(H, "      attempts = 0;\n      lastFailure", "      lastFailure", "شمارندهٔ تلاش بازنشانی نمی‌شود")
m(H, '      state = "failed";\n      lastFailure = { reason };', '      state = "idle";\n      lastFailure = { reason };', "پس از شکستِ بوت حالت failed نمی‌شود")
m(H, "if (started !== false) return invalidStart;", "", "started غیرِ بولی پذیرفته می‌شود")
m(H, 'typeof reason !== "string" || !RUNTIME_REASONS.includes(reason)', 'typeof reason !== "string"', "دلیلِ ناشناخته/قدیمی پذیرفته و عبور داده می‌شود")
m(H, '"NOT_MIGRATED", "SCHEMA_MISMATCH", "UNAVAILABLE", "SCHEDULE_FAILED"];', '"NOT_MIGRATED", "UNAVAILABLE", "SCHEDULE_FAILED"];', "SCHEMA_MISMATCH از مجموعهٔ دلیل‌ها می‌افتد")
m(H, "return v.stopped === true && v.abandonedInFlight === false;", "return v.stopped === true;", "گذرِ رهاشده تمیز حساب می‌شود")
m(H, "return v.stopped === true && v.abandonedInFlight === false;", "return v.abandonedInFlight === false;", "stopped=false تمیز حساب می‌شود")
m(H, "return normalizeStart(await runtime.start());\n      } catch {\n        return invalidStart;", "return normalizeStart(await runtime.start());\n      } catch {\n        return okStart;", "start پرتاب‌کننده موفق حساب می‌شود")
m(H, "return isCleanStop(await runtime.stop());\n      } catch {\n        return false;", "return isCleanStop(await runtime.stop());\n      } catch {\n        return true;", "stop پرتاب‌کننده تمیز حساب می‌شود")
# ── host.ts: خاموشی
m(H, OK_LINE, 'const ok = clean && (closed === "none" || closed === "ok");', "مهلت‌گذشته ok می‌شود")
m(H, OK_LINE, 'const ok = !timedOut && (closed === "none" || closed === "ok");', "توقفِ ناتمیز ok می‌شود")
m(H, OK_LINE, "const ok = clean && !timedOut;", "شکستِ بستنِ منابع ok می‌شود")
m(H, 'closeResources === null ? "none" : !clean ? "skipped" :', 'closeResources === null ? "none" :', "closed=skipped گزارش نمی‌شود")
m(H, "if (!st.stopClean || closeResources === null) return;", "if (closeResources === null) return;", "منابع پس از توقفِ ناتمیز بسته می‌شود")
m(H, "if (pendingBoot !== null) await pendingBoot;", "", "منابع پیش از پایانِ بوتِ در جریان بسته می‌شود")
m(H, "if (shutdownPromise !== null) return shutdownPromise;", "", "خاموشیِ هم‌زمان چند بار stop می‌زند")
m(H, "const wake = abortWait;\n      if (wake !== null) wake();", "const wake = abortWait;", "خاموشی انتظارِ بازتلاش را بیدار نمی‌کند")
m(H, '        state = "stopped";\n        removeSignals();', '        state = "stopped";', "شنونده‌ها پس از خاموشی برداشته نمی‌شوند")
m(H, '        state = "stopped";', '        state = "stopping";', "حالتِ پایانیِ stopped ثبت نمی‌شود")
m(H, EXIT_LINE, "callExit(r.ok);", "خاموشیِ دستی هم exit می‌زند")
m(H, EXIT_LINE, "if (exitRequested) callExit(true);", "شکستِ خاموشی با exit(0) می‌رود")
m(H, "exit(ok ? 0 : 1);", "exit(0);", "کدِ خروجِ شکست همیشه ۰ است")
m(H, "exitRequested = true;", "", "پس از سیگنال exit صدا زده نمی‌شود")
# ── host.ts: آمادگی/چسبندگی
m(H, LATCH_START, "", "startup هرگز از روی آمادگی چسبنده نمی‌شود")
m(H, LATCH_START, LATCH_START.replace(' && state === "running"', ""), "در حالتِ غیرِ running چسبنده می‌شود")
m(H, LATCH_START, LATCH_START.replace('kind === "startup"', 'kind !== "live"'), "ready دو بار health می‌خواند")
m(H, 'if (kind === "ready" && res.body.ok && state === "running") latch();', "", "پروبِ ready نخستین آمادگی را چسبنده نمی‌کند")
m(H, "      if (hasBeenReady) return;\n      hasBeenReady = true;", "      hasBeenReady = true;", "ready.first چند بار می‌آید")
m(H, 'emit({ type: "ready.first" });', "", "رویدادِ ready.first نمی‌آید")
m(H, "hasBooted, hasBeenReady,", "hasBooted, hasBeenReady: false,", "status().hasBeenReady همیشه false")
# ── probes.ts
m(P, 'if (ready === true) return state === "RUNNING" && reason === null ? READY : UNAVAILABLE;', "if (ready === true) return READY;", "ready=true بی‌سنجشِ هم‌سازگاری پذیرفته می‌شود")
m(P, 'return state === "RUNNING" && reason === null ? READY : UNAVAILABLE;', 'return state === "RUNNING" ? READY : UNAVAILABLE;', "ready=true با reason غیرتهی پذیرفته می‌شود")
m(P, 'return state === "RUNNING" && reason === null ? READY : UNAVAILABLE;', "return reason === null ? READY : UNAVAILABLE;", "ready=true با state غیرِ RUNNING پذیرفته می‌شود")
m(P, "if (ready !== false) return UNAVAILABLE;", "", "ready غیرِ بولی (مثلاً رشتهٔ false) پذیرفته می‌شود")
m(P, '(NOT_READY_REASONS as readonly string[]).includes(reason)', "true", "دلیلِ آزاد (نشتِ متن) بیرون می‌رود")
m(P, '"STALE", "CLOCK_INVALID"', '"CLOCK_INVALID"', "دلیلِ STALE از مجموعه می‌افتد")
m(P, 'if (kind === "live") return result("live", true, state, null);', 'if (kind === "live") return result("live", state === "running", state, null);', "live به حالت وابسته می‌شود")
m(P, 'if (kind === "startup") return result("startup", hasBeenReady === true, state, null);', 'if (kind === "startup") return result("startup", true, state, null);', "startup همیشه ۲۰۰")
m(P, 'if (state !== "running") return result("ready", false, state, null);', "", "ready در غیرِ running هم سلامت را می‌خواند")
m(P, 'return result("ready", r.ready, state, r.reason);', 'return result("ready", r.ready, state, null);', "دلیلِ ناآمادگی گم می‌شود")
m(P, "ok ? (200 as const) : (503 as const)", "ok ? (200 as const) : (200 as const)", "ناآماده هم ۲۰۰ می‌شود")
# ── config.ts
m(C, "if (!isIntIn(shutdownTimeoutMs, 1,", "if (!isIntIn(shutdownTimeoutMs, 0,", "shutdownTimeoutMs=0 پذیرفته می‌شود")
m(C, "maxBootAttempts: 10,", "maxBootAttempts: 11,", "سقفِ تلاش یکی بالاتر")
m(C, "defaultBootAttempts: 1,", "defaultBootAttempts: 2,", "پیش‌فرضِ تلاش ۲")
m(C, "defaultShutdownTimeoutMs: 15_000,", "defaultShutdownTimeoutMs: 20_000,", "پیش‌فرضِ مهلتِ خاموشی عوض می‌شود")
m(C, "defaultBootDelayMs: 1_000,", "defaultBootDelayMs: 2_000,", "پیش‌فرضِ تأخیر عوض می‌شود")
m(C, "maxBootDelayMs: 60_000,", "maxBootDelayMs: 70_000,", "سقفِ تأخیر بالاتر")
m(C, "maxShutdownTimeoutMs: 300_000,", "maxShutdownTimeoutMs: 400_000,", "سقفِ مهلتِ خاموشی بالاتر")
m(C, 'if (signals !== false && !hasFns(signals, ["on", "off"]))', 'if (signals !== false && signals !== undefined && !hasFns(signals, ["on", "off"]))', "signals اختیاری می‌شود")
m(C, "const issues = unknownKeyIssues(snap, HOST_KEYS);", "const issues: string[] = [];", "کلیدِ ناشناخته پذیرفته می‌شود")
m(C, 'issues.push(...unknownKeyIssues(rs, RETRY_KEYS, " (bootRetry)"));', "", "کلیدِ ناشناختهٔ bootRetry پذیرفته می‌شود")
m(C, '!hasFns(runtime, ["start", "stop", "health"])', '!hasFns(runtime, ["start", "stop"])', "runtime بدونِ health پذیرفته می‌شود")
m(C, 'if (exit !== undefined && !isFn(exit)) issues.push("exit باید تابع باشد.");', "", "exit غیرتابع پذیرفته می‌شود")
m(C, 'if (closeResources !== undefined && !isFn(closeResources)) issues.push("closeResources باید تابع باشد.");', "", "closeResources غیرتابع پذیرفته می‌شود")
m(C, 'if (observer !== undefined && !isFn(observer)) issues.push("observer باید تابع باشد.");', "", "observer غیرتابع پذیرفته می‌شود")
# ── singleton.ts
m(S, "isHost(existing) ? {", "true ? {", "مقدارِ بیگانه به‌عنوان میزبان پذیرفته می‌شود")
m(S, 'if (store[TOOL_POLICY_HOST_STORE_KEY] !== made.value) return hostError("INVALID_STORE", ["نوشتن در store ممکن نبود."]);', "", "نوشتنِ بی‌اثرِ ظرف شناسایی نمی‌شود")
m(S, 'Symbol.for("legal-platform.tool-policy-host")', 'Symbol("legal-platform.tool-policy-host")', "کلید دیگر مشترکِ بسته‌ها نیست")
m(S, 'hasFns((v as { probes: unknown }).probes, ["live", "startup", "ready"])', 'hasFns((v as { probes: unknown }).probes, ["live", "ready"])', "میزبان بدونِ startup پذیرفته می‌شود")
m(S, 'hasFns(v, ["boot", "shutdown", "status"])', 'hasFns(v, ["boot", "shutdown"])', "میزبان بدونِ status پذیرفته می‌شود")

EQUIVALENT = {}

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
