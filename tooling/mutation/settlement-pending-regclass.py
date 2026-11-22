#!/usr/bin/env python3
"""
آزمون جهشی «بررسیِ وجودِ رابطه بی‌کشِ کهنه» (برش ADR-0050): هر جهش یک تغییرِ کوچکِ معنادار در `relationExists` و کاربردهایش در
`settlement-pending/migrate.ts` است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است. جزو CI نیست.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/settlement-pending-regclass.py        (همه)
       DATABASE_URL=… python3 tooling/mutation/settlement-pending-regclass.py 2 5                  (فقط جهش‌های ۲ تا ۵)
هر جهش نخست با آزمون‌های سریعِ بی‌پایگاه سنجیده می‌شود؛ فقط اگر زنده ماند، `regclass.pg.test.ts` (PostgreSQL واقعی) هم اجرا می‌شود.
فایل پس از هر جهش همیشه برمی‌گردد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-pending/"
F = B + "migrate.ts"
FAST = [B + "regclass.unit.test.ts", B + "down.unit.test.ts", B + "down.order.test.ts", B + "unit.test.ts", B + "purity.test.ts"]
SLOW = [B + "regclass.pg.test.ts"]
EXISTS = "EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = to_regclass(${qualifiedName}))"
M = [
    (EXISTS, "to_regclass(${qualifiedName}) IS NOT NULL", "بازگشت به to_regclass لخت (کشِ کهنه)"),
    ("c.oid = to_regclass(${qualifiedName})", "c.oid IS NOT NULL", "pg_class به to_regclass گره نخورده؛ هر کاتالوگِ ناتهی «هست» است"),
    ("c.oid = to_regclass(${qualifiedName})", "c.oid <> to_regclass(${qualifiedName})", "شرطِ برابری وارونه می‌شود"),
    ("sql`SELECT ${relationExists(`${JSON.stringify(schema)}.settlement_outbox`)} AS outbox,", "sql`SELECT true AS outbox,", "وجودِ outbox هرگز سنجیده نمی‌شود"),
    ("${relationExists(`${JSON.stringify(schema)}.settlement_dead_ack`)} AS ack`", "true AS ack`", "وجودِ جدولِ تأیید هرگز سنجیده نمی‌شود"),
    ("${relationExists(`${JSON.stringify(schema)}.settlement_dead_ack`)} AS ack`", "${relationExists(`${JSON.stringify(schema)}.settlement_outbox`)} AS ack`", "تأیید با نامِ outbox سنجیده می‌شود"),
    ("const present = await tx.execute(sql`SELECT ${relationExists(`${JSON.stringify(schema)}.${LEDGER}`)} AS present`);", "const present = await tx.execute(sql`SELECT to_regclass(${`${JSON.stringify(schema)}.${LEDGER}`}) IS NOT NULL AS present`);", "دفترِ down با to_regclass لخت"),
    ("const exists = await tx.execute(sql`SELECT ${relationExists(`${JSON.stringify(schema)}.${LEDGER}`)} AS present`);", "const exists = await tx.execute(sql`SELECT to_regclass(${`${JSON.stringify(schema)}.${LEDGER}`}) IS NOT NULL AS present`);", "دفترِ status با to_regclass لخت"),
    ("function relationExists(qualifiedName: string): SQL {\n  return sql`" + EXISTS + "`;", "function relationExists(qualifiedName: string): SQL {\n  return sql`" + EXISTS + " OR true`;", "همیشه «هست»"),
]
env = dict(os.environ)


def passes(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
path = os.path.join(ROOT, F)
orig = open(path, encoding="utf8").read()
for i, (old, new, why) in enumerate(M):  # پیش‌بازرسی
    if orig.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {old[:80]!r}"); sys.exit(2)
    if new == old:
        print(f"[{i}] جهش بی‌اثر است: {why}"); sys.exit(2)
if not passes(FAST + SLOW):
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    open(path, "w", encoding="utf8").write(orig.replace(old, new, 1))
    try:
        ok = passes(FAST)
        slow_killed = False
        if ok:
            ok = passes(SLOW)
            slow_killed = not ok
    finally:
        open(path, "w", encoding="utf8").write(orig)
    if ok:
        alive.append((i, why)); print(f"[{i:02d}] ✗ زنده: {why}", flush=True)
    else:
        killed += 1
        print(f"[{i:02d}] ✓ کشته{' (فقط PostgreSQL)' if slow_killed else ''}: {why}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته: {killed} | زنده: {len(alive)}")
sys.exit(1 if alive else 0)
