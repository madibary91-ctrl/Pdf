#!/usr/bin/env python3
"""
آزمون جهشی «مرز برنامهٔ تسویه» (ماژول settlement-bootstrap؛ برش م۳‑ه‑۳‑ب، ADR-0033): هر جهش یک تغییر کوچکِ معنادار در منبعِ ماژول است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/settlement-bootstrap.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/settlement-bootstrap.py 3 9                    (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL (آزمون‌های integration.pg.test.ts بخشی از کشتنِ جهش‌ها هستند)؛ جزو CI نیست.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-bootstrap/"
TESTS = [B]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


E, BS, H = "env.ts", "bootstrap.ts", "http.ts"
# ── env.ts
m(E, 'host === undefined || host === "" || host === "off"', 'host === undefined || host === "off"', "SETTLEMENT_HOST خالی خطا می‌شود")
m(E, 'host === undefined || host === "" || host === "off"', 'host === "" || host === "off"', "نبودنِ SETTLEMENT_HOST خطا می‌شود")
m(E, 'if (host !== "on") return', 'if (String(host).toLowerCase() !== "on") return', "«ON» بی‌صدا روشن می‌کند")
m(E, "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /^[0-9]{1,10}$/;", "صفر و صفرِ آغازین پذیرفته می‌شود")
m(E, "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /^[1-9][0-9]{0,10}$/;", "عددِ ۱۱رقمی پذیرفته می‌شود")
m(E, "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /^[1-9][0-9]*$/;", "عددِ بی‌سقفِ رقم پذیرفته می‌شود")
m(E, "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /[1-9][0-9]{0,9}/;", "الگو بی‌لنگر است (1e3 و ۵ فاصله پذیرفته می‌شود)")
m(E, 'typeof v !== "string" || !DIGITS.test(v)', "!DIGITS.test(String(v))", "عددِ غیررشته‌ای پذیرفته می‌شود")
m(E, "if (required) issues.push", "if (false) issues.push", "graceMs الزامی نیست")
m(E, "k.startsWith(ENV_PREFIX) && !KNOWN.includes(k)", "false", "غلطِ تایپیِ نامِ متغیر دیده نمی‌شود")
m(E, "k.startsWith(ENV_PREFIX) && !KNOWN.includes(k)", "!KNOWN.includes(k)", "هر کلیدِ ناشناخته (حتی NODE_ENV) خطاست")
m(E, ".slice(0, 48)", ".slice(0, 4800)", "نامِ بلندِ کلید بی‌سقف در پیام می‌آید")
m(E, 'if (v === undefined || v === "") return null;\n      if (typeof v !== "string") {', 'if (v === undefined) return null;\n      if (typeof v !== "string") {', "شِمای خالی رشتهٔ خالی می‌شود نه نبودن")
m(E, 'if (typeof v !== "string") {\n        issues.push(`${name} باید رشته باشد.`);', 'if (false) {\n        issues.push(`${name} باید رشته باشد.`);', "شِمای غیررشته‌ای پذیرفته می‌شود")
m(E, "typeof raw !== \"object\" || raw === null || Array.isArray(raw)", "typeof raw !== \"object\" || raw === null", "env آرایه پذیرفته می‌شود")
m(E, "return { ok: true, value: Object.freeze({ enabled: false as const }) };", "return { ok: true, value: { enabled: false as const } };", "نتیجهٔ خاموش فریز نیست")
m(E, "return { ok: false, issues: Object.freeze([...issues]) };", "return { ok: false, issues };", "issuesِ شکست فریز نیست")
# ── bootstrap.ts
m(BS, 'if (!parsed.ok) return failure("INVALID_ENV", parsed.issues);', 'if (!parsed.ok) return Object.freeze({ status: "disabled" as const });', "env نامعتبر بی‌صدا خاموش حساب می‌شود")
m(BS, "if (!settings.enabled) return", "if (false) return", "حالتِ خاموش هم پایگاه باز می‌کند")
m(BS, "  if (existing !== null) return Object.freeze({ status: \"started\" as const, created: false, host: existing, booting: null });\n", "", "بوتِ دوم پایگاهِ تازه باز می‌کند")
m(BS, 'if (!isObj(o) || !isObj(o["db"]) || typeof o["close"] !== "function")', "if (!isObj(o))", "پایگاهِ بی‌db/close پذیرفته می‌شود")
m(BS, "deadLetters: false }", "deadLetters: true }", "زنگِ ماندگار بی‌deliver")
m(BS, 'if (settings.ledgerSchema !== null) rtConfig["ledgerSchema"]', 'if (false) rtConfig["ledgerSchema"]', "شِمای دفتر نادیده گرفته می‌شود")
m(BS, 'if (settings.settlementSchema !== null) rtConfig["settlementSchema"]', 'if (false) rtConfig["settlementSchema"]', "شِمای outbox نادیده گرفته می‌شود")
m(BS, "graceMs: settings.graceMs", "graceMs: 1000", "graceMs سخت‌کد")
m(BS, 'if (cfg.processOwner === "host") hostConfig["exit"]', 'if (true) hostConfig["exit"]', "دو exit رقیب (Next و ما)")
m(BS, 'if (cfg.processOwner === "host") hostConfig["exit"]', 'if (false) hostConfig["exit"]', "ما هرگز exit نمی‌زنیم حتی صاحبِ سیگنال")
m(BS, "closeResources: () => opened.close(),", "closeResources: () => undefined,", "استخر هرگز بسته نمی‌شود")
m(BS, '    await closeQuietly(opened);\n    return failure("RUNTIME_INVALID"', '    return failure("RUNTIME_INVALID"', "پایگاهِ باز پس از RUNTIME_INVALID نشت می‌کند")
m(BS, '    await closeQuietly(opened);\n    return failure("HOST_INVALID"', '    return failure("HOST_INVALID"', "پایگاهِ باز پس از HOST_INVALID نشت می‌کند")
m(BS, '    await closeQuietly(opened);\n    return failure("STORE_INVALID"', '    return failure("STORE_INVALID"', "پایگاهِ باز پس از STORE_INVALID نشت می‌کند")
m(BS, '    await closeQuietly(opened);\n    return Object.freeze({ status: "started" as const, created: false, host: acquired.value, booting: null });', '    return Object.freeze({ status: "started" as const, created: false, host: acquired.value, booting: null });', "پایگاهِ اضافهٔ مسابقه نشت می‌کند")
m(BS, "  return Object.freeze({ status: \"started\" as const, created: true, host: acquired.value, booting });", "  await booting;\n  return Object.freeze({ status: \"started\" as const, created: true, host: acquired.value, booting });", "سرور پشتِ بوتِ کُندِ پایگاه منتظر می‌ماند")
m(BS, 'type: "bootstrap.started", created: true, processOwner: cfg.processOwner', 'type: "bootstrap.started", created: true, processOwner: "host"', "لاگ صاحبِ خروج را دروغ می‌گوید")
m(BS, "if (inflight instanceof Promise) return inflight as Promise<BootstrapOutcome>;", "", "دو register هم‌زمان دو پایگاه باز می‌کنند")
m(BS, "if (cfg.store[INFLIGHT_KEY] === pending) delete cfg.store[INFLIGHT_KEY];", "", "نشانگرِ بوت پس از پایان پاک نمی‌شود (بازتلاش ناممکن)")
m(BS, "Promise.resolve(r).then(undefined, () => undefined);", "Promise.resolve(r);", "رد شدنِ لاگ unhandled rejection می‌شود")
m(BS, "  } catch {\n    // لاگِ خراب نباید بوت را بشکند.\n  }", "  } catch (e) {\n    throw e;\n  }", "لاگِ پرتاب‌کننده بوت را می‌شکند")
m(BS, 'if (processOwner !== "host" && processOwner !== "next") issues.push', 'if (false) issues.push', "processOwner نامعتبر پذیرفته می‌شود")
m(BS, "if (!known.includes(k)) issues.push", "if (false) issues.push", "کلیدِ ناشناختهٔ پیکربندی پذیرفته می‌شود")
m(BS, "timer: cfg.timer === undefined ? createNodeTimer() : cfg.timer,", "timer: createNodeTimer(),", "زمان‌سنجِ تزریقی نادیده گرفته می‌شود")
m(BS, 'signals: cfg.signals === undefined ? createNodeSignalSource() : cfg.signals,', "signals: createNodeSignalSource(),", "سیگنالِ تزریقی نادیده گرفته می‌شود")
m(BS, 'if (settings.shutdownTimeoutMs !== null) hostConfig["shutdownTimeoutMs"]', 'if (false) hostConfig["shutdownTimeoutMs"]', "مهلتِ خاموشی نادیده گرفته می‌شود")
m(BS, "maxAttempts: settings.bootAttempts", "maxAttempts: 1", "شمارِ تلاشِ بوت نادیده گرفته می‌شود")
m(BS, "delayMs: settings.bootRetryDelayMs", "delayMs: 1", "تأخیرِ بازتلاش نادیده گرفته می‌شود")
m(BS, 'observer: (event: unknown) => emit(cfg.log, { type: "host", event: event as never }),', "observer: () => undefined,", "رویدادهای host لاگ نمی‌شوند")
m(BS, '  } catch {\n    return failure("DATABASE_UNAVAILABLE", ["openDatabase پرتاب کرد."]);', '  } catch (e) {\n    return failure("DATABASE_UNAVAILABLE", [String((e as Error).message)]);', "پیامِ خطای پایگاه (رشتهٔ اتصال) در issues می‌نشیند")
# ── http.ts
m(H, 'if (kind !== "live" && kind !== "startup" && kind !== "ready") throw new TypeError("kind");', "", "kindِ ناشناخته به میزبان می‌رسد")
m(H, '"cache-control": "no-store"', '"cache-control": "max-age=60"', "پروب کش می‌شود")
m(H, "status: r.httpStatus", "status: 200", "ready همیشه ۲۰۰")
m(H, "JSON.stringify(r.body)", "JSON.stringify(r)", "بدنه بازتر از چهار کلیدِ بسته")
m(H, 'status: 503, headers: { ...HEADERS } });\n  }', 'status: 500, headers: { ...HEADERS } });\n  }', "شکستِ پروب ۵۰۳ نیست")
m(H, '"content-type": "application/json; charset=utf-8"', '"content-type": "text/plain"', "نوعِ محتوا JSON نیست")

# جهش‌های هم‌ارزِ توضیح‌داده‌شده (شمارهٔ جهش ← دلیل). هر ورودی باید دلیلِ رفتاریِ روشن داشته باشد.
EQUIVALENT: dict[int, str] = {
    # شمارهٔ جهش به‌صورتِ پویا از متنِ why پیدا می‌شود (پایین)؛ این‌جا فقط دلیل‌ها.
}
EQUIVALENT_BY_WHY: dict[str, str] = {}
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
