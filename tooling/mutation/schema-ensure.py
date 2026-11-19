#!/usr/bin/env python3
"""
آزمون جهشی «اصلاح ریشهٔ مسابقهٔ CREATE SCHEMA» (برش م۳‑ه‑۳‑د، ADR-0035) روی `ensureSchema` و فراخوانی‌اش در هر دو `migrate.ts`
(ledger و settlement): هر جهش یک تغییر کوچکِ معنادار است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/schema-ensure.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/schema-ensure.py 3 9                      (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL؛ جزو CI نیست. پیش از هر اجرا پیش‌بازرسی می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FILES = {"ledger": ("src/modules/ledger/pg/migrate.ts", "LedgerStoreError"), "settlement": ("src/modules/settlement/pg/migrate.ts", "SettlementStoreError")}
TESTS = [
    "src/modules/ledger/pg/ensure-schema.unit.test.ts", "src/modules/ledger/pg/ensure-schema.pg.test.ts", "src/modules/ledger/pg/guard.test.ts",
    "src/modules/settlement/pg/ensure-schema.unit.test.ts", "src/modules/settlement/pg/ensure-schema.pg.test.ts",
    "src/modules/settlement/pg/ensure-schema.shared.pg.test.ts", "src/modules/settlement/pg/guard.test.ts",
]
M = []


def m(mod, old, new, why):
    M.append((FILES[mod][0], old, new, f"{mod}: {why}"))


LOCK = "  await ex.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`schema:ensure:${schema}`}, 0))`);\n"
for mod in FILES:
    err = FILES[mod][1]
    m(mod, LOCK, "", "قفلِ مشترکِ شِما حذف می‌شود")
    m(mod, "`schema:ensure:${schema}`", "`schema:ensure-x:${schema}`", "کلیدِ قفلِ مشترک عوض می‌شود (دو ماژول ناهمخوان)")
    m(mod, "`schema:ensure:${schema}`", "`schema:ensure:x`", "قفلِ مشترک برای همهٔ شِماها یکی می‌شود")
    m(mod, "FROM pg_catalog.pg_namespace WHERE nspname = ${schema}", "FROM pg_catalog.pg_namespace WHERE nspname <> ${schema}", "شرطِ SELECT وارونه می‌شود")
    m(mod, "if (rows.length === 0) await ex.execute", "if (rows.length >= 0) await ex.execute", "همیشه CREATE می‌زند (بازگشت به رفتارِ قدیم)")
    m(mod, "if (rows.length === 0) await ex.execute", "if (rows.length !== 0) await ex.execute", "شرطِ وجود وارونه می‌شود")
    m(mod, "if (!Array.isArray(rows)) {", "if (false) {", "پاسخِ نامعتبر شکست‌بسته نیست")
    m(mod, 'code: "CORRUPT_DATA", message: "پاسخِ بررسیِ', 'code: "STORE_FAILURE", message: "پاسخِ بررسیِ', "کدِ خطای پاسخِ نامعتبر عوض می‌شود")
    m(mod, "CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);\n}", "CREATE SCHEMA ${sql.identifier(schema)}`);\n}", "IF NOT EXISTS برداشته می‌شود")
    m(mod, "  await ensureSchema(tx, schema);\n", "", "فراخوانیِ ensureSchema در migrate حذف می‌شود")
    m(mod, "  await ensureSchema(tx, schema);\n", "      await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);\n", "بازگشت به CREATE SCHEMA IF NOT EXISTS مستقیم (کدِ پیش از اصلاح)")
    m(mod, "const found = await ex.execute(sql`SELECT 1 AS present FROM", "const found = await ex.execute(sql`SELECT 1 AS present, ${schema}::text AS s FROM", "پارامترِ اضافه در SELECT")

env = dict(os.environ)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return r.returncode == 0


# هم‌ارزهای توضیح‌داده‌شده (متنِ why ← دلیلِ رفتاری)
EQUIVALENT: dict = {}
lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
origs = {}
for i, (f, old, new, why) in enumerate(M):
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
