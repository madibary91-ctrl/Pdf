#!/usr/bin/env python3
"""
آزمون جهشی «منبعِ خواندنِ پایش SETTLEMENT_BACKLOG_SOURCE» (برش ADR-0051): هر جهش یک تغییرِ کوچکِ معنادار در `bootstrap.ts`/`env.ts` (settlement-bootstrap)
یا `args.ts` (settlement-pending-migrate) است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است. جزو CI نیست.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/settlement-bootstrap-source.py        (همه)
       DATABASE_URL=… python3 tooling/mutation/settlement-bootstrap-source.py 2 5                  (فقط جهش‌های ۲ تا ۵)
هر جهش نخست با آزمون‌های سریعِ بی‌پایگاه سنجیده می‌شود؛ فقط اگر زنده ماند، `source.pg.test.ts` (PostgreSQL واقعی) هم اجرا می‌شود. فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BS = "src/modules/settlement-bootstrap/"
PM = "src/modules/settlement-pending-migrate/"
BOOT, ENVF, ARGS = BS + "bootstrap.ts", BS + "env.ts", PM + "args.ts"
FAST = [BS + "source.test.ts", BS + "env.source.test.ts", BS + "source.guard.test.ts", BS + "backlog-source.test.ts", BS + "purity.test.ts", BS + "backlog.statement-timeout.test.ts",
        PM + "args.source.test.ts", "tooling/backlog-source-parity.test.ts", "tooling/settlement-pending-migrate-parity.test.ts"]
SLOW = [BS + "source.pg.test.ts"]
M = [
    (BOOT, 'settings.backlog.source === "pending"\n        ? createPendingDeadIndex', 'settings.backlog.source !== "pending"\n        ? createPendingDeadIndex', "انتخابِ منبع وارونه می‌شود"),
    (BOOT, "? createPendingDeadIndex(opened.db as never, readOptions)", "? createPgSettlementOutbox(opened.db as never, readOptions)", "pending بی‌صدا از outbox می‌خواند (بازگشتِ پنهان)"),
    (BOOT, "createPendingDeadIndex(opened.db as never, readOptions)", "createPendingDeadIndex(opened.db as never, { schema: readOptions.schema })", "نمایه سقفِ سمتِ پایگاه نمی‌گیرد"),
    (BOOT, "createPendingDeadIndex(opened.db as never, readOptions)", 'createPendingDeadIndex(opened.db as never, { ...readOptions, schema: "settlement" })', "نمایه همیشه شِمای پیش‌فرض را می‌خواند"),
    (BOOT, 'state: "armed", readyPolicy, ...sourceTag', 'state: "armed", readyPolicy', "رویدادِ armed نشانهٔ منبع را نمی‌دهد"),
    (BOOT, 'state: "started", readyPolicy, ...sourceTag', 'state: "started", readyPolicy', "رویدادِ started نشانهٔ منبع را نمی‌دهد"),
    (BOOT, 'state: "stopped", readyPolicy, ...sourceTag', 'state: "stopped", readyPolicy', "رویدادِ stopped نشانهٔ منبع را نمی‌دهد"),
    (BOOT, 'settings.backlog?.source === "pending" ? { source: "pending" } : {};', '{ source: "pending" };', "پیش‌فرض هم نشانهٔ pending می‌گیرد"),
    (ENVF, 'else if (sourceRaw === "pending" && backlog !== undefined) backlog', 'else if (false && sourceRaw === "pending" && backlog !== undefined) backlog', "pending هرگز به تنظیمات نمی‌رسد"),
    (ENVF, "else if (!watchOn) issues.push(`${ENV_BACKLOG_SOURCE}", "else if (false) issues.push(`${ENV_BACKLOG_SOURCE}", "منبع بی‌پایشِ روشن پذیرفته می‌شود"),
    (ENVF, 'if (sourceRaw !== "outbox" && sourceRaw !== "pending") issues.push(', 'if (false) issues.push(', "مقدارِ نامعتبرِ منبع پذیرفته می‌شود"),
    (ENVF, 'if (sourceRaw !== "outbox" && sourceRaw !== "pending") issues.push(', 'if (sourceRaw !== "outbox" && sourceRaw !== "pending" && sourceRaw !== "PENDING") issues.push(', "PENDING با حروفِ بزرگ پذیرفته می‌شود"),
    (ENVF, "ENV_BACKLOG_WATCH, ENV_BACKLOG_SOURCE, ...BACKLOG_NAMES", "ENV_BACKLOG_WATCH, ...BACKLOG_NAMES", "نامِ منبع از فهرستِ شناخته‌ها می‌افتد (کلیدِ ناشناخته)"),
    (ENVF, 'sourceRaw !== undefined && sourceRaw !== ""', 'sourceRaw !== undefined', "مقدارِ خالی خطا می‌شود"),
    (ARGS, "  ENV_BACKLOG_SOURCE, //", "  //", "CLI نامِ منبع را نمی‌شناسد (envِ برنامه را رد می‌کند)"),
]
env = dict(os.environ)


def passes(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
orig = {}
for f in {m[0] for m in M}:
    orig[f] = open(os.path.join(ROOT, f), encoding="utf8").read()
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
    if orig[f].count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {old[:80]!r}"); sys.exit(2)
    if new == old:
        print(f"[{i}] جهش بی‌اثر است: {why}"); sys.exit(2)
if not passes(FAST + SLOW):
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, f)
    open(path, "w", encoding="utf8").write(orig[f].replace(old, new, 1))
    try:
        ok = passes(FAST)
        slow_killed = False
        if ok:
            ok = passes(SLOW)
            slow_killed = not ok
    finally:
        open(path, "w", encoding="utf8").write(orig[f])
    if ok:
        alive.append((i, why)); print(f"[{i:02d}] ✗ زنده: {why}", flush=True)
    else:
        killed += 1
        print(f"[{i:02d}] ✓ کشته{' (فقط PostgreSQL)' if slow_killed else ''}: {why}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته: {killed} | زنده: {len(alive)}")
sys.exit(1 if alive else 0)
