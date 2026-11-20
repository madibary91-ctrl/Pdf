#!/usr/bin/env python3
"""
آزمون جهشی «سیم‌کشیِ پایشِ پسماندِ زنگ در settlement-bootstrap» (برش م۳‑ه‑۴‑الف‑۲‑۲؛ ADR-0043): هر جهش یک تغییر کوچکِ معنادار در
`bootstrap.ts`، `http.ts` یا `env.ts` است؛ آزمون‌های همین ماژول (از جمله PostgreSQLِ واقعی برای مسیرِ موفقِ بوت) باید قرمز شوند.
اجرا:  DATABASE_URL=... python3 tooling/mutation/settlement-bootstrap-backlog.py          (همه)
       DATABASE_URL=... python3 tooling/mutation/settlement-bootstrap-backlog.py 3 9      (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22؛ پایگاهِ PostgreSQL برای `backlog.pg.test.ts` (بی‌آن جهش‌های چرخهٔ عمر زنده می‌مانند)؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متنِ اصلیِ هر جهش دقیقاً یک بار در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-bootstrap/"
TESTS = [B + n for n in ("bootstrap.test.ts", "env.test.ts", "http.test.ts", "env.backlog.test.ts", "http.backlog.test.ts", "backlog.test.ts", "backlog-source.test.ts", "backlog.pg.test.ts", "purity.test.ts")]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


K, H, N = "bootstrap.ts", "http.ts", "env.ts"

# ── bootstrap.ts: ساختن، شکست‌بسته، ثبت، چرخهٔ عمر
m(K, 'if (settings.backlog !== undefined) {\n    const outbox', 'if (true as boolean) {\n    const outbox', "پایش بی‌کلید هم ساخته می‌شود")
m(K, 'await closeQuietly(opened);\n      return failure("BACKLOG_INVALID", made.error.issues);', 'return failure("BACKLOG_INVALID", made.error.issues);', "شکستِ آستانه پایگاه را نمی‌بندد")
m(K, 'return failure("BACKLOG_INVALID", made.error.issues);', 'return failure("RUNTIME_INVALID", made.error.issues);', "کدِ شکستِ آستانه عوض می‌شود")
m(K, 'clock: createSystemClock(), timer, ...settings.backlog.overrides }', 'clock: createSystemClock(), timer }', "آستانه‌های env نادیده می‌مانند")
m(K, 'readyPolicy = settings.backlog.overrides["readyPolicy"] === "gate_down" ? "gate_down" : "report";', 'readyPolicy = "report";', "سیاستِ رویداد همیشه report است")
m(K, 'schema: settings.settlementSchema ?? SETTLEMENT_DEFAULT_SCHEMA', 'schema: SETTLEMENT_DEFAULT_SCHEMA', "شِمای outbox سفارشی نادیده می‌ماند")
m(K, '    closing = true;\n    if (watch === null || !watchStarted) return;', '    if (watch === null || !watchStarted) return;', "stop پرچمِ closing را نمی‌گذارد (بوتِ دیرهنگام پس از خاموشی شروع می‌کند)")
m(K, 'if (watch === null || !watchStarted) return;', 'if (watch === null) return;', "stopِ بی‌شروع رویدادِ stopped می‌دهد")
m(K, '    watchStarted = false;\n    try {\n      watch.stop();', '    try {\n      watch.stop();', "stop دوبار رویداد/توقف می‌دهد")
m(K, '    emit(cfg.log, { type: "bootstrap.backlog_watch", state: "stopped", readyPolicy });\n', '', "رویدادِ stopped حذف می‌شود")
m(K, 'if (watch === null || closing) return;', 'if (watch === null) return;', "پس از شروعِ خاموشی هنوز می‌تواند شروع کند")
m(K, '        watchStarted = true;\n', '        watchStarted = false;\n', "شروع ثبت نمی‌شود (stop هرگز صدا زده نمی‌شود)")
m(K, '        emit(cfg.log, { type: "bootstrap.backlog_watch", state: "started", readyPolicy });\n', '', "رویدادِ started حذف می‌شود")
m(K, 'if (event["type"] === "booted") startWatch();', 'if (event["type"] === "boot.failed") startWatch();', "پایش با شکستِ بوت شروع می‌شود، نه موفقیت")
m(K, 'else if (event["type"] === "shutdown.started") stopWatch();', 'else if (event["type"] === "shutdown.finished") stopWatch();', "توقفِ پایش تا پایانِ خاموشی دیر می‌شود")
m(K, '      stopWatch(); // پیش از بستنِ استخر', '      // پیش از بستنِ استخر', "closeResources پایش را نمی‌ایستاند")
m(K, '      cfg.store[BACKLOG_WATCH_STORE_KEY] = watch;\n', '', "پایش در ظرف ثبت نمی‌شود")
m(K, '      if (cfg.store[BACKLOG_WATCH_STORE_KEY] !== watch) throw new TypeError("store");\n', '', "ثبتِ بی‌صدا نادیده راستی‌آزمایی نمی‌شود")
m(K, 'watch = null; // ثبت نشد', 'void 0; // ثبت نشد', "پایشِ ثبت‌نشده باز هم شروع می‌شود")
m(K, '      emit(cfg.log, { type: "bootstrap.backlog_watch", state: "armed", readyPolicy });\n', '', "رویدادِ armed حذف می‌شود")
m(K, 'closeResources: () => {\n      stopWatch();', 'closeResources: () => {\n      void 0;', "closeResources پایش را نمی‌ایستاند (دومین مسیر)")
m(K, 'timer,\n    signals: cfg.signals', 'timer: createNodeTimer(),\n    signals: cfg.signals', "میزبان و پایش زمان‌سنجِ جدا می‌گیرند")

# ── http.ts: بدنه و سیاست
m(H, 'status: p.blocks ? 503 : r.httpStatus', 'status: r.httpStatus', "gate_down هرگز مسدود نمی‌کند")
m(H, 'ok: p.blocks ? false : r.body.ok', 'ok: r.body.ok', "بدنهٔ مسدودشده ok=true می‌ماند")
m(H, ', backlog: p.section }', ' }', "بخشِ backlog به بدنه نمی‌آید")
m(H, '    if (p.section === null) return plain;\n', '', "live هم بخشِ null می‌گیرد")
m(H, '    if (!w.present) return plain;\n', '', "بدونِ پایش هم بخشِ unknown می‌آید")
m(H, '    if (slot === undefined) return { present: false };\n', '', "ثبت‌نشده هم unknown شمرده می‌شود")
m(H, 'typeof slot["view"] !== "function") return { present: true, view: null };', 'typeof slot["view"] !== "function") return { present: false };', "ثبتِ خراب نادیده می‌ماند (نه unknown)")
m(H, '    } catch {\n      return { present: true, view: null };\n    }', '    } catch {\n      return { present: false };\n    }', "viewِ پرتاب‌کننده نادیده می‌ماند (نه unknown)")
m(H, '    return { present: false };\n  }\n}\n\nfunction withBacklog', '    return { present: true, view: null };\n  }\n}\n\nfunction withBacklog', "ظرفِ دشمنانه بخشِ unknown می‌افزاید")
m(H, 'projectBacklogForProbe(kind, w.view)', 'projectBacklogForProbe("ready", w.view)', "live هم به‌عنوانِ ready ارزیابی می‌شود")
m(H, 'const out = withBacklog(store, kind, r);', 'const out = { status: r.httpStatus, body: r.body as unknown };', "پایش هرگز به پاسخ نمی‌رسد")

# ── env.ts: کلید و آستانه‌ها
m(N, ', ENV_BACKLOG_WATCH, ...BACKLOG_NAMES]', ', ...BACKLOG_NAMES]', "کلیدِ پایش «ناشناخته» شمرده می‌شود")
m(N, ', ENV_BACKLOG_WATCH, ...BACKLOG_NAMES]', ', ENV_BACKLOG_WATCH]', "نام‌های آستانه «ناشناخته» شمرده می‌شوند")
m(N, 'else if (watchRaw === "on") watchOn = true;', 'else if (watchRaw === "on" || watchRaw === "ON") watchOn = true;', "ON بزرگ هم روشن می‌کند")
m(N, 'if (watchRaw === undefined || watchRaw === "" || watchRaw === "off") watchOn = false;\n    else if', 'if (watchRaw === undefined || watchRaw === "") watchOn = false;\n    else if', "off رد می‌شود")
m(N, '    else issues.push(`${ENV_BACKLOG_WATCH} باید on یا off باشد.`);\n', '', "مقدارِ نامعتبرِ کلید بی‌صدا خاموش می‌ماند")
m(N, '      else issues.push(...parsedWatch.error.issues);', '      else void 0;', "خطای آستانه گم می‌شود")
m(N, 'for (const name of BACKLOG_NAMES) sub[name] = read(name);', 'for (const name of BACKLOG_NAMES.slice(1)) sub[name] = read(name);', "یک آستانه خوانده نمی‌شود")
m(N, 'if (v !== undefined && v !== "") issues.push(', 'if (v !== undefined) issues.push(', "رشتهٔ خالص‌خالی هم خطا می‌شود")
m(N, '} else if (watchRaw === undefined || watchRaw === "" || watchRaw === "off") {', '} else {', "آستانهٔ تنظیم‌شده با کلیدِ نامعتبر هم جداگانه خطا می‌دهد")
m(N, 'for (const name of BACKLOG_NAMES) {\n        const v = read(name);', 'for (const name of []) {\n        const v = read(name as string);', "آستانهٔ بی‌کلید هرگز خطا نمی‌دهد")
m(N, 'Object.freeze(backlog === undefined ? base : { ...base, backlog })', 'Object.freeze({ ...base, backlog })', "کلیدِ backlog در حالتِ خاموش هم می‌آید")
m(N, 'backlog = Object.freeze({ overrides: parsedWatch.value });', 'backlog = { overrides: parsedWatch.value };', "backlog منجمد نیست")

m(K, 'if (!outbox.ok) {\n      await closeQuietly(opened);', 'if (!outbox.ok) {', "شاخهٔ ناممکنِ outbox پایگاه را نمی‌بندد")

# جهش‌های هم‌ارز (با دلیل): رفتارِ بیرونی یکی است.
EQUIVALENT = {
    len(M) - 1: "شاخهٔ ناممکن: `settlementSchema` را پیش‌تر `createPgSettlementRuntime` با همان `createPgSettlementOutbox` رد/پذیرفته؛ پس `!outbox.ok` در این نقطه هرگز رخ نمی‌دهد (فقط برای تنگ‌کردنِ نوع و دفاعِ آینده)",
}

env = dict(os.environ)


def tests_pass(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


if not env.get("DATABASE_URL") and not env.get("KB_TEST_DATABASE_URL"):
    print("DATABASE_URL (یا KB_TEST_DATABASE_URL) لازم است؛ بی‌آن آزمون‌های PostgreSQL رد می‌شوند و جهش‌های چرخهٔ عمر زنده می‌مانند."); sys.exit(2)
lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
sources = {f: open(os.path.join(ROOT, B, f), encoding="utf8").read() for f in {x[0] for x in M}}
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
    n = sources[f].count(old)
    if n != 1:
        print(f"[{i}] قطعه {n} بار در {f} هست (باید دقیقاً یک بار): {old[:80]!r}"); sys.exit(2)
    if new == old:
        print(f"[{i}] جهش بی‌اثر است: {why}"); sys.exit(2)
if not tests_pass(TESTS):
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, B, f)
    open(path, "w", encoding="utf8").write(sources[f].replace(old, new, 1))
    try:
        ok = tests_pass(TESTS)
    finally:
        open(path, "w", encoding="utf8").write(sources[f])
    if ok and i not in EQUIVALENT:
        alive.append((i, f, why)); print(f"[{i:02d}] ✗ زنده ({f}): {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
