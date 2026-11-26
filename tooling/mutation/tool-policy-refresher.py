#!/usr/bin/env python3
"""
آزمون جهشی «حلقهٔ تازه‌سازیِ دوره‌ایِ سیاستِ ابزار» (ماژول tool-policy-refresher؛ برش CT-5c-2c-2a، ADR-0072): هر جهش یک تغییر کوچکِ معنادار در منبعِ ماژول است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است (یا کدِ زائد).
اجرا:  python3 tooling/mutation/tool-policy-refresher.py            (همه)
       python3 tooling/mutation/tool-policy-refresher.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22؛ بی‌پایگاه. جزو CI نیست. فایل‌ها پس از هر جهش همیشه برمی‌گردند؛ فقط اولین رخدادِ متنِ اصلی جایگزین می‌شود.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/tool-policy-refresher/"
TESTS = [B, "tooling/tool-policy-refresher-source.test.ts", "tooling/tool-policy-refresher-admin.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


RF, CF = "refresher.ts", "config.ts"
# ── refresher.ts
m(RF, "if (attempt.done) return;", "", "تلاش دوباره تسویه می‌شود (نتیجهٔ دیرهنگام اثر می‌گذارد)")
m(RF, "if (!fromWatchdog) safeCancel(attempt.watchdog);", "", "نگهبانِ مهلت پس از نتیجه لغو نمی‌شود")
m(RF, "inflight = null;\n    lastOutcome", "lastOutcome", "تلاشِ در جریان پاک نمی‌شود")
m(RF, "      failures = 0;\n      lastFailure = null;", "      lastFailure = null;", "شمارندهٔ شکست پس از موفقیت پاک نمی‌شود")
m(RF, "} else if (c.outcome !== \"superseded\") {", "} else {", "SUPERSEDED شکست حساب می‌شود")
m(RF, "      failures += 1;\n", "", "شکست شمرده نمی‌شود")
m(RF, "      lastFailure = c.code;", "", "کدِ آخرین شکست ثبت نمی‌شود")
m(RF, "if (phase === \"stopping\") {\n      phase = \"idle\";", "if (false) {\n      phase = \"idle\";", "پایانِ تلاش در stopping هنوز تلاشِ بعد می‌سازد")
m(RF, "abandonedInFlight: c.outcome === \"timed_out\"", "abandonedInFlight: false", "رهاسازیِ تلاش گزارش نمی‌شود")
m(RF, "abandonedInFlight: c.outcome === \"timed_out\"", "abandonedInFlight: true", "رهاسازی همیشه گزارش می‌شود")
m(RF, "schedule(c.outcome === \"ok\" ? intervalMs : retryMs);", "schedule(intervalMs);", "پس از شکست هم با intervalMs")
m(RF, "schedule(c.outcome === \"ok\" ? intervalMs : retryMs);", "schedule(retryMs);", "پس از موفقیت هم با retryMs")
m(RF, "nextHandle = after(() => onTick(mine), delayMs);", "nextHandle = after(() => onTick(mine), delayMs + 1);", "تیکِ بعد یک واحد دیرتر")
m(RF, "      hasNext = false;\n      halt();", "      hasNext = false;", "شکستِ زمان‌بندیِ تیک بی‌صدا")
m(RF, "if (phase !== \"running\" || mine !== generation) return;", "if (phase !== \"running\") return;", "تیکِ نسلِ قبل اجرا می‌شود")
m(RF, "if (phase !== \"running\" || mine !== generation) return;", "if (mine !== generation) return;", "تیکِ پس از stop اجرا می‌شود")
m(RF, "    hasNext = false;\n    if (!launch()) halt();", "    hasNext = false;\n    launch();", "شکستِ نگهبانِ تلاشِ تیک بی‌صدا")
m(RF, "attemptDeadlineMs);\n    } catch {\n      return false;", "attemptDeadlineMs + 1);\n    } catch {\n      return false;", "مهلتِ تلاش یک واحد بیشتر")
m(RF, "    } catch {\n      return false;\n    }\n    inflight = attempt;", "    } catch {\n    }\n    inflight = attempt;", "تلاشِ بی‌نگهبان آغاز می‌شود")
m(RF, "    inflight = attempt;\n    attempts += 1;", "    attempts += 1;", "تلاشِ در جریان ثبت نمی‌شود")
m(RF, "    attempts += 1;\n    new Promise", "    new Promise", "تلاش شمرده نمی‌شود")
m(RF, "() => settle(attempt, failed(\"REFRESH_THREW\"), false)", "() => settle(attempt, OK, false)", "ردِ وعده موفقیت حساب می‌شود")
m(RF, "if (ok === true) return OK;", "if (ok) return OK;", "ok غیرِ true موفقیت حساب می‌شود")
m(RF, "if (ok !== false) return failed(\"INVALID_RESULT\");", "", "ok غیرِ false با خطا شکستِ منبع حساب می‌شود")
m(RF, "if (code === \"SUPERSEDED\") return SUPERSEDED;", "", "SUPERSEDED شکست حساب می‌شود")
m(RF, "Object.prototype.hasOwnProperty.call(SOURCE_CODES, code)", "code in SOURCE_CODES", "کدِ prototype شناخته می‌شود")
m(RF, "    generation += 1;\n", "", "نسل با start جلو نمی‌رود")
m(RF, "    haltReason = null;\n    phase = \"running\";", "    phase = \"running\";", "haltReason پس از start پاک نمی‌شود")
m(RF, "if (phase === \"running\") return Object.freeze({ started: false, reason: \"ALREADY_RUNNING\" });", "", "start دوباره دومین تلاش می‌سازد")
m(RF, "if (phase === \"stopping\") return Object.freeze({ started: false, reason: \"STOPPING\" });", "", "start هنگامِ stopping پذیرفته می‌شود")
m(RF, "if (stopPromise !== undefined) return stopPromise;", "", "stopهای هم‌زمان وعدهٔ جدا می‌گیرند")
m(RF, "    if (hasNext) {\n      safeCancel(nextHandle);\n      hasNext = false;\n    }", "", "تیکِ بعد در stop لغو نمی‌شود")
m(RF, "if (inflight === null) {\n      phase = \"idle\";\n      haltReason = null;", "if (inflight === null) {\n      phase = \"idle\";", "haltReason در stop پاک نمی‌شود")
m(RF, "    phase = \"stopping\";\n    stopPromise", "    stopPromise", "stopping هرگز ثبت نمی‌شود")
m(RF, "inFlight: inflight !== null,", "inFlight: false,", "inFlight گزارش نمی‌شود")
m(RF, "    haltReason = \"SCHEDULE_FAILED\";", "    haltReason = null;", "دلیلِ halted گزارش نمی‌شود")
m(RF, "    phase = \"halted\";", "    phase = \"idle\";", "شکستِ زمان‌بندی halted نمی‌شود")
m(RF, "if (!launch()) {\n      halt();", "if (!launch()) {", "شکستِ نگهبانِ نخستین تلاش halted نمی‌کند")
m(RF, "} catch {\n      // قرارداد: cancel نمی‌پرتابد؛ پرتاب نباید حلقه را بشکند.\n    }", "} finally {\n    }", "پرتابِ cancel بیرون می‌زند")
m(RF, "new Promise<unknown>((resolve) => resolve(refresh())).then(", "Promise.resolve(refresh()).then(", "پرتابِ همگامِ refresh بیرون می‌زند")
m(RF, "const TIMED_OUT: Classified = Object.freeze({ outcome: \"timed_out\", code: \"TIMED_OUT\" });", "const TIMED_OUT: Classified = Object.freeze({ outcome: \"failed\", code: \"TIMED_OUT\" });", "تلاشِ بی‌پاسخ failed گزارش می‌شود")
# ── config.ts
m(CF, "retryMs > intervalMs", "retryMs >= intervalMs", "رابطهٔ retry≤interval یک واحد سخت‌تر")
m(CF, "retryMs > intervalMs", "false", "رابطهٔ retry≤interval حذف می‌شود")
m(CF, "refreshTimeoutMs > attemptDeadlineMs", "refreshTimeoutMs >= attemptDeadlineMs", "رابطهٔ refreshTimeout≤deadline یک واحد سخت‌تر")
m(CF, "refreshTimeoutMs > attemptDeadlineMs", "false", "رابطهٔ refreshTimeout≤deadline حذف می‌شود")
m(CF, "intervalMs + 3 * attemptDeadlineMs + retryMs > maxStaleMs", "intervalMs + 3 * attemptDeadlineMs + retryMs >= maxStaleMs", "رابطهٔ تحمل یک واحد سخت‌تر")
m(CF, "intervalMs + 3 * attemptDeadlineMs + retryMs > maxStaleMs", "intervalMs + 2 * attemptDeadlineMs + retryMs > maxStaleMs", "رابطهٔ تحمل فقط دو مهلت")
m(CF, "intervalMs + 3 * attemptDeadlineMs + retryMs > maxStaleMs", "intervalMs + 3 * attemptDeadlineMs > maxStaleMs", "رابطهٔ تحمل بی‌retry")
m(CF, "intervalMs + 3 * attemptDeadlineMs + retryMs > maxStaleMs", "false", "رابطهٔ تحمل حذف می‌شود")
m(CF, "okInterval && okRetry && okDeadline && okStale && ", "", "رابطهٔ تحمل بی‌نگهبانِ اعتبارِ عددها")
m(CF, "intervalMs: Object.freeze({ min: 1_000, max: 3_600_000 })", "intervalMs: Object.freeze({ min: 999, max: 3_600_000 })", "کفِ interval یک واحد کمتر")
m(CF, "intervalMs: Object.freeze({ min: 1_000, max: 3_600_000 })", "intervalMs: Object.freeze({ min: 1_000, max: 3_600_001 })", "سقفِ interval یک واحد بیشتر")
m(CF, "retryMs: Object.freeze({ min: 100, max: 3_600_000 })", "retryMs: Object.freeze({ min: 99, max: 3_600_000 })", "کفِ retry یک واحد کمتر")
m(CF, "retryMs: Object.freeze({ min: 100, max: 3_600_000 })", "retryMs: Object.freeze({ min: 100, max: 3_600_001 })", "سقفِ retry یک واحد بیشتر")
m(CF, "attemptDeadlineMs: Object.freeze({ min: 100, max: 300_000 })", "attemptDeadlineMs: Object.freeze({ min: 99, max: 300_000 })", "کفِ deadline یک واحد کمتر")
m(CF, "attemptDeadlineMs: Object.freeze({ min: 100, max: 300_000 })", "attemptDeadlineMs: Object.freeze({ min: 100, max: 300_001 })", "سقفِ deadline یک واحد بیشتر")
m(CF, "for (const k of Object.keys(options)) if (!(KEYS as readonly string[]).includes(k)) issues.push", "for (const k of Object.keys(options)) if (false) issues.push", "کلیدِ ناشناخته پذیرفته می‌شود")
m(CF, "issues.push(`unknown:${k.length <= 40 ? k : \"?\"}`)", "issues.push(`unknown:${k}`)", "نامِ کلیدِ بلند بازتاب می‌شود")
m(CF, "if (typeof refresh !== \"function\") issues.push(\"source.refresh\");", "", "source بی‌refresh پذیرفته می‌شود")
m(CF, "if (typeof after !== \"function\") issues.push(\"timer.after\");", "", "timer بی‌after پذیرفته می‌شود")
m(CF, "if (typeof cancel !== \"function\") issues.push(\"timer.cancel\");", "", "timer بی‌cancel پذیرفته می‌شود")
m(CF, "refresh: () => fnRefresh.call(source),", "refresh: () => fnRefresh.call(undefined),", "this منبع گم می‌شود")
m(CF, "after: (fn: () => void, ms: number) => fnAfter.call(timer, fn, ms),", "after: (fn: () => void, ms: number) => fnAfter.call(undefined, fn, ms),", "this زمان‌سنج (after) گم می‌شود")
m(CF, "cancel: (h: unknown) => void fnCancel.call(timer, h),", "cancel: (h: unknown) => void fnCancel.call(undefined, h),", "this زمان‌سنج (cancel) گم می‌شود")
m(CF, "Array.isArray(options)", "false", "آرایه به‌عنوان گزینه پذیرفته می‌شود")
m(CF, "typeof v === \"number\" && Number.isSafeInteger(v) && v >= r.min && v <= r.max", "typeof v === \"number\" && v >= r.min && v <= r.max", "اعشار/NaN-نما پذیرفته می‌شود")


def run_tests():
    return subprocess.run(["npx", "vitest", "run", "--testTimeout=8000", *TESTS], cwd=ROOT, env=dict(os.environ), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode


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
        print(f"{'کشته  ' if killed else 'زنده! '} {i:3d}  {f:12s} {why}", flush=True)
        if not killed:
            live.append((i, f, why))
    print(f"\nجهش‌ها: {hi - lo + 1}  زنده: {len(live)}")
    for i, f, why in live:
        print(f"  زنده: {i} {f} — {why}")
    sys.exit(1 if live else 0)


if __name__ == "__main__":
    main()
