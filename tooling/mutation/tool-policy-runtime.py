#!/usr/bin/env python3
"""
آزمون جهشی «ریشهٔ I/Oِ سیاستِ ابزار» (ماژول tool-policy-runtime؛ برش CT-5c-2c-2b-1، ADR-0073): هر جهش یک تغییر کوچکِ معنادار در منبعِ ماژول است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است (یا کدِ زائد).
اجرا:  python3 tooling/mutation/tool-policy-runtime.py            (همه)
       python3 tooling/mutation/tool-policy-runtime.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و پایگاهِ PostgreSQL (DATABASE_URL/KB_TEST_DATABASE_URL) برای آزمونِ PG. جزو CI نیست. فایل‌ها پس از هر جهش همیشه برمی‌گردند؛ فقط اولین رخدادِ متنِ اصلی جایگزین می‌شود.
دروازهٔ کامل را هم‌زمان با این اسکریپت اجرا نکنید (بارِ CPU آزمون‌های وابسته به زمان را می‌شکند).
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/tool-policy-runtime/"
TESTS = [B, "tooling/tool-policy-runtime-source.test.ts", "tooling/tool-policy-runtime.pg.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


RT, PG, CK = "runtime.ts", "pg-runtime.ts", "clock.ts"
# ── runtime.ts
m(RT, "handle = after(() => settle(UNAVAILABLE), deadlineMs);", "handle = after(() => settle(UNAVAILABLE), deadlineMs + 1);", "مهلتِ پیش‌بازرسی یک واحد بیشتر")
m(RT, "    } catch {\n      return UNAVAILABLE;\n    }\n    try {\n      Promise.resolve(runPreflight())", "    } catch {\n    }\n    try {\n      Promise.resolve(runPreflight())", "پیش‌بازرسیِ بی‌نگهبان اجرا می‌شود")
m(RT, "(v) => settle(classify(v)),", "(v) => settle({ ok: true } as never),", "هر نتیجهٔ پیش‌بازرسی موفق حساب می‌شود")
m(RT, "() => settle(UNAVAILABLE),\n      );", "() => settle({ ok: true } as never),\n      );", "ردِ پیش‌بازرسی موفق حساب می‌شود")
m(RT, "    try {\n      cancel(handle);", "    try {\n      void handle;", "نگهبانِ مهلت پس از پایان لغو نمی‌شود")
m(RT, "if (ok === true) return Object.freeze({ ok: true as const });", "if (ok) return Object.freeze({ ok: true as const });", "ok غیرِ true موفقیت حساب می‌شود")
m(RT, "if (ok !== false) return UNAVAILABLE;", "", "ok غیرِ false با کدِ معتبر شکستِ مشخص حساب می‌شود")
m(RT, "PREFLIGHT_CODES.includes(code)", "true", "هر کدِ رشته‌ای در پیش‌بازرسی پذیرفته می‌شود")
m(RT, "if (!pre.ok) {\n      state = \"IDLE\";", "if (!pre.ok) {", "شکستِ پیش‌بازرسی حالت را IDLE نمی‌کند")
m(RT, "return Object.freeze({ started: false as const, reason: pre.code });", "return Object.freeze({ started: false as const, reason: \"UNAVAILABLE\" as const });", "کدِ پیش‌بازرسی گم می‌شود")
m(RT, "if (started !== true) {\n      await stopRefresher();", "if (started !== true) {", "حلقهٔ نیمه‌زنده پاک‌سازی نمی‌شود")
m(RT, "if (started !== true) {", "if (started === undefined) {", "started غیرِ true موفقیت حساب می‌شود")
m(RT, "      state = \"IDLE\";\n      return Object.freeze({ started: false as const, reason: \"SCHEDULE_FAILED\" as const });", "      return Object.freeze({ started: false as const, reason: \"SCHEDULE_FAILED\" as const });", "شکستِ آغازِ حلقه حالت را IDLE نمی‌کند")
m(RT, "    state = \"RUNNING\";\n    return", "    return", "پس از آغازِ موفق RUNNING نمی‌شود")
m(RT, "if (state === \"STARTING\" || state === \"RUNNING\") return Promise.resolve(Object.freeze({ started: false as const, reason: \"ALREADY_STARTED\" as const }));", "", "start تکراری دومین پیش‌بازرسی می‌سازد")
m(RT, "if (state === \"STOPPING\") return Promise.resolve(Object.freeze({ started: false as const, reason: \"STOPPING\" as const }));", "", "start هنگامِ STOPPING پذیرفته می‌شود")
m(RT, "      state = \"STOPPING\";\n      generation += 1;", "      state = \"STOPPING\";", "نسل با stop جلو نمی‌رود")
m(RT, "if (stopPromise !== null) return stopPromise;", "", "stopهای هم‌زمان وعدهٔ جدا می‌گیرند")
m(RT, "if (state === \"IDLE\" || state === \"STOPPED\") return Promise.resolve(Object.freeze({ stopped: true as const, abandonedInFlight: false }));", "", "stop در IDLE به حلقه دست می‌زند")
m(RT, "if (mine !== generation) return", "if (false) return", "stop در میانهٔ start حلقه را راه می‌اندازد")
m(RT, "if (pendingStart !== null) await pendingStart;", "", "stop منتظرِ startِ در جریان نمی‌ماند")
m(RT, "        state = \"STOPPED\";\n        stopPromise = null;", "        state = \"STOPPED\";", "stopPromise پاک نمی‌شود (بازآغاز ممکن نیست)")
m(RT, "        state = \"STOPPED\";\n        stopPromise = null;", "        stopPromise = null;", "پس از stop حالت STOPPED نمی‌شود")
m(RT, "return member(r, \"abandonedInFlight\") !== false;", "return false;", "رهاسازیِ تلاش هرگز گزارش نمی‌شود")
m(RT, "return member(r, \"abandonedInFlight\") !== false;", "return member(r, \"abandonedInFlight\") === true;", "ناشناخته رهاشده حساب نمی‌شود")
m(RT, "    } catch {\n      return true;\n    }\n  }\n\n  async function doStart", "    } catch {\n      return false;\n    }\n  }\n\n  async function doStart", "پرتابِ stopِ حلقه رهاسازی گزارش نمی‌شود")
m(RT, "if (ok === true && typeof member(r, \"value\") === \"object\" && member(r, \"value\") !== null) return r;", "if (ok === true) return r;", "snapshotِ موفقِ بی‌مقدار پذیرفته می‌شود")
m(RT, "if (ok === false && typeof member(member(r, \"error\"), \"code\") === \"string\") return r;", "if (ok === false) return r;", "snapshotِ شکستِ بی‌کد پذیرفته می‌شود")
m(RT, "      } catch {\n        return NOT_LOADED;\n      }\n    },", "      } catch {\n        return { ok: true, value: {} } as never;\n      }\n    },", "پرتابِ snapshot موفقیت حساب می‌شود")
m(RT, "if (ref.state === \"halted\") return \"REFRESHER_HALTED\";", "", "حلقهٔ halted با منبعِ FRESH آماده حساب می‌شود")
m(RT, "if (ref.state !== \"running\") return \"HEALTH_UNAVAILABLE\";", "", "حلقهٔ idle/stopping در RUNNING آماده حساب می‌شود")
m(RT, "if (src === null || ref === null) return \"HEALTH_UNAVAILABLE\";", "", "سلامتِ ناشناخته آماده حساب می‌شود")
m(RT, "if (src.state === \"FRESH\") return null;\n  return src.state;", "return null;", "منبعِ STALE آماده حساب می‌شود")
m(RT, "if (state === \"IDLE\" || state === \"STOPPED\") return \"NOT_STARTED\";", "", "IDLE/STOPPED آماده حساب می‌شود")
m(RT, "if (state === \"STARTING\") return \"STARTING\";", "", "STARTING آماده حساب می‌شود")
m(RT, "if (state === \"STOPPING\") return \"STOPPING\";", "", "STOPPING آماده حساب می‌شود")
m(RT, "SOURCE_STATES.includes(st)) src = h;", "true) src = h;", "حالتِ ناشناختهٔ منبع پذیرفته می‌شود")
m(RT, "REFRESHER_STATES.includes(st)) ref = s;", "true) ref = s;", "حالتِ ناشناختهٔ حلقه پذیرفته می‌شود")
m(RT, "deadline < L.min || deadline > L.max", "deadline < L.min", "سقفِ preflightDeadlineMs سنجیده نمی‌شود")
m(RT, "deadline < L.min || deadline > L.max", "deadline > L.max", "کفِ preflightDeadlineMs سنجیده نمی‌شود")
m(RT, "!Number.isSafeInteger(deadline) ||", "", "اعشار برای preflightDeadlineMs پذیرفته می‌شود")
m(RT, "(afterFn as Fn).bind(timer)", "(afterFn as Fn)", "this زمان‌سنج (after) گم می‌شود")
m(RT, "(cancelFn as Fn).bind(timer)", "(cancelFn as Fn)", "this زمان‌سنج (cancel) گم می‌شود")
# ── pg-runtime.ts
m(PG, "else if (tuningOk && statementTimeoutMs > refreshTimeoutMs)", "else if (false)", "رابطهٔ statementTimeout≤refreshTimeout حذف می‌شود")
m(PG, "statementTimeoutMs > refreshTimeoutMs", "statementTimeoutMs >= refreshTimeoutMs", "رابطهٔ statementTimeout یک واحد سخت‌تر")
m(PG, "return explicit ?? Math.min(STORE_LIMITS.defaultTimeoutMs, refreshTimeoutMs);", "return explicit ?? STORE_LIMITS.defaultTimeoutMs;", "پیش‌فرضِ statementTimeout به refreshTimeout گره نمی‌خورد")
m(PG, "return explicit ?? Math.min(STORE_LIMITS.defaultTimeoutMs, refreshTimeoutMs);", "return explicit ?? Math.max(STORE_LIMITS.defaultTimeoutMs, refreshTimeoutMs);", "پیش‌فرضِ statementTimeout بیشینه به‌جای کمینه")
m(PG, "return explicit ?? Math.min(STORE_LIMITS.defaultTimeoutMs, refreshTimeoutMs);", "return Math.min(STORE_LIMITS.defaultTimeoutMs, refreshTimeoutMs);", "statementTimeoutِ صریح نادیده گرفته می‌شود")
m(PG, "const clock = got[\"clock\"] === undefined ? createMonotonicClock() : got[\"clock\"];", "const clock = got[\"clock\"] === undefined ? createSystemClock() : got[\"clock\"];", "ساعتِ پیش‌فرضِ منبع دیواری می‌شود")
m(PG, "preflightDeadlineMs: tuning[\"attemptDeadlineMs\"],", "preflightDeadlineMs: tuning[\"refreshTimeoutMs\"],", "مهلتِ پیش‌بازرسی از عددِ دیگری می‌آید")
m(PG, "maxStaleMs: tuning[\"maxStaleMs\"], refreshTimeoutMs }", "maxStaleMs: tuning[\"maxStaleMs\"], refreshTimeoutMs: tuning[\"attemptDeadlineMs\"] }", "منبع عددِ refreshTimeout دیگری می‌گیرد")
m(PG, "if (!hasFns(db, [\"execute\", \"transaction\"])) issues.push(\"db\");", "", "db بی‌execute/transaction پذیرفته می‌شود")
m(PG, "if (!hasFns(clock, [\"nowMs\"])) issues.push(\"clock\");", "", "clock بی‌nowMs پذیرفته می‌شود")
m(PG, "if (!hasFns(wallClock, [\"nowMs\"])) issues.push(\"wallClock\");", "", "wallClock بی‌nowMs پذیرفته می‌شود")
m(PG, "if (!hasFns(timer, [\"after\", \"cancel\"])) issues.push(\"timer\");", "", "timer بی‌after/cancel پذیرفته می‌شود")
m(PG, "if (schema !== undefined && typeof schema !== \"string\") issues.push(\"schema\");\n  else if (typeof schema === \"string\" && !createPgPolicyVersionStore(PROBE_DB, { schema }).ok) issues.push(\"schema\");", "if (schema !== undefined && typeof schema !== \"string\") issues.push(\"schema\");", "نامِ شِمای نامعتبر زود گرفته نمی‌شود")
m(PG, "for (const k of Object.keys(raw)) if (!(KEYS as readonly string[]).includes(k)) issues.push", "for (const k of Object.keys(raw)) if (false) issues.push", "کلیدِ ناشناخته پذیرفته می‌شود")
m(PG, "for (const k of Object.keys(t)) if (!(TUNING_KEYS as readonly string[]).includes(k)) issues.push", "for (const k of Object.keys(t)) if (false) issues.push", "کلیدِ ناشناختهٔ tuning پذیرفته می‌شود")
m(PG, "issues.push(`unknown:${k.length <= 40 ? k : \"?\"}`);\n    for (const k of KEYS)", "issues.push(`unknown:${k}`);\n    for (const k of KEYS)", "نامِ کلیدِ بلند بازتاب می‌شود")
m(PG, "for (const i of probe.error.issues) issues.push(`tuning:${i}`);", "", "مشکلاتِ tuning گزارش نمی‌شود")
m(PG, "if (!plain(raw)) return fail([\"options\"]);", "", "گزینهٔ غیرشیء پذیرفته می‌شود")
m(PG, "typeof owner === \"object\" && owner !== null && !Array.isArray(owner)", "typeof owner === \"object\" && owner !== null", "آرایه به‌عنوان شیء ساده پذیرفته می‌شود")
m(PG, "if (code === \"NOT_MIGRATED\") return \"NOT_MIGRATED\";", "", "NOT_MIGRATEDِ ذخیره‌ساز UNAVAILABLE می‌شود")
m(PG, "code === \"MIGRATION_TAMPERED\" ||", "", "MIGRATION_TAMPERED SCHEMA_MISMATCH نمی‌شود")
m(PG, "code === \"UNSAFE_SESSION\"", "false", "UNSAFE_SESSION SCHEMA_MISMATCH نمی‌شود")
m(PG, "  } catch {\n    return bad(\"UNAVAILABLE\");\n  }\n}", "  } catch {\n    return Object.freeze({ ok: true as const });\n  }\n}", "پرتابِ status موفقیت حساب می‌شود")
m(PG, "if (!exists || pending.length > 0) return bad(\"NOT_MIGRATED\");", "", "شِمای ناموجود/مهاجرتِ معلق NOT_MIGRATED نمی‌شود")
m(PG, "if (!exists || pending.length > 0)", "if (!exists)", "مهاجرتِ معلق NOT_MIGRATED نمی‌شود")
m(PG, "if (!exists || pending.length > 0)", "if (pending.length > 0)", "شِمای ناموجود NOT_MIGRATED نمی‌شود")
m(PG, "if (!ready || problems.length > 0 || !contiguous) return bad(\"SCHEMA_MISMATCH\");", "", "نگهبانِ خاموش/مشکل SCHEMA_MISMATCH نمی‌شود")
m(PG, "if (!ready || problems.length > 0 || !contiguous)", "if (problems.length > 0 || !contiguous)", "ready=false بی‌مشکل پذیرفته می‌شود")
m(PG, "if (!ready || problems.length > 0 || !contiguous)", "if (!ready || !contiguous)", "problems نادیده گرفته می‌شود")
m(PG, "if (!ready || problems.length > 0 || !contiguous)", "if (!ready || problems.length > 0)", "ناپیوستگی نادیده گرفته می‌شود")
m(PG, "if (ok !== true) return bad(\"UNAVAILABLE\");", "", "ok غیرِ true در status پذیرفته می‌شود")
m(PG, "typeof exists !== \"boolean\" ||", "", "schemaExists غیرِ بولی پذیرفته می‌شود")
m(PG, "!Array.isArray(pending) || !Array.isArray(problems)", "false", "pending/problems غیرِ آرایه پذیرفته می‌شود")
# ── clock.ts
m(CK, "Math.floor(now())", "now()", "ساعت عددِ صحیح نمی‌دهد")
m(CK, "() => performance.now()", "() => Date.now()", "ساعتِ پیش‌فرض دیواری می‌شود")


def run_tests():
    return subprocess.run(["npx", "vitest", "run", "--testTimeout=15000", *TESTS], cwd=ROOT, env=dict(os.environ), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode


def main():
    lo, hi = 1, len(M)
    if len(sys.argv) >= 3:
        lo, hi = int(sys.argv[1]), int(sys.argv[2])
    for i, (f, old, new, why) in enumerate(M, 1):
        src = open(os.path.join(ROOT, B + f), encoding="utf-8").read()
        if src.count(old) < 1:
            print(f"پیش‌بازرسی: جهش {i} ({f}) متنِ اصلی را پیدا نکرد: {old[:60]!r}")
            sys.exit(2)
    if run_tests() != 0:
        print("آزمون‌ها بدونِ جهش قرمزند؛ ابتدا درست کنید.")
        sys.exit(2)
    live = []
    for i, (f, old, new, why) in enumerate(M, 1):
        if not (lo <= i <= hi):
            continue
        path = os.path.join(ROOT, B + f)
        src = open(path, encoding="utf-8").read()
        try:
            open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
            killed = run_tests() != 0
        finally:
            open(path, "w", encoding="utf-8").write(src)
        print(f"{'کشته  ' if killed else 'زنده! '} {i:3d}  {f:14s} {why}", flush=True)
        if not killed:
            live.append((i, f, why))
    print(f"\nجمع: {hi - lo + 1} جهش، زنده: {len(live)}")
    for i, f, why in live:
        print(f"  زنده {i}: {f} — {why}")
    sys.exit(1 if live else 0)


if __name__ == "__main__":
    main()
