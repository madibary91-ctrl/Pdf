#!/usr/bin/env python3
"""
آزمون جهشی «میزبان فرایندیِ تسویه» (ماژول settlement-host؛ برش م۳‑ه‑۳‑الف، ADR-0032): هر جهش یک تغییر کوچکِ معنادار در منبعِ ماژول است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  python3 tooling/mutation/settlement-host.py            (همه)
       python3 tooling/mutation/settlement-host.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22. آزمون‌های این ماژول به پایگاه نیاز ندارند؛ جزو CI نیست.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-host/"
TESTS = [B]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


H, P, S, C, N = "host.ts", "probes.ts", "singleton.ts", "config.ts", "node-process.ts"
OK_LINE = 'const ok = clean && !timedOut && (closed === "none" || closed === "ok");'
RETRY_COND = 'r.reason === "PREFLIGHT_FAILED" && r.code === "UNAVAILABLE" && attempts < cfg.maxAttempts'
ATMS = 'typeof atMs === "number" && Number.isSafeInteger(atMs) && atMs >= 0'
SIG_ON = "on: (signal: HostSignal, listener: () => void): unknown => proc."
# ── host.ts: بوت
m(H, 'if (state === "booting" && bootPromise !== null) return bootPromise;', "", "boot هم‌زمان start دوم می‌زند")
m(H, 'if (state === "stopping" || state === "stopped") return Promise.resolve(shuttingDown());', "", "boot پس از خاموشی دوباره راه می‌افتد")
m(H, 'if (!installSignals()) return failBoot("SIGNALS_UNAVAILABLE", null);', "", "رفتگر بدونِ خاموشیِ مرتب شروع می‌شود")
m(H, "if (signals === false || listeners.size > 0) return true;", "if (signals === false) return true;", "بوتِ دوباره شنونده‌ها را تکراری نصب می‌کند")
m(H, "      } catch {\n        removeSignals();\n        return false;", "      } catch {\n        return false;", "شنونده‌ی نیمه‌نصب برگردانده نمی‌شود")
m(H, "for (const sig of SIGNALS) {", 'for (const sig of ["SIGTERM"] as const) {', "SIGINT نصب نمی‌شود")
m(H, 'const SIGNALS: readonly HostSignal[] = ["SIGTERM", "SIGINT"];', 'const SIGNALS: readonly HostSignal[] = ["SIGTERM", "SIGINT", "SIGINT"];', "سیگنالِ تکراری نصب می‌شود")
m(H, RETRY_COND, 'r.code === "UNAVAILABLE" && attempts < cfg.maxAttempts', "هر شکستی با کدِ UNAVAILABLE بازتلاش می‌شود")
m(H, RETRY_COND, 'r.reason === "PREFLIGHT_FAILED" && attempts < cfg.maxAttempts', "شکستِ دائمی (NOT_MIGRATED/SCHEMA_MISMATCH) بازتلاش می‌شود")
m(H, "attempts < cfg.maxAttempts", "attempts <= cfg.maxAttempts", "یک تلاشِ اضافه")
m(H, "attempts < cfg.maxAttempts", "true", "بازتلاشِ بی‌پایان")
m(H, 'if (waited === "broken") return failBoot(r.reason, r.code);', "", "با زمان‌سنجِ خراب حلقهٔ داغِ بی‌انتظار")
m(H, '      for (;;) {\n        if (state !== "booting") return shuttingDown();', "      for (;;) {", "پس از خاموشی تلاشِ تازه شروع می‌شود")
m(H, 'if (state !== "booting") return shuttingDown(); // shutdown() خودش', "// shutdown() خودش", "start موفقِ هنگامِ خاموشی running می‌شود")
m(H, "hasBooted = true;", "hasBooted = false;", "startup هرگز ۲۰۰ نمی‌شود")
m(H, "bootSuccess = done;", "", "نتیجهٔ موفقِ کش‌شده نیست")
m(H, "      lastFailure = null;\n      if (!installSignals())", "      if (!installSignals())", "شکستِ قدیمی پس از موفقیت می‌ماند")
m(H, "      attempts = 0;\n      lastFailure", "      lastFailure", "شمارندهٔ تلاش بازنشانی نمی‌شود")
m(H, '      state = "failed";\n      lastFailure = { reason, code };', '      state = "idle";\n      lastFailure = { reason, code };', "پس از شکستِ بوت حالت failed نمی‌شود")
m(H, "if (started !== false) return invalidStart;", "", "started غیرِ بولی پذیرفته می‌شود")
m(H, ATMS, 'typeof atMs === "number" && Number.isSafeInteger(atMs)', "atMs منفی پذیرفته می‌شود")
m(H, ATMS, 'typeof atMs === "number" && atMs >= 0', "atMs اعشاری پذیرفته می‌شود")
m(H, 'if (typeof reason !== "string" || !START_REASONS.includes(reason)) return invalidStart;', 'if (typeof reason !== "string") return invalidStart;', "دلیلِ ناشناخته به گزارش نشت می‌کند")
m(H, 'code: typeof code === "string" && START_CODES.includes(code) ? (code as BootFailureCode) : null', 'code: typeof code === "string" ? (code as BootFailureCode) : null', "کدِ ناشناخته (و نشتِ مقدار) به گزارش می‌رسد")
# ── host.ts: خاموشی
m(H, "if (shutdownPromise !== null) return shutdownPromise;", "", "shutdown هم‌زمان stop دوم می‌زند")
m(H, '      shutdownReason = reason;\n      state = "stopping";', "      shutdownReason = reason;", "ready در آغازِ خاموشی ۵۰۳ نمی‌شود")
m(H, "if (wake !== null) wake();", "", "انتظارِ بازتلاشِ بوت لغو نمی‌شود")
m(H, "const pendingBoot = bootPromise;", "const pendingBoot = null;", "close پیش از پایانِ بوتِ نیمه‌کاره اجرا می‌شود")
m(H, "if (pendingBoot !== null) await pendingBoot;", "", "منابع زیرِ پای بوتِ نیمه‌کاره بسته می‌شود")
m(H, "if (!st.stopClean || closeResources === null) return;", "if (closeResources === null) return;", "استخر زیرِ گذرِ آویزان بسته می‌شود")
m(H, "          st.closeOk = true;", "", "closeResources موفق هم failed گزارش می‌شود")
m(H, "        st.closeDone = true;", "", "closeResources تمام‌شده هم failed گزارش می‌شود")
m(H, "        } catch {\n          st.closeOk = false;", "        } catch {\n          st.closeOk = true;", "شکستِ closeResources موفق گزارش می‌شود")
m(H, '!clean ? "skipped"', '!clean ? "failed"', "close-نشده با توقفِ ناتمیز failed می‌شود نه skipped")
m(H, 'closeResources === null ? "none"', 'closeResources === null ? "ok"', "نبودنِ closeResources ok گزارش می‌شود")
m(H, OK_LINE, 'const ok = clean && (closed === "none" || closed === "ok");', "مهلت‌خورده ok گزارش می‌شود")
m(H, OK_LINE, 'const ok = !timedOut && (closed === "none" || closed === "ok");', "توقفِ ناتمیز ok گزارش می‌شود")
m(H, OK_LINE, "const ok = clean && !timedOut;", "closeResourcesِ شکست‌خورده ok گزارش می‌شود")
m(H, OK_LINE, 'const ok = clean && !timedOut && closed === "ok";', "نبودنِ closeResources ok نیست")
m(H, 'handle = timer.after(() => resolve("timeout"), cfg.shutdownTimeoutMs);', 'handle = timer.after(() => resolve("timeout"), cfg.shutdownTimeoutMs + 1);', "مهلتِ خاموشی یک واحد دیرتر")
m(H, "// زمان‌سنجِ خراب مانعِ توقف نمی‌شود؛ فقط مهلت نداریم.", 'resolve("timeout");', "زمان‌سنجِ خراب خاموشی را بی‌توقف timedOut می‌کند")
m(H, "void work().then(() => {\n          if (armed) {", "void work().then(() => {\n          if (false) {", "تایمرِ مهلت پس از پایان لغو نمی‌شود")
m(H, '        state = "stopped";\n        removeSignals();', '        state = "stopped";', "شنونده‌ها پس از خاموشی برداشته نمی‌شوند")
m(H, '        state = "stopped";', '        state = "stopping";', "پس از خاموشی حالت stopped نمی‌شود")
m(H, "if (exitRequested) callExit(r.ok);", "callExit(r.ok);", "خاموشیِ دستی هم فرایند را می‌بُرد")
m(H, "      exitRequested = true; //", "      //", "پس از سیگنال exit صدا زده نمی‌شود")
m(H, "exit(ok ? 0 : 1);", "exit(0);", "خاموشیِ ناموفق با کدِ ۰ خارج می‌شود")
m(H, "exit(ok ? 0 : 1);", "exit(1);", "خاموشیِ موفق با کدِ ۱ خارج می‌شود")
m(H, "void shutdownInternal(sig);", 'void shutdownInternal("MANUAL");', "دلیلِ سیگنال ثبت نمی‌شود")
m(H, "Promise.resolve(out).then(undefined, () => undefined);", "", "ردِّ مشاهده‌گر خطای مدیریت‌نشده می‌سازد")
m(H, "if (observer === null) return;", "", "بدونِ مشاهده‌گر نادرست رفتار می‌کند")
m(H, "return typeof r === \"object\" && r !== null && r.clean === true;", "return typeof r === \"object\" && r !== null && r.clean !== false;", "clean نامعتبر تمیز شمرده می‌شود")
m(H, "      } catch {\n        return false;\n      }\n    }\n\n    async function run(", "      } catch {\n        return true;\n      }\n    }\n\n    async function run(", "stop که بپرتابد تمیز شمرده می‌شود")
m(H, 'if (state === "running") return Promise.resolve(bootSuccess as HostBootResult);', "", "boot پس از موفقیت دوباره start می‌زند (idempotent نیست)")
# ── probes.ts
m(P, 'const expected = sweep === "down" ? 503 : 200;', 'const expected = sweep === "down" ? 200 : 503;', "نگاشتِ httpStatus وارونه")
m(P, "consistent: http === expected", "consistent: true", "ناسازگاریِ سلامت و httpStatus نادیده گرفته می‌شود")
m(P, 'consistent && sweep !== "down"', "consistent", "down با ۵۰۳ هم‌سازگار ready=۲۰۰ می‌دهد")
m(P, 'consistent && sweep !== "down"', 'sweep !== "down"', "ناسازگاری ready را ۲۰۰ می‌کند")
m(P, 'if (state !== "running") return result("ready", false, state, null);', "", "ready در حالتِ غیر running هم ۲۰۰ می‌شود")
m(P, 'result("startup", hasBooted === true, state, null)', 'result("startup", true, state, null)', "startup همیشه ۲۰۰")
m(P, 'result("live", true, state, null)', 'result("live", state === "running", state, null)', "live به حالت وابسته می‌شود")
m(P, "!SWEEP.includes(status)", "false", "وضعیتِ ناشناختهٔ سلامت پذیرفته می‌شود")
m(P, "httpStatus: ok ? (200 as const) : (503 as const)", "httpStatus: ok ? (503 as const) : (200 as const)", "کدِ HTTP وارونه")
m(P, '"ready", kind === "live", "absent"', '"ready", true, "absent"', "پروبِ خراب ۲۰۰ می‌دهد")
m(P, '    return result("ready", false, "absent", null);\n  } catch', '    return result("ready", true, "absent", null);\n  } catch', "پروبِ ناشناخته ۲۰۰ می‌دهد")
# ── singleton.ts
m(S, 'Symbol.for("legal-platform.settlement-host")', 'Symbol.for("legal-platform.settlement-host.x")', "کلیدِ مشترکِ بین بسته‌ها تغییر می‌کند")
m(S, "return isHost(existing) ? { ok: true, value: existing, created: false } :", "return true ? { ok: true, value: existing as SettlementHost, created: false } :", "مقدارِ بیگانه به‌عنوان میزبان برگردانده می‌شود")
m(S, "      store[SETTLEMENT_HOST_STORE_KEY] = made.value;", "", "میزبانِ ساخته‌شده ذخیره نمی‌شود (singleton نیست)")
m(S, "if (store[SETTLEMENT_HOST_STORE_KEY] !== made.value) return", "if (false) return", "نوشتنِ بی‌صدا ناموفق موفق گزارش می‌شود")
m(S, "if (!isHost(made.value)) return", "if (false) return", "میزبانِ نامعتبر ذخیره می‌شود")
m(S, 'if (!isStore(store)) return hostError("INVALID_STORE", ["store باید شیء باشد."]);', "", "create پیش از اعتبارسنجیِ ظرف صدا زده می‌شود")
m(S, "hasBooted: false, readHealth: () => null", "hasBooted: true, readHealth: () => null", "بدونِ میزبان startup ۲۰۰ می‌دهد")
m(S, 'state: "absent", hasBooted', 'state: "idle", hasBooted', "نبودِ میزبان با idle اشتباه می‌شود")
m(S, 'kind === "ready")) return host.probes[kind]();', 'kind === "ready")) return host.probes.live();', "همهٔ پروب‌ها live می‌شوند")
m(S, 'hasFns((v as { probes: unknown }).probes, ["live", "startup", "ready"])', "true", "میزبانِ بی‌پروب پذیرفته می‌شود")
# ── config.ts
m(C, 'snap["shutdownTimeoutMs"] === undefined ?', 'snap["shutdownTimeoutMs"] == null ?', "shutdownTimeoutMs=null بی‌صدا پیش‌فرض می‌شود")
m(C, "isIntIn(shutdownTimeoutMs, 1, ", "isIntIn(shutdownTimeoutMs, 0, ", "shutdownTimeoutMs=۰ پذیرفته می‌شود")
m(C, "defaultShutdownTimeoutMs: 15_000", "defaultShutdownTimeoutMs: 16_000", "مهلتِ پیش‌فرضِ مستند تغییر می‌کند")
m(C, "maxShutdownTimeoutMs: 300_000", "maxShutdownTimeoutMs: 300_001", "سقفِ مهلتِ خاموشی یکی بالاتر")
m(C, "isIntIn(maxAttempts, 1, ", "isIntIn(maxAttempts, 0, ", "maxAttempts=۰ پذیرفته می‌شود")
m(C, "isIntIn(delayMs, 1, ", "isIntIn(delayMs, 0, ", "delayMs=۰ پذیرفته می‌شود (حلقهٔ داغ)")
m(C, 'if (rs["maxAttempts"] !== undefined) maxAttempts', 'if (rs["maxAttempts"] != null) maxAttempts', "maxAttempts=null بی‌صدا پیش‌فرض می‌شود")
m(C, 'if (rs["delayMs"] !== undefined) delayMs', 'if (rs["delayMs"] != null) delayMs', "delayMs=null بی‌صدا پیش‌فرض می‌شود")
m(C, "defaultBootAttempts: 1,", "defaultBootAttempts: 2,", "پیش‌فرضِ بازتلاش روشن می‌شود")
m(C, "defaultBootDelayMs: 1_000", "defaultBootDelayMs: 1_001", "فاصلهٔ پیش‌فرضِ مستند تغییر می‌کند")
m(C, "maxBootAttempts: 10", "maxBootAttempts: 11", "سقفِ تلاش یکی بالاتر")
m(C, "maxBootDelayMs: 60_000", "maxBootDelayMs: 60_001", "سقفِ فاصله یکی بالاتر")
m(C, 'if (signals !== false && !hasFns(signals, ["on", "off"]))', 'if (!hasFns(signals, ["on", "off"]))', "signals:false رد می‌شود")
m(C, 'if (signals !== false && !hasFns(signals, ["on", "off"]))', "if (false)", "signals نامعتبر/غایب پذیرفته می‌شود (شکستِ باز)")
m(C, 'issues.push(...unknownKeyIssues(rs, RETRY_KEYS, " (bootRetry)"));', "", "کلیدِ ناشناختهٔ bootRetry پذیرفته می‌شود")
m(C, ".slice(0, 40)", ".slice(0, 400)", "نامِ کلیدِ ناشناخته بریده نمی‌شود")
m(C, "if (exit !== undefined && !isFn(exit))", "if (false)", "exitِ غیرتابع پذیرفته می‌شود")
m(C, "if (closeResources !== undefined && !isFn(closeResources))", "if (false)", "closeResourcesِ غیرتابع پذیرفته می‌شود")
m(C, "if (observer !== undefined && !isFn(observer))", "if (false)", "observerِ غیرتابع پذیرفته می‌شود")
m(C, 'hasFns(runtime, ["start", "stop", "health"])', 'hasFns(runtime, ["start", "stop"])', "runtimeِ بی‌health پذیرفته می‌شود")
m(C, 'hasFns(timer, ["after", "cancel"])', 'hasFns(timer, ["after"])', "timerِ بی‌cancel پذیرفته می‌شود")
# ── node-process.ts
m(N, SIG_ON + "on(signal, listener)", SIG_ON + "off(signal, listener)", "on به off وصل است")
m(N, "off: (signal: HostSignal, listener: () => void): unknown => proc.off(signal, listener)", "off: (signal: HostSignal, listener: () => void): unknown => proc.on(signal, listener)", "off به on وصل است")
m(N, "proc.exit(code);", "proc.exit(0);", "کدِ خروج نادیده گرفته می‌شود")

# جهش‌های هم‌ارزِ توضیح‌داده‌شده (شمارهٔ جهش ← دلیل). هر ورودی باید دلیلِ رفتاریِ روشن داشته باشد.
EQUIVALENT: dict[int, str] = {
    # شمارهٔ جهش به‌صورتِ پویا از متنِ why پیدا می‌شود (پایین)؛ این‌جا فقط دلیل‌ها.
}
EQUIVALENT_BY_WHY = {
    "بدونِ مشاهده‌گر نادرست رفتار می‌کند": "بی‌این خط `observer(...)` روی null یک TypeError می‌دهد که همان `try/catch`ِ پیرامونش می‌گیرد؛ رفتارِ مشاهده‌پذیر یکی است (نگهبانِ ایمنی فقط برای وضوح و پرهیز از پرتابِ بیهوده).",
}
for _i, (_f, _o, _n, _why) in enumerate(M):
    if _why in EQUIVALENT_BY_WHY:
        EQUIVALENT[_i] = EQUIVALENT_BY_WHY[_why]

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
