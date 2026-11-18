#!/usr/bin/env python3
"""
آزمون جهشی آداپتور PostgreSQL ماژول settlement (برش م۳‑ب؛ ADR-0022): هر جهش یک تغییر کوچکِ معنادار در کد منبع است؛ مجموعهٔ آزمون باید قرمز شود (جهش «کشته شود»).
اجرا:  python3 tooling/mutation/settlement-pg.py            (همه)
       python3 tooling/mutation/settlement-pg.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و پایگاه (DATABASE_URL یا KB_TEST_DATABASE_URL)؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل‌ها هست؛ فایل اصلی پس از هر جهش همیشه برمی‌گردد.

جهش‌های SQL (migrations.ts) فقط با تست‌های «رفتار پایگاه» (schema.pg.test.ts) سنجیده می‌شوند، نه unit.test.ts: هر ویرایشِ مهاجرت checksum قفل‌شده را می‌شکند
و آن تست همه را «بی‌ارزش» می‌کُشد؛ می‌خواهیم **رفتارِ** پایگاه جهش را بگیرد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = "src/modules/settlement/pg/"
ALL_TESTS = [D]
SQL_TESTS = [D + "schema.pg.test.ts"]
M = []


def m(f, old, new, why, tests=None):
    M.append((f, old, new, why, tests or (SQL_TESTS if f == "migrations.ts" else ALL_TESTS)))


# ── store.ts: سپر، قفل، تصمیم‌ها
m("store.ts", "          await assertCurrent(tx, schema);\n          return fn(tx);", "          return fn(tx);", "بی‌سپرِ مهاجرت")
m("store.ts", 'readOnly ? { accessMode: "read only" } : undefined', "undefined", "خواندن‌ها فقط‌خواندنی نیستند")
m("store.ts", "${forUpdate ? sql`FOR UPDATE` : sql``}", "${sql``}", "بی‌قفلِ ردیف")
m("store.ts", "          ON CONFLICT (tenant_id, account_id, reservation_id) DO NOTHING\n", "", "begin بی‌ON CONFLICT")
m("store.ts", "cur.unit === b.unit && ", "", "begin: واحد مقایسه نمی‌شود")
m("store.ts", "cur.reserved === b.reserved && ", "", "begin: مبلغ مقایسه نمی‌شود")
m("store.ts", "cur.expiresAtMs === b.expiresAtMs && ", "", "begin: سررسید مقایسه نمی‌شود")
m("store.ts", " && cur.orphanRemainder === b.orphanRemainder", "", "begin: سیاستِ یتیم مقایسه نمی‌شود")
m("store.ts", 'if (e.close !== null) return conflict("پس از قصدِ بستن، قصدِ مصرف ممنوع است.");', "", "مصرف پس از قصدِ بستن")
m("store.ts", "e.charge.attemptId === want.attemptId && e.charge.amount === want.amount", "e.charge.amount === want.amount", "recordCharge: شناسهٔ تلاش مقایسه نمی‌شود")
m("store.ts", "e.charge.attemptId === want.attemptId && e.charge.amount === want.amount", "e.charge.attemptId === want.attemptId", "recordCharge: مبلغ مقایسه نمی‌شود")
m("store.ts", "e.close.remainder === want.remainder ? ok({ replayed: true })", "true ? ok({ replayed: true })", "recordClose: باقیمانده مقایسه نمی‌شود")
m("store.ts", "        if (e.close !== null) return ok(e);\n", "", "resolveClose: قصدِ بستنِ موجود نادیده")
m("store.ts", "CASE WHEN charge_attempt_id IS NULL THEN orphan_remainder ELSE 'release' END", "orphan_remainder", "رفتگر با قصدِ مصرف سوخت می‌کند (بیش‌اخذ)")
m("store.ts", "CASE WHEN charge_attempt_id IS NULL THEN orphan_remainder ELSE 'release' END", "'release'", "رفتگر سیاستِ یتیم را نادیده می‌گیرد")
m("store.ts", "close_origin = 'sweeper', state = 'settling'\n          WHERE", "close_origin = 'caller', state = 'settling'\n          WHERE", "origin رفتگر")
m("store.ts", 'if (e.state === "done") return ok({ replayed: true });', 'if (e.state === "done") return notActive();', "finish بازتکراری")
m("store.ts", 'if (e.close === null) return conflict("پایان بدون قصدِ بستن ممکن نیست.");', "", "finish بی‌قصدِ بستن")
m("store.ts", "SET state = 'done', settled_at_ms = ${atMs}", "SET state = 'done', settled_at_ms = 0", "زمانِ پایانِ ثبت‌نشده")
m("store.ts", "attempts = attempts + 1, ", "attempts = attempts, ", "شمارندهٔ تلاش")
m("store.ts", ", due_at_ms = ${want.dueAtMs}\n          WHERE", "\n          WHERE", "سررسیدِ تازه ثبت نمی‌شود")
m("store.ts", "last_error_code = ${want.errorCode}, settled_at_ms = ${want.atMs}", "settled_at_ms = ${want.atMs}", "bury: کدِ خطا ثبت نمی‌شود")
m("store.ts", "e.deadReason === want.reason ? ok({ replayed: true })", "true ? ok({ replayed: true })", "bury با دلیل دیگر")
m("store.ts", 'if (e.state === "dead") return notActive();\n        if (e.close === null)', 'if (e.state === "dead") return ok({ replayed: true });\n        if (e.close === null)', "finish روی dead")
m("store.ts", "due_at_ms <= ${nowMs}", "due_at_ms < ${nowMs}", "مرزِ سررسید")
m("store.ts", "WHERE state IN ('open', 'settling') AND due_at_ms", "WHERE state = 'open' AND due_at_ms", "listDue فقط open")
m("store.ts", "ORDER BY due_at_ms, tenant_id, account_id, reservation_id\n          LIMIT", "ORDER BY tenant_id, account_id, reservation_id\n          LIMIT", "ترتیبِ سررسید")
m("store.ts", "ORDER BY settled_at_ms, tenant_id, account_id, reservation_id", "ORDER BY tenant_id, account_id, reservation_id", "ترتیبِ زمانِ مرگ")
m("store.ts", "          WHERE state = 'dead'\n", "          WHERE state <> 'done'\n", "listDead شاملِ فعال‌ها")
m("store.ts", "ORDER BY due_at_ms, tenant_id, account_id, reservation_id\n          LIMIT ${limit}", "ORDER BY due_at_ms, tenant_id, account_id, reservation_id\n          LIMIT 1000", "سقفِ limit در listDue")
m("store.ts", "SELECT state, count(*)::text AS n FROM ${T} GROUP BY state", "SELECT state, count(DISTINCT tenant_id)::text AS n FROM ${T} GROUP BY state", "شمارش")
m("store.ts", "!isFn(d.transaction)", "false", "db بی‌transaction پذیرفته می‌شود")
m("store.ts", "parseSchemaName(options.schema ?? SETTLEMENT_DEFAULT_SCHEMA)", 'parseSchemaName(options.schema ?? "public")', "شِمای پیش‌فرض")
# ── rows.ts
m("rows.ts", "if (!Number.isSafeInteger(n) || n < 0) throw corrupt(BAD);", "if (!Number.isSafeInteger(n)) throw corrupt(BAD);", "readCount: عددِ منفی")
m("rows.ts", "if ((attemptId === null) !== (amount === null)) throw corrupt(BAD);", "", "ردیفِ مصرفِ ناقص")
m("rows.ts", "if ((closeRemainder === null) !== (closeOrigin === null)) throw corrupt(BAD);", "", "ردیفِ بستنِ ناقص")
m("rows.ts", 'if (!STATES.has(state)) throw corrupt(BAD);\n  const deadReason', "const deadReason", "وضعیتِ ناشناخته")
m("rows.ts", "if (deadReason !== null && !DEAD.has(deadReason)) throw corrupt(BAD);", "", "دلیلِ مرگِ ناشناخته")
m("rows.ts", "Object.freeze({ attemptId, amount })", "{ attemptId, amount }", "قصدِ مصرفِ منجمد")
# ── migrate.ts / errors.ts / naming.ts
m("migrate.ts", "      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:migrate:${schema}`}, 0))`);\n", "", "migrate بی‌قفل")
m("migrate.ts", "CREATE SCHEMA IF NOT EXISTS", "CREATE SCHEMA", "CREATE SCHEMA بی‌IF NOT EXISTS")
m("migrate.ts", "if (stored !== migrationChecksum(m)) {", "if (false) {", "بی‌سنجشِ checksum")
m("migrate.ts", "if (pending.length > 0) {\n      throw new SettlementStoreError({ code: \"MIGRATION_TAMPERED\"", "if (false) {\n      throw new SettlementStoreError({ code: \"MIGRATION_TAMPERED\"", "حفره در مهاجرت‌ها")
m("migrate.ts", "if (!known.has(row.name)) {", "if (false) {", "مهاجرتِ ناشناخته")
m("migrate.ts", "VALUES (${m.name}, ${migrationChecksum(m)})", "VALUES (${m.name}, 'x')", "checksum ثبت‌شده")
m("migrate.ts", "  if (status.pending.length > 0) {\n    throw new SettlementStoreError({ code: \"NOT_MIGRATED\"", "  if (false) {\n    throw new SettlementStoreError({ code: \"NOT_MIGRATED\"", "سپر: مهاجرتِ معلق")
m("errors.ts", 'pg.code.startsWith("23")', 'pg.code.startsWith("99")', "نگاشتِ نقضِ قید")
m("errors.ts", 'pg.code === "42P01" || pg.code === "3F000"', 'pg.code === "42P01"', "نگاشتِ شِمای ناموجود")
m("naming.ts", 'RESERVED.has(value) || ', "", "شِمای public مجاز")
m("naming.ts", 'value.startsWith("pg_")', "false", "شِمای pg_*")
# ── migrations.ts (SQL): فقط با رفتارِ پایگاه
m("migrations.ts", "CONSTRAINT settlement_outbox_reserved_ck CHECK (reserved >= 1),", "CONSTRAINT settlement_outbox_reserved_ck CHECK (reserved >= 0),", "reserved صفر")
m("migrations.ts", "CHECK ((charge_attempt_id IS NULL) = (charge_amount IS NULL))", "CHECK (true)", "قیدِ شکلِ مصرف")
m("migrations.ts", "CHECK ((close_remainder IS NULL) = (close_origin IS NULL))", "CHECK (true)", "قیدِ شکلِ بستن")
m("migrations.ts", "WHEN 'open' THEN charge_attempt_id IS NULL AND close_remainder IS NULL AND dead_reason IS NULL AND settled_at_ms IS NULL", "WHEN 'open' THEN true", "شکلِ open")
m("migrations.ts", "WHEN 'settling' THEN (charge_attempt_id IS NOT NULL OR close_remainder IS NOT NULL) AND dead_reason IS NULL AND settled_at_ms IS NULL", "WHEN 'settling' THEN true", "شکلِ settling")
m("migrations.ts", "WHEN 'done' THEN close_remainder IS NOT NULL AND dead_reason IS NULL AND settled_at_ms IS NOT NULL", "WHEN 'done' THEN true", "شکلِ done")
m("migrations.ts", "WHEN 'dead' THEN dead_reason IS NOT NULL AND settled_at_ms IS NOT NULL", "WHEN 'dead' THEN true", "شکلِ dead")
m("migrations.ts", 'AS text COLLATE "C"', "AS text", "ترتیبِ نقطه‌کدی")
m("migrations.ts", "{0,127}$')", "{0,128}$')", "طولِ شناسه")
m("migrations.ts", "IF TG_OP = 'DELETE' THEN\n         RAISE EXCEPTION 'settlement: outbox records are never deleted'", "IF false THEN\n         RAISE EXCEPTION 'settlement: outbox records are never deleted'", "حذف مجاز")
m("migrations.ts", "IF OLD.state IN ('done', 'dead') THEN", "IF OLD.state IN ('dead') THEN", "done نهایی نیست")
m("migrations.ts", "IF OLD.state IN ('done', 'dead') THEN", "IF OLD.state IN ('done') THEN", "dead نهایی نیست")
m("migrations.ts", " OR NEW.unit <> OLD.unit OR NEW.reserved <> OLD.reserved", " OR NEW.unit <> OLD.unit", "reserved تغییرپذیر")
m("migrations.ts", "OR NEW.expires_at_ms <> OLD.expires_at_ms OR NEW.orphan_remainder <> OLD.orphan_remainder", "OR NEW.orphan_remainder <> OLD.orphan_remainder", "expires تغییرپذیر")
m("migrations.ts", "OR NEW.expires_at_ms <> OLD.expires_at_ms OR NEW.orphan_remainder <> OLD.orphan_remainder", "OR NEW.expires_at_ms <> OLD.expires_at_ms", "سیاستِ یتیم تغییرپذیر")
m("migrations.ts", "(NEW.charge_attempt_id IS DISTINCT FROM OLD.charge_attempt_id OR NEW.charge_amount IS DISTINCT FROM OLD.charge_amount)", "(NEW.charge_attempt_id IS DISTINCT FROM OLD.charge_attempt_id)", "مبلغِ مصرف تغییرپذیر")
m("migrations.ts", "(NEW.close_remainder IS DISTINCT FROM OLD.close_remainder OR NEW.close_origin IS DISTINCT FROM OLD.close_origin)", "(NEW.close_remainder IS DISTINCT FROM OLD.close_remainder)", "originِ بستن تغییرپذیر")
m("migrations.ts", "IF OLD.close_remainder IS NOT NULL AND OLD.charge_attempt_id IS NULL AND NEW.charge_attempt_id IS NOT NULL THEN", "IF false THEN", "مصرف پس از بستن")
m("migrations.ts", "IF NEW.attempts < OLD.attempts THEN", "IF false THEN", "کاهشِ تلاش")
m("migrations.ts", "IF OLD.state = 'settling' AND NEW.state = 'open' THEN", "IF false THEN", "بازگشت به open")
m("migrations.ts", "WHERE state IN ('open', 'settling')`,\n    `CREATE INDEX settlement_outbox_dead_idx", "WHERE state IN ('open')`,\n    `CREATE INDEX settlement_outbox_dead_idx", "ایندکسِ سررسید فقط open")
m("migrations.ts", "(settled_at_ms, tenant_id, account_id, reservation_id)\n       WHERE state = 'dead'", "(tenant_id, account_id, reservation_id)\n       WHERE state = 'dead'", "ایندکسِ مرده‌ها بی‌زمان")


# جهش‌های هم‌ارز مستند: (هر جهشِ زنده باید تست بگیرد یا این‌جا با دلیل ثبت شود). کلید = شمارهٔ جهش.
EQUIVALENT: dict[int, str] = {}

env = dict(os.environ)
if not (env.get("KB_TEST_DATABASE_URL") or env.get("DATABASE_URL")):
    print("پایگاه تنظیم نشده است (DATABASE_URL)."); sys.exit(2)


def tests_pass(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
for i, (f, old, new, why, _t) in enumerate(M):  # پیش‌بازرسی
    src = open(os.path.join(ROOT, D, f), encoding="utf8").read()
    if src.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {f}: {old[:70]!r}"); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why, tests) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, D, f)
    src = open(path, encoding="utf8").read()
    open(path, "w", encoding="utf8").write(src.replace(old, new, 1))
    try:
        ok = tests_pass(tests)
    finally:
        open(path, "w", encoding="utf8").write(src)
    if ok and i not in EQUIVALENT:
        alive.append((i, f, why)); print(f"[{i:02d}] ✗ زنده: {f} — {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {f} — {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
