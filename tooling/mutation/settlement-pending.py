#!/usr/bin/env python3
"""
آزمون جهشی «نمایهٔ مشتقِ مرده‌های در انتظارِ تأیید» (م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۱، ADR-0046) روی `src/modules/settlement-pending/*`:
هر جهش یک تغییرِ کوچکِ معنادار است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است (یا جهش هم‌ارز است و باید دلیلش نوشته شود).
اجرا:  KB_TEST_DATABASE_URL=postgresql://… python3 tooling/mutation/settlement-pending.py          (همه)
       KB_TEST_DATABASE_URL=… python3 tooling/mutation/settlement-pending.py 3 9                    (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL؛ جزو CI نیست. پیش از هر اجرا وجودِ متنِ اصلیِ همهٔ جهش‌ها (دقیقاً یک بار) در فایل را می‌سنجد.
نکته: آزمونِ «checksum قفل‌شدهٔ literal» عمداً از اجرا کنار گذاشته می‌شود؛ وگرنه هر جهش در migrations.ts را بی‌ارزش «می‌کشت» و ارزشِ بقیهٔ آزمون‌ها دیده نمی‌شد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = "src/modules/settlement-pending/"
MIG, READ, MGR, STORE = D + "migrations.ts", D + "read.ts", D + "migrate.ts", D + "store.ts"
TESTS = [D + "unit.test.ts", D + "pending.pg.test.ts", D + "purity.test.ts"]
SKIP = "^(?!.*checksum قفل‌شدهٔ literal)"
M = []
# جهش‌های هم‌ارز (مستند):
#  - [14] `TG_OP = 'UPDATE'` در نگهبان: هیچ TRIGGERی ردیفِ نمایه را UPDATE نمی‌کند و UPDATEِ مستقیم (depth=1) را شرطِ `pg_trigger_depth() < 2` خودش می‌گیرد؛ بندِ UPDATE فقط دفاعِ دوم است.
#  - [15] `TG_OP = 'TRUNCATE'` در نگهبان: TRUNCATEِ مستقیم هم در depth=1 است و با `< 2` رد می‌شود؛ بندِ TRUNCATE فقط دفاعِ دوم است (و خوانایی).
#  - [28] REPEATABLE READ در verify: بدونِ نویسندهٔ هم‌زمانِ میانِ چهار زیرپرسش نتیجه یکی است؛ آزمونِ قطعی برای تداخلِ زمانی ندارم (توضیحِ صادقانه در ADR).
#  - [39] و [40] هر کدام از دو قفلِ مشورتیِ مهاجرت **به‌تنهایی** زائد است (دیگری سریال‌سازی را نگه می‌دارد)؛ جهشِ ۴۷ هر دو را با هم برمی‌دارد و باید کشته شود.
#  - [22] `ORDER BY p.settled_at_ms` بی‌کلیدهای شکستنِ گره: ایندکسِ `settlement_dead_pending_order_idx` خودش به ترتیبِ کاملِ کلید است و برنامه‌ریز برای این اندازه‌ها آن را
#    می‌خواند، پس خروجی یکی است؛ مگر برنامه Seq Scan + Sort بگیرد (بدونِ کنترلِ برنامه در آزمون قطعی نیست). قراردادِ ترتیبِ کامل با آزمونِ «گره‌های زمانِ مرگ» و تفاضلی قفل است؛
#    این جهش با دورزدنِ برنامه‌ریز زنده می‌ماند (ADR-0046 «ریسک‌ها»).
EQUIVALENT = {14, 15, 22, 28, 39, 40}


def m(src, old, new, why):
    M.append((src, old, new, why))


# ───── مهاجرت: ساختار و TRIGGERها ─────
m(MIG, "    `SET LOCAL lock_timeout = '15s'`,\n", "", "بی‌lock_timeout: مهاجرت می‌تواند بی‌پایان پشتِ نویسنده بماند")  # 0
m(MIG, "IN SHARE ROW EXCLUSIVE MODE`,", "IN ACCESS SHARE MODE`,", "قفلِ backfill آن‌قدر ضعیف که نویسنده را نگه نمی‌دارد")  # 1
m(MIG, "FOR EACH ROW WHEN (NEW.state = 'dead') EXECUTE", "FOR EACH ROW EXECUTE", "TRIGGERِ درج برای همهٔ وضعیت‌ها شلیک می‌کند")  # 2
m(MIG, "AFTER INSERT ON ${S}.settlement_outbox", "AFTER DELETE ON ${S}.settlement_outbox", "TRIGGERِ درجِ مستقیمِ dead روی رویدادِ دیگر")  # 3
m(MIG, "FOR EACH ROW WHEN (NEW.state = 'dead' AND OLD.state IS DISTINCT FROM 'dead') EXECUTE", "FOR EACH ROW WHEN (NEW.state = 'dead') EXECUTE", "dead_upd بی‌شرطِ OLD")  # 4
m(MIG, "       ON CONFLICT (tenant_id, account_id, reservation_id) DO NOTHING;\n       RETURN NULL;", "       RETURN NULL;", "ورود بی‌ON CONFLICT")  # 5
m(MIG, "AFTER INSERT ON ${S}.settlement_dead_ack", "AFTER UPDATE ON ${S}.settlement_dead_ack", "TRIGGERِ تأیید روی UPDATE")  # 6
m(MIG, "WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id AND reservation_id = NEW.reservation_id;\n       RETURN NULL;", "WHERE tenant_id = NEW.tenant_id AND reservation_id = NEW.reservation_id;\n       RETURN NULL;", "حذفِ ردیفِ نمایه بی‌کلیدِ حساب")  # 7
m(MIG, "WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id AND reservation_id = NEW.reservation_id;\n       RETURN NULL;", "WHERE account_id = NEW.account_id AND reservation_id = NEW.reservation_id;\n       RETURN NULL;", "حذفِ ردیفِ نمایه بی‌کلیدِ مستأجر")  # 8
m(MIG, "WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id AND reservation_id = NEW.reservation_id;\n       RETURN NULL;", "WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id;\n       RETURN NULL;", "حذفِ ردیف‌های نمایه بی‌کلیدِ رزرو")  # 9
m(MIG, "       WHERE o.state = 'dead'\n         AND NOT EXISTS (SELECT 1 FROM ${S}.settlement_dead_ack a", "       WHERE true\n         AND NOT EXISTS (SELECT 1 FROM ${S}.settlement_dead_ack a", "backfill همهٔ وضعیت‌ها را می‌گیرد")  # 10
m(MIG, "         AND NOT EXISTS (SELECT 1 FROM ${S}.settlement_dead_ack a WHERE a.tenant_id = o.tenant_id AND a.account_id = o.account_id AND a.reservation_id = o.reservation_id)`,", "         AND true`,", "backfill تأییدشده‌ها را هم می‌گیرد")  # 11
m(MIG, "pg_trigger_depth() < 2", "pg_trigger_depth() < 1", "نگهبان دست‌کاریِ مستقیم را می‌پذیرد")  # 12
m(MIG, "pg_trigger_depth() < 2", "pg_trigger_depth() < 3", "نگهبان TRIGGERهای خودِ نمایه را هم می‌بندد")  # 13
m(MIG, "IF TG_OP = 'TRUNCATE' OR TG_OP = 'UPDATE' OR pg_trigger_depth() < 2 THEN", "IF TG_OP = 'TRUNCATE' OR pg_trigger_depth() < 2 THEN", "UPDATEِ ردیفِ نمایه از درونِ TRIGGER مجاز می‌شود")  # 14
m(MIG, "IF TG_OP = 'TRUNCATE' OR TG_OP = 'UPDATE' OR pg_trigger_depth() < 2 THEN", "IF TG_OP = 'UPDATE' OR pg_trigger_depth() < 2 THEN", "TRUNCATE نمایه مجاز می‌شود")  # 15
m(MIG, "    `CREATE INDEX settlement_dead_pending_order_idx ON ${S}.settlement_dead_pending (settled_at_ms, tenant_id, account_id, reservation_id)`,", "    `CREATE INDEX settlement_dead_pending_order_idx ON ${S}.settlement_dead_pending (tenant_id, settled_at_ms, account_id, reservation_id)`,", "ایندکسِ ترتیب با ستون‌های نادرست")  # 16
m(MIG, "autovacuum_vacuum_threshold = 200,", "autovacuum_vacuum_threshold = 20000,", "آستانهٔ autovacuum بزرگ")  # 17
m(MIG, "settled_at_ms ${S}.settlement_count NOT NULL,\n       CONSTRAINT settlement_dead_pending_pk", "settled_at_ms bigint NOT NULL,\n       CONSTRAINT settlement_dead_pending_pk", "ستونِ زمان بی‌دامنهٔ settlement")  # 18
# ───── خواندن ─────
m(READ, "WHERE o.state = 'dead' AND o.settled_at_ms = p.settled_at_ms\n              AND NOT EXISTS", "WHERE o.settled_at_ms = p.settled_at_ms\n              AND NOT EXISTS", "خواندن وضعیتِ dead را دوباره نمی‌سنجد")  # 19
m(READ, "WHERE o.state = 'dead' AND o.settled_at_ms = p.settled_at_ms\n              AND NOT EXISTS", "WHERE o.state = 'dead'\n              AND NOT EXISTS", "خواندن زمانِ مرگ را دوباره نمی‌سنجد")  # 20
m(READ, "              AND NOT EXISTS (SELECT 1 FROM ${A} a WHERE a.tenant_id = o.tenant_id AND a.account_id = o.account_id AND a.reservation_id = o.reservation_id)\n            ORDER BY", "            ORDER BY", "خواندن تأییدشده‌ی کهنه را بیرون می‌دهد")  # 21
m(READ, "ORDER BY p.settled_at_ms, p.tenant_id, p.account_id, p.reservation_id\n            LIMIT ${limit}", "ORDER BY p.settled_at_ms\n            LIMIT ${limit}", "ترتیب بی‌کلیدهای شکستنِ گره")  # 22
m(READ, "ORDER BY p.settled_at_ms, p.tenant_id, p.account_id, p.reservation_id\n            LIMIT ${limit}", "ORDER BY p.settled_at_ms, p.tenant_id, p.account_id, p.reservation_id DESC\n            LIMIT ${limit}", "ترتیبِ آخرین کلید برعکس")  # 23
m(READ, "            LIMIT ${limit}`);", "            LIMIT 1000`);", "سقفِ LIMIT نادیده گرفته می‌شود")  # 24
m(READ, "export const PENDING_LIST_LIMIT_MAX = 1000;", "export const PENDING_LIST_LIMIT_MAX = 1001;", "حدِ بالای limit")  # 25
m(READ, "limit >= 1 && limit <=", "limit >= 0 && limit <=", "limit=0 پذیرفته می‌شود")  # 26
m(READ, "await tx.execute(sql`SELECT set_config('statement_timeout', ${String(ms)}, true)`);", "await tx.execute(sql`SELECT set_config('statement_timeout', ${String(ms)}, false)`);", "سقفِ زمان به اتصال نشت می‌کند")  # 27
m(READ, '{ accessMode: "read only", ...(isolation === undefined ? {} : { isolationLevel: isolation }) }', '{ accessMode: "read only" }', "verify بی‌عکسِ یکپارچه")  # 28
m(READ, "        if (readStatementTimeoutMs !== null) await boundStatementTime(tx, readStatementTimeoutMs);\n        await assertCurrent(tx, schema);", "        await assertCurrent(tx, schema);", "سقفِ زمان اعمال نمی‌شود")  # 29
m(READ, "        await assertCurrent(tx, schema);\n        return fn(tx);", "        return fn(tx);", "خواندن بی‌سپرِ مهاجرت")  # 30
m(READ, "consistent: missing === 0 && stale === 0", "consistent: missing === 0 || stale === 0", "ناسازگاریِ یک‌طرفه سازگار شمرده می‌شود")  # 31
m(READ, "AND NOT EXISTS (SELECT 1 FROM ${P} p WHERE p.tenant_id = o.tenant_id AND p.account_id = o.account_id AND p.reservation_id = o.reservation_id AND p.settled_at_ms = o.settled_at_ms))::text AS missing,", "AND NOT EXISTS (SELECT 1 FROM ${P} p WHERE p.tenant_id = o.tenant_id AND p.account_id = o.account_id AND p.reservation_id = o.reservation_id))::text AS missing,", "زمانِ مرگِ نادرست «گم‌شده» شمرده نمی‌شود")  # 32
m(READ, "                 AND o.state = 'dead' AND o.settled_at_ms = p.settled_at_ms\n                 AND NOT EXISTS", "                 AND o.state = 'dead'\n                 AND NOT EXISTS", "زمانِ مرگِ نادرست «کهنه» شمرده نمی‌شود")  # 33
m(READ, "  if (row[\"state\"] !== \"dead\") throw corrupt(BAD);\n", "", "ردیفِ غیرِ‌مرده پذیرفته می‌شود")  # 34
m(READ, "  if (!DEAD.has(deadReason)) throw corrupt(BAD);\n", "", "دلیلِ مرگِ نامعتبر پذیرفته می‌شود")  # 35
m(READ, "  if ((closeRemainder === null) !== (closeOrigin === null)) throw corrupt(BAD);\n", "", "قصدِ بستنِ نیم‌کاره پذیرفته می‌شود")  # 36
m(READ, "  if ((attemptId === null) !== (amount === null)) throw corrupt(BAD);\n", "", "قصدِ مصرفِ نیم‌کاره پذیرفته می‌شود")  # 37
m(READ, "      } catch {\n        return storeFailure();", "      } catch {\n        return { ok: true, value: [] };", "شکستِ پایگاه «پسماندِ خالی» گزارش می‌شود (خطرناک‌ترین)")  # 38
# ───── مهاجرت‌دهنده و سازنده ─────
m(MGR, "      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement-pending:migrate:${schema}`}, 0))`);\n", "", "قفلِ مشورتیِ خودِ ماژول حذف می‌شود")  # 39
m(MGR, "      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:migrate:${schema}`}, 0))`);\n", "", "قفلِ مهاجرتِ settlement حذف می‌شود")  # 40
m(MGR, "      await assertSettlementTables(tx, schema);\n", "", "پیش‌نیازِ settlement سنجیده نمی‌شود")  # 41
m(MGR, "    if (stored !== migrationChecksum(m)) {", "    if (false) {", "checksum ناهمخوان پذیرفته می‌شود")  # 42
m(MGR, "    if (!known.has(row.name)) {", "    if (false) {", "مهاجرتِ ناشناخته پذیرفته می‌شود")  # 43
m(MGR, "    if (pending.length > 0) {\n      throw new PendingStoreError({ code: \"MIGRATION_TAMPERED\", message: `مهاجرت «${m.name}» اعمال شده", "    if (false) {\n      throw new PendingStoreError({ code: \"MIGRATION_TAMPERED\", message: `مهاجرت «${m.name}» اعمال شده", "حفرهٔ دفتر پذیرفته می‌شود")  # 44
m(STORE, "  const readTimeout = parseReadStatementTimeout(options.readStatementTimeoutMs);\n  if (!readTimeout.ok) return readTimeout;\n", "  const readTimeout = { ok: true as const, value: null };\n", "گزینهٔ سقفِ زمان نادیده گرفته می‌شود")  # 45
m(STORE, "  const schema = parseSchemaName(options.schema ?? SETTLEMENT_DEFAULT_SCHEMA);\n  if (!schema.ok) return schema;\n", "  const schema = { ok: true as const, value: options.schema ?? SETTLEMENT_DEFAULT_SCHEMA };\n", "نامِ شِما اعتبارسنجی نمی‌شود")  # 46

m(MGR, "      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:migrate:${schema}`}, 0))`);\n      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement-pending:migrate:${schema}`}, 0))`);\n", "", "هر دو قفلِ مشورتیِ مهاجرت با هم حذف می‌شوند")  # 47


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with open(os.path.join(ROOT, p), "w", encoding="utf-8") as f:
        f.write(s)


def main():
    lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
    bad = [i for i, (src, old, _n, _w) in enumerate(M) if read(src).count(old) != 1]
    if bad:
        print("پیش‌بازرسی ناموفق: متنِ اصلیِ این جهش‌ها دقیقاً یک بار در فایل نیست:", bad)
        sys.exit(2)
    files = sorted({src for src, *_ in M})
    orig = {p: read(p) for p in files}
    survived = []
    try:
        for i in range(lo, hi + 1):
            src, old, new, why = M[i]
            write(src, orig[src].replace(old, new, 1))
            r = subprocess.run(["npx", "vitest", "run", "-t", SKIP, *TESTS], cwd=ROOT, capture_output=True, text=True)
            killed = r.returncode != 0
            if not killed and i not in EQUIVALENT:
                survived.append((i, why))
            label = "KILLED" if killed else ("EQUIV " if i in EQUIVALENT else "ALIVE ")
            print(f"[{i:02d}] {label}  {why}", flush=True)
            write(src, orig[src])
    finally:
        for p, s in orig.items():
            write(p, s)
    print(f"\nجهش‌ها: {hi - lo + 1} | زندهٔ توضیح‌نشده: {len(survived)} | هم‌ارزِ مستند: {len([i for i in EQUIVALENT if lo <= i <= hi])}")
    for i, why in survived:
        print(f"  زنده [{i}] {why}")
    sys.exit(1 if survived else 0)


if __name__ == "__main__":
    main()
