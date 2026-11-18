#!/usr/bin/env python3
"""
آزمون جهشی حلقهٔ رفتگر settlement (برش م۳‑ج؛ ADR-0023): هر جهش یک تغییر کوچکِ معنادار در کد منبع است؛ مجموعهٔ آزمون باید قرمز شود (جهش «کشته شود»).
اجرا:  python3 tooling/mutation/settlement-loop.py            (همه)
       python3 tooling/mutation/settlement-loop.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و پایگاه (DATABASE_URL یا KB_TEST_DATABASE_URL) برای آزمونِ PostgreSQL؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل‌ها هست؛ فایل اصلی پس از هر جهش همیشه برمی‌گردد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = "src/modules/settlement/"
TESTS = [D + "loop-policy.test.ts", D + "sweep-loop.test.ts", D + "sweep-loop.integration.test.ts", D + "sweep-loop.pg.test.ts", D + "purity.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


# ── loop-policy.ts: تأخیر
m("loop-policy.ts", "Math.max(consecutiveFailures - 1, 0)", "consecutiveFailures", "نخستین شکست هم دو برابر می‌شود")
m("loop-policy.ts", "Math.min(policy.maxBackoffMs, policy.intervalMs * 2 ** exponent)", "policy.intervalMs * 2 ** exponent", "عقب‌نشینی بی‌سقف")
m("loop-policy.ts", "return { delayMs: Math.min(policy.maxBackoffMs, policy.intervalMs * 2 ** exponent), drainRuns: 0 };", "return { delayMs: Math.min(policy.maxBackoffMs, policy.intervalMs * 2 ** exponent), drainRuns };", "شکست شمارندهٔ تخلیه را صفر نمی‌کند")
m("loop-policy.ts", "outcome === \"progress\" && drainRuns < policy.maxDrainRuns", "outcome === \"progress\"", "تخلیهٔ بی‌سقف (حلقهٔ داغ)")
m("loop-policy.ts", "drainRuns < policy.maxDrainRuns", "drainRuns <= policy.maxDrainRuns", "تخلیه یک گذر بیش از سقف")
m("loop-policy.ts", "return { delayMs: 0, drainRuns: drainRuns + 1 };", "return { delayMs: 0, drainRuns };", "شمارندهٔ تخلیه نمی‌شمارد")
m("loop-policy.ts", "return { delayMs: policy.intervalMs, drainRuns: 0 };", "return { delayMs: policy.intervalMs, drainRuns };", "فاصلهٔ عادی شمارندهٔ تخلیه را صفر نمی‌کند")
m("loop-policy.ts", "return { delayMs: policy.intervalMs, drainRuns: 0 };", "return { delayMs: 0, drainRuns: 0 };", "گذرِ بیکار بی‌انتظار")
m("loop-policy.ts", "  if (report.listFailed) return \"LIST_FAILED\";\n", "", "listFailed شکست نیست")
m("loop-policy.ts", "if (report.outboxFailures > 0) return \"OUTBOX_FAILURES\";", "if (report.outboxFailures > 1) return \"OUTBOX_FAILURES\";", "یک خطای outbox نادیده")
m("loop-policy.ts", "report.settled > 0 || report.buried.length > 0", "report.settled > 0", "مرگ پیشرفت نیست")
m("loop-policy.ts", "report.settled > 0 || report.buried.length > 0", "report.buried.length > 0", "تسویه پیشرفت نیست")
m("loop-policy.ts", "report.settled > 0 || report.buried.length > 0", "report.settled > 0 || report.buried.length > 0 || report.retryLater > 0", "retryLater پیشرفت شمرده می‌شود")
m("loop-policy.ts", "buried.length > MAX_BURIED", "false", "بی‌سقفِ اندازهٔ گزارش")
m("loop-policy.ts", "typeof listFailed !== \"boolean\"", "false", "listFailed اعتبارسنجی نمی‌شود")
m("loop-policy.ts", "v.length > 0 && v.length <= 256", "v.length <= 256", "شناسهٔ تهی")
m("loop-policy.ts", "v.length <= 256", "v.length <= 257", "طولِ شناسه")
m("loop-policy.ts", "typeof reason !== \"string\" || !REASONS.has(reason)", "typeof reason !== \"string\"", "دلیلِ مرگ اعتبارسنجی نمی‌شود")
m("loop-policy.ts", "if (errorCode !== null && !isShort(errorCode)) return null;", "", "errorCode اعتبارسنجی نمی‌شود")
m("loop-policy.ts", "Number.isSafeInteger(v) && v >= 0", "Number.isInteger(v) && v >= 0", "عددِ ناامن")
m("loop-policy.ts", "Number.isSafeInteger(v) && v >= 0", "Number.isSafeInteger(v)", "عددِ منفی")
m("loop-policy.ts", "buried: Object.freeze(items), listFailed })", "buried: items, listFailed })", "buriedِ گزارش منجمد نیست")
m("loop-policy.ts", "return Object.freeze({ tenantId, accountId, reservationId, reason: reason as DeadReason, errorCode });", "return { tenantId, accountId, reservationId, reason: reason as DeadReason, errorCode };", "عضوِ buried منجمد نیست")
m("loop-policy.ts", "const { tenantId, accountId, reservationId, reason, errorCode } = raw;\n  if (!isShort(tenantId)", "const { tenantId, accountId, reservationId, reason, errorCode } = raw;\n  if (true || !isShort(tenantId)", "شناسه‌ها اعتبارسنجی نمی‌شوند")

# ── sweep-loop.ts
S = "sweep-loop.ts"
m(S, "if (token !== armSeq || !armed) return;", "if (!armed) return;", "تایمرِ کهنه/دوباره‌صداشده زنجیرِ دوم می‌سازد")
m(S, "if (!running || gen !== generation || busy) return;", "if (!running || gen !== generation) return;", "هم‌پوشانیِ گذر (بی‌تک‌پرواز)")
m(S, "fault = report === null ? \"BAD_REPORT\" : faultOf(report);", "fault = report === null ? \"SWEEP_THREW\" : faultOf(report);", "نوعِ خطای گزارش نامعتبر")
m(S, "      fault = \"SWEEP_THREW\";\n    }", "      fault = \"BAD_REPORT\";\n    }", "نوعِ خطای پرتاب")
m(S, "runs = cap(runs + 1);", "runs = runs;", "شمارندهٔ گذر")
m(S, "lastRunAtMs = atMs;", "lastRunAtMs = lastRunAtMs;", "lastRunAtMs ثبت نمی‌شود")
m(S, "totals.examined = cap(totals.examined + report.examined);", "totals.examined = cap(totals.examined + 0);", "جمعِ examined")
m(S, "totals.settled = cap(totals.settled + report.settled);", "totals.settled = cap(totals.settled + 0);", "جمعِ settled")
m(S, "totals.retryLater = cap(totals.retryLater + report.retryLater);", "totals.retryLater = cap(totals.retryLater + 0);", "جمعِ retryLater")
m(S, "totals.raced = cap(totals.raced + report.raced);", "totals.raced = cap(totals.raced + 0);", "جمعِ raced")
m(S, "totals.outboxFailures = cap(totals.outboxFailures + report.outboxFailures);", "totals.outboxFailures = cap(totals.outboxFailures + 0);", "جمعِ outboxFailures")
m(S, "totals.buried = cap(totals.buried + report.buried.length);", "totals.buried = cap(totals.buried + 0);", "جمعِ buried")
m(S, "const cap = (n: number): number => (n > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : n);", "const cap = (n: number): number => n;", "سرریزِ شمارنده")
m(S, "      consecutiveFailures = 0;\n      lastSuccessAtMs = atMs;", "      lastSuccessAtMs = atMs;", "بهبود شمارندهٔ شکست را صفر نمی‌کند")
m(S, "      consecutiveFailures = 0;\n      lastSuccessAtMs = atMs;", "      consecutiveFailures = 0;", "lastSuccessAtMs ثبت نمی‌شود")
m(S, "consecutiveFailures = cap(consecutiveFailures + 1);", "consecutiveFailures = 1;", "شکستِ پیاپی نمی‌شمارد")
m(S, "const outcome: RunOutcome = fault !== null ? \"unhealthy\"", "const outcome: RunOutcome = fault !== null ? \"idle\"", "شکست عقب‌نشینی نمی‌آورد")
m(S, "hasProgress(report) ? \"progress\" : \"idle\"", "false ? \"progress\" : \"idle\"", "تخلیه هرگز")
m(S, "drainRuns = next.drainRuns;", "", "شمارندهٔ تخلیه ذخیره نمی‌شود")
m(S, "    busy = false;\n\n    let nextDelayMs", "\n    let nextDelayMs", "busy هرگز پاک نمی‌شود")
m(S, "    if (running && gen === generation) {", "    if (true) {", "گذرِ کهنه/متوقف دوباره زمان‌بندی می‌کند")
m(S, "        running = false;\n        stalled = true;", "        stalled = true;", "شکستِ زمان‌بندی حلقه را متوقف نمی‌کند")
m(S, "        running = false;\n        stalled = true;", "        running = false;", "stalled اعلام نمی‌شود")
m(S, "if (report !== null && report.buried.length > 0) {", "if (report !== null && report.buried.length > 1) {", "زنگِ یک مرگ")
m(S, "if (report !== null && report.buried.length > 0) {", "if (report !== null && report.buried.length > 0 && running) {", "زنگِ مرگ پس از stop گم می‌شود")
m(S, "if (fault !== null) emitFault(fault, nextDelayMs);", "", "خطای گذر اعلام نمی‌شود")
m(S, "if (scheduleFailed) emitFault(\"SCHEDULE_FAILED\", null);", "", "SCHEDULE_FAILED میانِ کار اعلام نمی‌شود")
m(S, "          emitFault(\"SCHEDULE_FAILED\", null);\n          return { started: false, reason: \"SCHEDULE_FAILED\" };", "          return { started: false, reason: \"SCHEDULE_FAILED\" };", "SCHEDULE_FAILED در start اعلام نمی‌شود")
m(S, "        if (busy) return { started: false, reason: \"PREVIOUS_RUN_ACTIVE\" };\n", "", "start روی گذرِ کهنه")
m(S, "        if (running) return { started: false, reason: \"ALREADY_RUNNING\" };\n", "", "start دوباره")
m(S, "        stopping = null;\n        running = true;", "        running = true;", "وعدهٔ stop کهنه پاک نمی‌شود")
m(S, "        stalled = false;\n        disarm();", "        stalled = false;", "stop تایمر را لغو نمی‌کند")
m(S, "        stalled = false;\n        disarm();", "        disarm();", "stop از stalled خارج نمی‌شود")
m(S, "if (stopping !== null) return stopping;", "", "stopهای هم‌زمان وعدهٔ جدا")
m(S, "void pending.then(() => finish(true));", "", "stop پایانِ گذر را نمی‌بیند")
m(S, "cfg.timer.after(() => finish(false), cfg.stopTimeoutMs)", "cfg.timer.after(() => finish(true), cfg.stopTimeoutMs)", "مهلتِ stop clean=true می‌دهد")
m(S, "            finish(false); // بی‌مهلت", "            // بی‌مهلت", "stop بی‌مهلت آویزان می‌ماند")
m(S, "              try {\n                cfg.timer.cancel(timeoutHandle);", "              try {\n                void timeoutHandle;", "تایمرِ مهلتِ stop لغو نمی‌شود")
m(S, "if (busy) return \"stopping\";", "", "حالت stopping")
m(S, "return stalled ? \"stalled\" : \"stopped\";", "return \"stopped\";", "حالت stalled")
m(S, "Object.freeze({ run: runs, atMs, nextDelayMs })", "Object.freeze({ run: runs + 1, atMs, nextDelayMs })", "شمارهٔ گذر در info")
m(S, "totals.faults = cap(totals.faults + 1);", "", "شمارندهٔ خطاها")
m(S, "    lastFault = kind;\n", "", "lastFault")
m(S, "totals.observerFailures = cap(totals.observerFailures + 1);\n    }\n  }", "}\n  }", "شکستِ مشاهده‌گر (پرتاب) شمرده نمی‌شود")
m(S, "(then as (a: undefined, b: () => void) => unknown).call(r, undefined, () => void (totals.observerFailures = cap(totals.observerFailures + 1)))", "(then as (a: undefined, b: () => void) => unknown).call(r, undefined, () => undefined)", "شکستِ مشاهده‌گر (رد) شمرده نمی‌شود")
m(S, "Number.isSafeInteger(t) && t >= 0 ? t : null", "Number.isSafeInteger(t) && t > 0 ? t : null", "ساعتِ صفر نامعتبر")
m(S, "Number.isSafeInteger(t) && t >= 0 ? t : null", "Number.isSafeInteger(t) ? t : null", "ساعتِ منفی معتبر")
m(S, "      if (armed && token === armSeq) handle = h;", "      handle = undefined;", "دستگیرهٔ تایمر نگه داشته نمی‌شود (لغو بی‌اثر)")

# ── config.ts (بخش حلقه)
C = "config.ts"
m(C, "const graceOk = isIntIn(grace, 2, SETTLEMENT_LIMITS.maxGraceMs);", "const graceOk = isIntIn(grace, 1, SETTLEMENT_LIMITS.maxGraceMs);", "graceMs=۱ مجاز")
m(C, "const half = graceOk ? Math.floor(grace / 2) : 0;", "const half = graceOk ? Math.ceil(grace / 2) : 0;", "نیمهٔ گردشده به بالا")
m(C, "isIntIn(interval, 1, half)", "isIntIn(interval, 1, half + 1)", "interval بیش از نیمِ grace")
m(C, "(backoff as number) >= (interval as number)", "(backoff as number) > (interval as number)", "مرزِ maxBackoff = interval")
m(C, "isIntIn(backoff, 1, half)", "isIntIn(backoff, 1, half + 1)", "maxBackoff بیش از نیمِ grace")
m(C, "const backoff = raw[\"maxBackoffMs\"] ?? (graceOk ? half : undefined);", "const backoff = raw[\"maxBackoffMs\"] ?? (graceOk ? (interval as number) : undefined);", "پیش‌فرضِ سقفِ عقب‌نشینی")
m(C, "defaultMaxDrainRuns: 20", "defaultMaxDrainRuns: 21", "پیش‌فرضِ تخلیه")
m(C, "defaultStopTimeoutMs: 30_000", "defaultStopTimeoutMs: 31_000", "پیش‌فرضِ مهلتِ stop")
m(C, "isIntIn(drain, 1, SETTLEMENT_LIMITS.maxMaxDrainRuns)", "isIntIn(drain, 0, SETTLEMENT_LIMITS.maxMaxDrainRuns)", "maxDrainRuns=۰ مجاز")
m(C, "isIntIn(stopTimeout, 1, SETTLEMENT_LIMITS.maxStopTimeoutMs)", "isIntIn(stopTimeout, 0, SETTLEMENT_LIMITS.maxStopTimeoutMs)", "stopTimeoutMs=۰ مجاز")
m(C, "if (!(OBSERVER_KEYS as readonly string[]).includes(k))", "if (false)", "کلیدِ ناشناختهٔ observer")
m(C, "hasFns(raw[\"timer\"], [\"after\", \"cancel\"])", "hasFns(raw[\"timer\"], [\"after\"])", "timer بی‌cancel")
m(C, "hasFns(raw[\"sweeper\"], [\"sweep\"])", "true", "sweeper بی‌sweep")


# جهش‌های هم‌ارز مستند: کلید = شمارهٔ جهش (پس از ساختِ فهرست)، مقدار = دلیل.
EQUIVALENT: dict[int, str] = {
    25: "نگهبانِ `busy` در tick دفاعِ در عمق است و با ساختار دست‌نیافتنی است: تایمر فقط در start (پس از بررسیِ busy) یا پس از `busy=false` ساخته می‌شود و نشانهٔ یکتا فراخوانیِ دوم را می‌برد؛ حذفش رفتارِ قابل‌مشاهده‌ای ندارد.",
}

env = dict(os.environ)
if not (env.get("KB_TEST_DATABASE_URL") or env.get("DATABASE_URL")):
    print("پایگاه تنظیم نشده است (DATABASE_URL)."); sys.exit(2)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
    src = open(os.path.join(ROOT, D, f), encoding="utf8").read()
    if src.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {f}: {old[:70]!r}"); sys.exit(2)
    if old == new:
        print(f"[{i}] جهشِ بی‌تغییر: {why}"); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, D, f)
    src = open(path, encoding="utf8").read()
    open(path, "w", encoding="utf8").write(src.replace(old, new, 1))
    try:
        ok = tests_pass()
    finally:
        open(path, "w", encoding="utf8").write(src)
    if ok and i not in EQUIVALENT:
        alive.append((i, f, why)); print(f"[{i:02d}] ✗ زنده: {f} — {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {f} — {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
