#!/usr/bin/env python3
"""
آزمون جهشی «اصلاح مسابقهٔ CREATE SCHEMA در legal-kb-store» (برش م۳‑ه‑۳‑ه، ADR-0036) روی `ensureSchema` (در `migrate.ts`) و دو
فراخوانی‌اش (`migrate.ts` و `search-migrate.ts`): هر جهش یک تغییر کوچکِ معنادار است و باید دست‌کم یک آزمون را قرمز کند؛
جهشِ زنده یعنی آزمونی کم است.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/kb-schema-ensure.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/kb-schema-ensure.py 3 9                     (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL؛ جزو CI نیست. پیش از هر اجرا پیش‌بازرسی می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MIG = "src/modules/legal-kb-store/migrate.ts"
SEA = "src/modules/legal-kb-store/search-migrate.ts"
TESTS = [
    "src/modules/legal-kb-store/ensure-schema.unit.test.ts",
    "src/modules/legal-kb-store/ensure-schema.test.ts",
    "src/modules/legal-kb-store/migrate.test.ts",
]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


LOCK = "  await ex.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`schema:ensure:${schema}`}, 0))`);\n"
m(MIG, LOCK, "", "migrate: قفلِ مشترکِ شِما حذف می‌شود")
m(MIG, "`schema:ensure:${schema}`", "`schema:ensure-x:${schema}`", "migrate: کلیدِ قفلِ مشترک عوض می‌شود (ناهمخوان با ledger/settlement)")
m(MIG, "`schema:ensure:${schema}`", "`schema:ensure:x`", "migrate: قفلِ مشترک برای همهٔ شِماها یکی می‌شود")
m(MIG, "FROM pg_catalog.pg_namespace WHERE nspname = ${schema}", "FROM pg_catalog.pg_namespace WHERE nspname <> ${schema}", "migrate: شرطِ SELECT وارونه می‌شود")
m(MIG, "if (rows.length === 0) await ex.execute", "if (rows.length >= 0) await ex.execute", "migrate: همیشه CREATE می‌زند (بازگشت به رفتارِ قدیم)")
m(MIG, "if (rows.length === 0) await ex.execute", "if (rows.length !== 0) await ex.execute", "migrate: شرطِ وجود وارونه می‌شود")
m(MIG, "if (!Array.isArray(rows)) {", "if (false) {", "migrate: پاسخِ نامعتبر شکست‌بسته نیست")
m(MIG, 'code: "CORRUPT_DATA", message: "پاسخِ بررسیِ', 'code: "DB_ERROR", message: "پاسخِ بررسیِ', "migrate: کدِ خطای پاسخِ نامعتبر عوض می‌شود")
m(MIG, "CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);\n}", "CREATE SCHEMA ${sql.identifier(schema)}`);\n}", "migrate: IF NOT EXISTS برداشته می‌شود")
m(MIG, "      await ensureSchema(tx, schema);\n", "", "migrate: فراخوانیِ ensureSchema حذف می‌شود")
m(MIG, "      await ensureSchema(tx, schema);\n", "      await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);\n", "migrate: بازگشت به CREATE SCHEMA IF NOT EXISTS مستقیم (کدِ پیش از اصلاح)")
m(MIG, "const found = await ex.execute(sql`SELECT 1 AS present FROM", "const found = await ex.execute(sql`SELECT 1 AS present, ${schema}::text AS s FROM", "migrate: پارامترِ اضافه در SELECT")
m(MIG, "      await ensureSchema(tx, schema);\n", "      await ensureSchema(tx, \"public\");\n", "migrate: ensureSchema روی شِمای اشتباه صدا زده می‌شود")
m(MIG, '${"legal-kb-store:migrate"}', '${"legal-kb-store:migrate-x"}', "migrate: کلیدِ قفلِ ماژول عوض می‌شود")
m(SEA, "      await ensureSchema(tx, searchSchemaName(schema));\n", "", "search: فراخوانیِ ensureSchema حذف می‌شود")
m(SEA, "      await ensureSchema(tx, searchSchemaName(schema));\n", "      await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(searchSchemaName(schema))}`);\n", "search: بازگشت به CREATE SCHEMA IF NOT EXISTS مستقیم (کدِ پیش از اصلاح)")
m(SEA, "      await ensureSchema(tx, searchSchemaName(schema));\n", "      await ensureSchema(tx, schema);\n", "search: ensureSchema روی شِمای دانش (نه نمایه) صدا زده می‌شود")
m(SEA, '${"legal-kb-store:search-migrate"}', '${"legal-kb-store:search-migrate-x"}', "search: کلیدِ قفلِ ماژول عوض می‌شود")
m(SEA, 'import { ensureSchema, reconcile, type LedgerRow } from "./migrate";', 'import { reconcile, type LedgerRow } from "./migrate";\nconst ensureSchema = async (ex: KbExecutor, s: string): Promise<void> => { await ex.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(s)}`); };', "search: ensureSchemaِ مشترک با نسخهٔ ناقصِ محلی جایگزین می‌شود")

env = dict(os.environ)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return r.returncode == 0


# هم‌ارزهای توضیح‌داده‌شده (شمارهٔ جهش ← دلیلِ رفتاری)
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
