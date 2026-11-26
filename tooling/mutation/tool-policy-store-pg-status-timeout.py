#!/usr/bin/env python3
"""
آزمون جهشیِ «مهلتِ status()» در tool-policy-store-pg (ADR-0074): هر جهش یک تغییر کوچکِ معنادار در store.ts/migrate.ts است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است (یا کدِ زائد).
اجرا:  python3 tooling/mutation/tool-policy-store-pg-status-timeout.py          (همه)
       python3 tooling/mutation/tool-policy-store-pg-status-timeout.py 2 5      (فقط جهش‌های ۲ تا ۵)
نیاز: Node ≥ 22 و پایگاهِ PostgreSQL (DATABASE_URL/KB_TEST_DATABASE_URL). جزو CI نیست. فایل‌ها پس از هر جهش همیشه برمی‌گردند؛ فقط اولین رخدادِ متن جایگزین می‌شود.
دروازهٔ کامل را هم‌زمان با این اسکریپت اجرا نکنید (بارِ CPU آزمون‌های وابسته به زمان را می‌شکند).
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/tool-policy-store-pg/"
TESTS = [B, "tooling/tool-policy-store-pg-source.test.ts", "tooling/tool-policy-runtime-preflight-timeout.pg.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


ST, MG = "store.ts", "migrate.ts"
# ── migrate.ts: status()
m(MG, "        await prepare(tx);\n", "", "status هیچ مهلتی نمی‌گذارد (prepare حذف می‌شود)")
m(MG, "        await prepare(tx);\n", "        if (await schemaExists(tx, schema)) await prepare(tx);\n", "مهلت فقط وقتی شِما هست گذاشته می‌شود")
m(MG, "        await prepare(tx);\n", "        await Promise.resolve(prepare(tx)).catch(() => undefined);\n", "شکستِ prepare بلعیده می‌شود و status بی‌سقف ادامه می‌دهد")
m(MG, "        await prepare(tx);\n", "        void prepare(tx);\n", "prepare منتظر نمی‌شود (مسابقه با دستورهای بعدی)")
m(MG, '{ accessMode: "read only" },\n    );\n    return { ok: true, value };', '{ accessMode: "read write" },\n    );\n    return { ok: true, value };', "status تراکنشِ نوشتنی می‌شود")
# ── store.ts: applyTimeouts و سیم‌کشی
m(ST, "status: () => status(db, schema, applyTimeouts),", "status: () => status(db, schema, () => Promise.resolve()),", "status با prepareِ بی‌اثر سیم‌کشی می‌شود")
m(ST, "status: () => status(db, schema, applyTimeouts),", "status: () => status(db, schema, (tx) => tx.execute(sql`SELECT set_config('statement_timeout', '0', true), set_config('lock_timeout', '0', true)`)),", "status مهلتِ ۰ (نامحدود) می‌گذارد")
m(ST, "set_config('statement_timeout', ${String(timeout)}, true), ", "", "statement_timeout گذاشته نمی‌شود")
m(ST, ", set_config('lock_timeout', ${String(timeout)}, true)`);", "`);", "lock_timeout گذاشته نمی‌شود")
m(ST, "${String(timeout)}, true), set_config('lock_timeout'", "${String(timeout)}, false), set_config('lock_timeout'", "statement_timeout نشستی می‌شود و به اتصالِ استخر نشت می‌کند")
m(ST, "set_config('lock_timeout', ${String(timeout)}, true)", "set_config('lock_timeout', ${String(timeout)}, false)", "lock_timeout نشستی می‌شود و به اتصالِ استخر نشت می‌کند")
m(ST, "set_config('lock_timeout', ${String(timeout)}", "set_config('lock_timeout', ${String(timeout + 1)}", "lock_timeout یک واحد بیشتر از statement_timeout")
m(ST, "set_config('statement_timeout', ${String(timeout)}", "set_config('statement_timeout', ${String(timeout * 2)}", "statement_timeout دو برابر می‌شود")
m(ST, "          await applyTimeouts(tx);\n", "", "چهار عملیات مهلت نمی‌گذارند")
m(ST, "          await applyTimeouts(tx);\n          await assertCurrent", "          await assertCurrent(tx, schema);\n          await applyTimeouts(tx);\n          void assertCurrent", "مهلت پس از بررسیِ مهاجرت گذاشته می‌شود")


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
        print(f"{'کشته  ' if killed else 'زنده! '} {i:3d}  {f:12s} {why}", flush=True)
        if not killed:
            live.append((i, f, why))
    print(f"\nجمع: {hi - lo + 1} جهش، زنده: {len(live)}")
    for i, f, why in live:
        print(f"  زنده {i}: {f} — {why}")
    sys.exit(1 if live else 0)


if __name__ == "__main__":
    main()
