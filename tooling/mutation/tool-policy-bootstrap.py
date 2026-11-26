#!/usr/bin/env python3
"""
آزمون جهشیِ «مرزِ برنامهٔ سیاستِ ابزار» (ماژول tool-policy-bootstrap + اجارهٔ استخر `src/db/pool-lease.ts` + خروجِ هماهنگ `src/process-exit.ts`؛
برش CT‑5c‑2c‑2b‑3b، ADR-0076): هر جهش یک تغییر کوچکِ معنادار در منبع است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  python3 tooling/mutation/tool-policy-bootstrap.py            (همه)
       python3 tooling/mutation/tool-policy-bootstrap.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22. آزمون‌های این بخش به پایگاه نیاز ندارند؛ جزو CI نیست. فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/tool-policy-bootstrap/"
TESTS = [B, "src/db/pool-lease.test.ts", "src/process-exit.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


BS, EN, HT = B + "bootstrap.ts", B + "env.ts", B + "http.ts"
PL, PE = "src/db/pool-lease.ts", "src/process-exit.ts"
# ── bootstrap.ts
m(BS, 'if (!parsed.ok) return failure("INVALID_ENV", parsed.issues);', "", "envِ نامعتبر نادیده گرفته می‌شود")
m(BS, 'if (!settings.enabled) return Object.freeze({ status: "disabled" as const });', "", "خاموش هم ادامه می‌دهد")
m(BS, "if (existing !== null) return Object.freeze", "if (false) return Object.freeze", "میزبانِ موجود دوباره ساخته می‌شود")
m(BS, '!isObj(o["db"]) || ', "", "openDatabase بی‌db پذیرفته می‌شود")
m(BS, ' || typeof o["close"] !== "function"', "", "openDatabase بی‌close پذیرفته می‌شود")
m(BS, '    await closeQuietly(opened);\n    return failure("RUNTIME_INVALID", runtime.error.issues);', '    return failure("RUNTIME_INVALID", runtime.error.issues);', "شکستِ ریشه اجاره را پس نمی‌دهد")
m(BS, '    await closeQuietly(opened);\n    return failure("HOST_INVALID", made.error.issues);', '    return failure("HOST_INVALID", made.error.issues);', "شکستِ میزبان اجاره را پس نمی‌دهد")
m(BS, '    await closeQuietly(opened);\n    return failure("STORE_INVALID", acquired.error.issues);', '    return failure("STORE_INVALID", acquired.error.issues);', "شکستِ ظرف اجاره را پس نمی‌دهد")
m(BS, "    await closeQuietly(opened);\n    return Object.freeze({ status: \"started\" as const, created: false, host: acquired.value, booting: null });", "    return Object.freeze({ status: \"started\" as const, created: false, host: acquired.value, booting: null });", "اجارهٔ اضافهٔ مسابقه پس داده نمی‌شود")
m(BS, 'const give = typeof opened.release === "function" ? opened.release : opened.close;', "const give = opened.close;", "شکستِ بوت استخرِ مشترک را می‌بندد (release نادیده)")
m(BS, 'const give = typeof opened.release === "function" ? opened.release : opened.close;', "const give = opened.release as () => unknown;", "بی‌release هیچ پس‌دادنی نیست")
m(BS, 'if (cfg.processOwner === "host") hostConfig["exit"]', 'if (true) hostConfig["exit"]', "صاحبِ next هم exit می‌زند")
m(BS, 'if (cfg.processOwner === "host") hostConfig["exit"]', 'if (false) hostConfig["exit"]', "صاحبِ host هرگز exit نمی‌زند")
m(BS, "closeResources: () => opened.close(),", "closeResources: () => undefined,", "خاموشی پایگاه را نمی‌بندد")
m(BS, 'if (settings.schema !== null) rtConfig["schema"] = settings.schema;', "", "شِمای env به ریشه نمی‌رسد")
m(BS, 'if (settings.statementTimeoutMs !== null) rtConfig["statementTimeoutMs"] = settings.statementTimeoutMs;', "", "سقفِ سمتِ پایگاه به ریشه نمی‌رسد")
m(BS, 'if (settings.shutdownTimeoutMs !== null) hostConfig["shutdownTimeoutMs"] = settings.shutdownTimeoutMs;', "", "مهلتِ خاموشی به میزبان نمی‌رسد")
m(BS, "...(settings.bootAttempts !== null ? { maxAttempts: settings.bootAttempts } : {}),", "", "تعدادِ تلاشِ بوت به میزبان نمی‌رسد")
m(BS, "...(settings.bootRetryDelayMs !== null ? { delayMs: settings.bootRetryDelayMs } : {}),", "", "تأخیرِ بازتلاش به میزبان نمی‌رسد")
m(BS, "tuning: { ...settings.tuning }, timer };", "tuning: { ...settings.tuning } };", "زمان‌سنجِ تزریقی به ریشه نمی‌رسد")
m(BS, "const rtConfig: Record<string, unknown> = { db: opened.db, tuning: { ...settings.tuning }, timer };", "const rtConfig: Record<string, unknown> = { db: opened.db, tuning: { ...settings.tuning, intervalMs: 1000 }, timer };", "tuning در مسیر دست‌کاری می‌شود")
m(BS, "if (inflight instanceof Promise) return inflight as Promise<BootstrapOutcome>;", "", "دو فراخوانیِ هم‌زمان دو پایگاه باز می‌کنند")
m(BS, "if (cfg.store[INFLIGHT_KEY] === pending) delete cfg.store[INFLIGHT_KEY];", "", "نشانگرِ در جریان پاک نمی‌شود")
m(BS, 'emit(cfg.log, { type: "bootstrap.started", created: true, processOwner: cfg.processOwner });', "", "رویدادِ started نمی‌آید")
m(BS, 'if (outcome.status === "disabled") emit(cfg.log, { type: "bootstrap.disabled" });', "", "رویدادِ disabled نمی‌آید")
m(BS, 'else if (outcome.status === "failed") emit(cfg.log, { type: "bootstrap.failed", code: outcome.code, issues: outcome.issues });', "", "رویدادِ failed نمی‌آید")
m(BS, "signals: cfg.signals === undefined ? createNodeSignalSource() : cfg.signals,", "signals: createNodeSignalSource(),", "منبعِ سیگنالِ تزریقی نادیده گرفته می‌شود")
m(BS, 'observer: (event: unknown) => emit(cfg.log, { type: "host", event: event as never }),', "observer: () => undefined,", "رویدادهای میزبان لاگ نمی‌شوند")
m(BS, 'if (processOwner !== "host" && processOwner !== "next") issues.push("processOwner باید host یا next باشد.");', "", "processOwner نامعتبر پذیرفته می‌شود")
m(BS, 'if (typeof openDatabase !== "function") issues.push("openDatabase باید تابع باشد.");', "", "openDatabase غیرتابع پذیرفته می‌شود")
m(BS, 'for (const k of Object.keys(r)) if (!known.includes(k)) issues.push(', "for (const k of []) if (!known.includes(k)) issues.push(", "کلیدِ ناشناختهٔ پیکربندی پذیرفته می‌شود")
m(BS, "const timer = cfg.timer === undefined ? createNodeTimer() : cfg.timer;", "const timer = createNodeTimer();", "زمان‌سنجِ تزریقی نادیده گرفته می‌شود")
# ── env.ts
m(EN, 'if (host !== "on") return { ok: false, issues: [`${ENV_HOST} باید on یا off باشد.`] };', "", "مقدارِ غیرِ on/off روشن حساب می‌شود")
m(EN, 'host === undefined || host === "" || host === "off"', 'host === undefined || host === "off"', "رشتهٔ خالی خاموش نیست")
m(EN, 'host === undefined || host === "" || host === "off"', 'host === "" || host === "off"', "نبودنِ متغیر خاموش نیست")
m(EN, "if (!KNOWN.includes(k)) issues.push(", "if (false) issues.push(", "کلیدِ ناشناختهٔ TOOL_POLICY_* پذیرفته می‌شود")
m(EN, "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /^[0-9]{1,10}$/;", "صفر و صفرِ آغازین پذیرفته می‌شود")
m(EN, "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /^[1-9][0-9]{0,10}$/;", "یازده رقم پذیرفته می‌شود")
m(EN, "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /[1-9][0-9]{0,9}/;", "نویسهٔ اضافه/فاصله پذیرفته می‌شود")
m(EN, 'if (typeof v !== "string" || !DIGITS.test(v)) {', "if (!DIGITS.test(String(v))) {", "غیررشتهٔ عددی پذیرفته می‌شود")
m(EN, "const intervalMs = intVar(ENV_INTERVAL_MS, true);", "const intervalMs = intVar(ENV_INTERVAL_MS, false);", "INTERVAL_MS اختیاری می‌شود")
m(EN, "const retryMs = intVar(ENV_RETRY_MS, true);", "const retryMs = intVar(ENV_RETRY_MS, false);", "RETRY_MS اختیاری می‌شود")
m(EN, "const attemptDeadlineMs = intVar(ENV_ATTEMPT_DEADLINE_MS, true);", "const attemptDeadlineMs = intVar(ENV_ATTEMPT_DEADLINE_MS, false);", "ATTEMPT_DEADLINE_MS اختیاری می‌شود")
m(EN, "const refreshTimeoutMs = intVar(ENV_REFRESH_TIMEOUT_MS, true);", "const refreshTimeoutMs = intVar(ENV_REFRESH_TIMEOUT_MS, false);", "REFRESH_TIMEOUT_MS اختیاری می‌شود")
m(EN, "const maxStaleMs = intVar(ENV_MAX_STALE_MS, true);", "const maxStaleMs = intVar(ENV_MAX_STALE_MS, false);", "MAX_STALE_MS اختیاری می‌شود")
m(EN, "if (issues.length > 0 || intervalMs === null", "if (intervalMs === null", "با مشکل هم موفق می‌شود")
m(EN, 'if (typeof schemaRaw !== "string") issues.push(`${ENV_SCHEMA} باید رشته باشد.`);', "if (false) issues.push(`${ENV_SCHEMA} باید رشته باشد.`);", "schema غیررشته پذیرفته می‌شود")
m(EN, ".slice(0, 48)", "", "نامِ بلندِ ناشناخته کوتاه نمی‌شود")
m(EN, ".replace(/[^\\x20-\\x7e]/g, \"?\")", "", "نویسهٔ غیرِ چاپ‌پذیر در پیام می‌آید")
m(EN, "const statementTimeoutMs = intVar(ENV_STATEMENT_TIMEOUT_MS, false);", "const statementTimeoutMs = null;", "STATEMENT_TIMEOUT_MS خوانده نمی‌شود")
m(EN, "for (const k of Object.keys(src)) if (k.startsWith(ENV_PREFIX)) snap.set(k, src[k]);", "for (const k of Object.keys(src)) snap.set(k, src[k]);", "کلیدهای بی‌پیشوند هم ناشناخته حساب می‌شوند")
# ── http.ts
m(HT, "if ((status !== 200 && status !== 503) || ", "if (", "کدِ وضعیتِ دلخواهِ میزبان عبور می‌کند")
m(HT, "if (typeof b.ok !== \"boolean\" || b.ok !== (status === 200)) return unavailable();", "if (typeof b.ok !== \"boolean\") return unavailable();", "پاسخِ ناهمسازِ ok/status عبور می‌کند")
m(HT, "if (typeof b.state !== \"string\" || (b.reason !== null && typeof b.reason !== \"string\")) return unavailable();", "", "state/reason نامعتبر عبور می‌کند")
m(HT, "JSON.stringify({ probe: kind, ok: b.ok, state: b.state, reason: b.reason })", "JSON.stringify({ ...b, probe: kind })", "کلیدِ اضافهٔ میزبان درز می‌کند")
m(HT, '"cache-control": "no-store"', '"cache-control": "max-age=60"', "پاسخ کش می‌شود")
m(HT, 'if (kind !== "live" && kind !== "startup" && kind !== "ready") return unavailable();', "", "kindِ ناشناخته به میزبان می‌رسد")
# ── pool-lease.ts
m(PL, 'if (st.ending) throw new Error("POOL_ENDED");', "", "اجاره پس از بستنِ استخر ممکن است")
m(PL, "        if (st.count > 0) done = Promise.resolve();", "        if (false) done = Promise.resolve();", "هر close استخر را می‌بندد")
m(PL, "          st.ending = true;\n", "", "اجارهٔ هم‌زمان با بسته‌شدن ممکن است")
m(PL, "    release: (): void => {\n      if (done === null) {\n        st.count -= 1;", "    release: (): void => {\n      if (done === null) {", "release شمارنده را کم نمی‌کند")
m(PL, "        done = Promise.resolve().then(() => p.end()).then(() => undefined);", "        done = Promise.resolve().then(() => void p.end());", "خطای ناهمگامِ end بلعیده می‌شود")
m(PL, 'typeof (pool as Partial<Ender>).end !== "function"', "false", "استخرِ بی‌end پذیرفته می‌شود")
m(PL, "  st.count += 1;", "", "اجاره شمرده نمی‌شود")
m(PL, "  return Object.freeze({\n    close", "  return ({\n    close", "اجاره یخ‌زده نیست")
# ── process-exit.ts
m(PE, "realExit(Math.max(...codes));", "realExit(Math.min(...codes));", "شکستِ یکی با موفقیتِ دیگری پنهان می‌شود")
m(PE, "realExit(Math.max(...codes));", "realExit(code);", "کدِ فراخوان‌نده‌ی آخر جایگزینِ بیشینه می‌شود")
m(PE, "Number.isInteger(code) ? code : 1", "code", "کدِ نامعتبر عبور می‌کند")
m(PE, "if (waiting) return;", "", "هم‌تای در حالِ خاموشی منتظر گذاشته نمی‌شود")
m(PE, "waiting = false; // پرسشِ خراب", "waiting = true; // پرسشِ خراب", "هم‌تای خراب منتظرِ همیشگی می‌شود")

EQUIVALENT = {}

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
