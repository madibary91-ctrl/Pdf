#!/usr/bin/env python3
"""
آزمون جهشی «پیمانِ بین‌ماژولیِ قفلِ مشترکِ ساختِ شِما» (برش م۳‑ه‑۳‑و، ADR-0037) روی سه `ensureSchema` و مصرفِ آن‌ها: هر جهش یک تغییرِ
کوچکِ معنادار است و باید دست‌کم یکی از دو آزمونِ پیمان (`tooling/schema-ensure-key-parity.test.ts` یا
`tooling/schema-ensure-cross-module.pg.test.ts`) را قرمز کند — بدونِ تکیه بر آزمون‌های درونِ ماژول:
رانشِ کلید باید با پیمانِ بین‌ماژولی گرفته شود (آزمون‌های درونِ ماژول هم رانشِ تکی را می‌گیرند، ولی ویرایشِ هم‌زمانِ کلید و آزمونِ همان ماژول را فقط پیمان می‌گیرد). جهشِ زنده یعنی آزمونی کم است.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/schema-ensure-parity.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/schema-ensure-parity.py 3 9                     (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL؛ جزو CI نیست. پیش از هر اجرا پیش‌بازرسی می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LED = "src/modules/ledger/pg/migrate.ts"
SET = "src/modules/settlement/pg/migrate.ts"
KBM = "src/modules/legal-kb-store/migrate.ts"
KBS = "src/modules/legal-kb-store/search-migrate.ts"
TESTS = [
    "tooling/schema-ensure-key-parity.test.ts",
    "tooling/schema-ensure-cross-module.pg.test.ts",
]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


KEY = "`schema:ensure:${schema}`"
for tag, f in (("ledger", LED), ("settlement", SET), ("legal-kb-store", KBM)):
    m(f, KEY, "`schema:ensure-x:${schema}`", f"{tag}: کلیدِ قفلِ مشترک رانش می‌کند")
    m(f, KEY, "`schema:ensure:x`", f"{tag}: قفلِ مشترک برای همهٔ شِماها یکی می‌شود")
    m(f, KEY, "`schema:ensure:${schema}:v2`", f"{tag}: پسوندِ نسخه به کلید اضافه می‌شود")
    m(f, KEY, "`schema-ensure:${schema}`", f"{tag}: جداکنندهٔ کلید عوض می‌شود")
    m(f, "pg_advisory_xact_lock(hashtextextended(" + "${" + KEY + "}, 0))", "pg_advisory_xact_lock(hashtextextended(${" + KEY + "}, 1))", f"{tag}: seed هشِ قفل عوض می‌شود")
    m(f, "  await ex.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${" + KEY + "}, 0))`);\n", "", f"{tag}: قفلِ مشترک حذف می‌شود")
    m(f, "  if (rows.length === 0) await ex.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);", "  await ex.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);\n  if (rows.length === 0) await ex.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);", f"{tag}: CREATE SCHEMA دومی بدونِ شرط افزوده می‌شود")
m(KBS, "      await ensureSchema(tx, searchSchemaName(schema));\n", "      await ensureSchema(tx, schema);\n", "kb-search: قفلِ مشترک روی شِمای اشتباه (نه `_search`)")
m(KBS, "      await ensureSchema(tx, searchSchemaName(schema));\n", "      await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(searchSchemaName(schema))}`);\n", "kb-search: CREATE SCHEMA مستقیم بیرونِ ensureSchema (کدِ پیش از اصلاح)")
m(KBS, "      await ensureSchema(tx, searchSchemaName(schema));\n", "", "kb-search: ساختِ شِما حذف می‌شود")

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
