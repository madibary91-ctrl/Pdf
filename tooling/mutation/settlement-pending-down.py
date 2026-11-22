#!/usr/bin/env python3
"""
آزمون جهشی «برگشتِ رسمیِ نمایهٔ مرده‌های در انتظارِ تأیید» (`down` در ماژول settlement-pending؛ برش ب‑۲‑۲‑۱، ADR-0048): هر جهش یک تغییر کوچکِ معنادار
در منبعِ برگشت (`migrate.ts: down`، `migrations.ts: ROLLBACKS`، `store.ts`) است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/settlement-pending-down.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/settlement-pending-down.py 3 9                    (فقط جهش‌های ۳ تا ۹)
هر جهش نخست با آزمون‌های سریع (بی‌پایگاه: down.unit، down.order، unit، purity) سنجیده می‌شود؛ فقط اگر زنده ماند، `down.pg.test.ts` (PostgreSQL واقعی، کُند؛ ≈۲۰ثانیه) هم اجرا می‌شود.
جزو CI نیست. پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-pending/"
FAST = [B + "down.unit.test.ts", B + "down.order.test.ts", B + "unit.test.ts", B + "purity.test.ts"]
SLOW = [B + "down.pg.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


D, G, ST = "migrate.ts", "migrations.ts", "store.ts"
# ── migrations.ts: متنِ برگشت
m(G, "    `DROP TRIGGER IF EXISTS settlement_pending_ack ON ${S}.settlement_dead_ack`,\n", "", "TRIGGERِ تأیید برداشته نمی‌شود (تأیید بعدی روی جدولِ ناموجود می‌خورد)")
m(G, "    `DROP TRIGGER IF EXISTS settlement_pending_dead_upd ON ${S}.settlement_outbox`,\n", "", "TRIGGERِ گذار به dead برداشته نمی‌شود")
m(G, "    `DROP TRIGGER IF EXISTS settlement_pending_dead_ins ON ${S}.settlement_outbox`,\n", "", "TRIGGERِ درجِ dead برداشته نمی‌شود")
m(G, "    `DROP FUNCTION IF EXISTS ${S}.settlement_pending_guard()`,\n", "", "تابعِ نگهبان جا می‌ماند")
m(G, "    `DROP FUNCTION IF EXISTS ${S}.settlement_pending_on_ack()`,\n", "", "تابعِ تأیید جا می‌ماند")
m(G, "    `DROP FUNCTION IF EXISTS ${S}.settlement_pending_on_dead()`,\n", "", "تابعِ ورود به dead جا می‌ماند")
m(G, "    `DROP TABLE IF EXISTS ${S}.settlement_dead_pending`,", "    `DROP TABLE IF EXISTS ${S}.settlement_dead_pending CASCADE`,", "CASCADE: شیءِ دیگران بی‌صدا حذف می‌شود")
m(G, "    `DROP TABLE IF EXISTS ${S}.settlement_dead_pending`,", "    `DROP TABLE ${S}.settlement_dead_pending`,", "جدولِ نبوده خطا می‌دهد (برگشتِ نصبِ ناقص ناممکن)")
m(G, "`DROP TRIGGER IF EXISTS settlement_pending_ack ON ${S}.settlement_dead_ack`", "`DROP TRIGGER settlement_pending_ack ON ${S}.settlement_dead_ack`", "TRIGGERِ حذف‌شده با دست برگشت را می‌شکند (IF EXISTS برداشته شد)")
m(G, "    `SET LOCAL lock_timeout = '15s'`,\n    `LOCK TABLE ${S}.settlement_outbox, ${S}.settlement_dead_ack IN ACCESS EXCLUSIVE MODE`,", "    `LOCK TABLE ${S}.settlement_outbox, ${S}.settlement_dead_ack IN ACCESS EXCLUSIVE MODE`,", "بی lock_timeout: برگشت بی‌پایان در صف می‌ماند")
m(G, "    `SET LOCAL lock_timeout = '15s'`,\n    `LOCK TABLE ${S}.settlement_outbox, ${S}.settlement_dead_ack IN ACCESS EXCLUSIVE MODE`,", "    `SET LOCAL lock_timeout = '150s'`,\n    `LOCK TABLE ${S}.settlement_outbox, ${S}.settlement_dead_ack IN ACCESS EXCLUSIVE MODE`,", "lock_timeout ده برابر")
m(G, "IN ACCESS EXCLUSIVE MODE`,\n\n    `DROP TRIGGER", "IN ACCESS EXCLUSIVE MODE`,\n    `LOCK TABLE ${S}.settlement_dead_pending IN ACCESS EXCLUSIVE MODE`,\n\n    `DROP TRIGGER", "قفلِ اضافه (نمایه) پیش از DROP؛ ترتیبِ قفل با نصب فرق می‌کند")
m(G, "${S}.settlement_outbox, ${S}.settlement_dead_ack IN ACCESS EXCLUSIVE MODE", "${S}.settlement_dead_ack, ${S}.settlement_outbox IN ACCESS EXCLUSIVE MODE", "ترتیبِ قفل‌ها وارونه (بن‌بستِ بالقوه با نویسنده‌ها)")
m(G, "IN ACCESS EXCLUSIVE MODE", "IN SHARE ROW EXCLUSIVE MODE", "قفلِ ضعیف‌تر از نیازِ DROP TRIGGER")
m(G, "return Object.hasOwn(ROLLBACKS, name) ? ROLLBACKS[name] : undefined;", "return ROLLBACKS[name];", "نام‌های Object.prototype (constructor…) «برگشت» می‌شوند")
# ── migrate.ts: down
m(D, "      const present = await tx.execute(sql`SELECT to_regclass(${`${JSON.stringify(schema)}.${LEDGER}`}) IS NOT NULL AS present`);\n      if (present.rows[0]?.[\"present\"] !== true) return { reverted: [] } satisfies PendingDownReport;\n", "", "نصب‌نشده هم خوانده/برگشت می‌شود (دفتر ناموجود خطا می‌دهد)")
m(D, 'if (present.rows[0]?.["present"] !== true) return', 'if (present.rows[0]?.["present"] === true) return', "شرطِ بی‌کاری وارونه")
m(D, "      const status = reconcile(await readLedger(tx, schema));\n      // برگشتِ همهٔ", "      const status = { applied: (await readLedger(tx, schema)).map((r) => r.name), pending: [] as string[] };\n      // برگشتِ همهٔ", "دفترِ دست‌کاری/ناشناخته بررسی نمی‌شود")
m(D, "const plan = [...status.applied].reverse().map(", "const plan = [...status.applied].map(", "ترتیبِ برگشت معکوس نیست")
m(D, "      if (plan.length > 0) {\n        await assertSettlementTables(tx, schema);", "      if (plan.length > 0) {", "پیش‌نیازِ جدول‌های settlement نسنجیده می‌ماند")
m(D, "if (statements === undefined) throw new PendingStoreError", "if (statements === undefined) return { name, statements: [] as readonly string[] }; if (false) throw new PendingStoreError", "برگشتِ گم‌شده بی‌صدا نادیده گرفته می‌شود")
m(D, "          await tx.execute(sql`DELETE FROM ${tableRef(schema, LEDGER)} WHERE name = ${step.name}`);\n", "", "ردیفِ دفتر حذف نمی‌شود (دفتر می‌گوید نصب است ولی نیست)")
m(D, "      if ((await readLedger(tx, schema)).length === 0) await tx.execute(sql`DROP TABLE ${tableRef(schema, LEDGER)}`);", "", "دفترِ خالی جا می‌ماند (حالت با پیش از نصب فرق دارد)")
m(D, "if ((await readLedger(tx, schema)).length === 0) await", "if (true) await", "دفترِ غیرخالی هم حذف می‌شود")
m(D, "await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:migrate:${schema}`}, 0))`);\n      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement-pending:migrate:${schema}`}, 0))`);\n      const present", "await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement-pending:migrate:${schema}`}, 0))`);\n      const present", "قفلِ مشورتیِ settlement گرفته نمی‌شود (با مهاجرتِ settlement سریال نمی‌شود)")
m(D, "await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:migrate:${schema}`}, 0))`);\n      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement-pending:migrate:${schema}`}, 0))`);\n      const present", "await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:migrate:${schema}`}, 0))`);\n      const present", "قفلِ مشورتیِ pending گرفته نمی‌شود (با migrate/down ی هم‌زمان سریال نمی‌شود)")
m(D, "await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:migrate:${schema}`}, 0))`);\n      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement-pending:migrate:${schema}`}, 0))`);\n      const present", "await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement-pending:migrate:${schema}`}, 0))`);\n      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:migrate:${schema}`}, 0))`);\n      const present", "ترتیبِ قفل‌های مشورتی وارونه (بن‌بستِ بالقوه با migrate)")
m(D, "return { ok: true, value: report };\n  } catch (e) {\n    return { ok: false, error: toStoreError(e).error };\n  }\n}\n\n/** فقط‌خواندنی", "return { ok: true, value: report };\n  } catch (e) {\n    throw e;\n  }\n}\n\n/** فقط‌خواندنی", "down می‌پرتابد")
# ── store.ts
m(ST, "down: () => down(db, schema.value),", 'down: () => down(db, "settlement"),', "down همیشه روی شِمای پیش‌فرض می‌زند (نه شِمای تنظیم‌شده)")
m(ST, "down: () => down(db, schema.value),", "down: () => migrate(db, schema.value) as never,", "down در واقع migrate می‌کند")

# هم‌ارزهای مستند (جهشی که رفتارِ بیرونی را عوض نمی‌کند). هر مورد با دلیل.
EQUIVALENT_BY_WHY = {}
EQUIVALENT: dict = {}
for _i, (_f, _o, _n, _why) in enumerate(M):
    if _why in EQUIVALENT_BY_WHY:
        EQUIVALENT[_i] = EQUIVALENT_BY_WHY[_why]

env = dict(os.environ)


def passes(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
origs = {}
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
    p = os.path.join(ROOT, B, f)
    origs.setdefault(f, open(p, encoding="utf8").read())
    if origs[f].count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد در {f}: {old[:80]!r}"); sys.exit(2)
    if new == old:
        print(f"[{i}] جهش بی‌اثر است: {why}"); sys.exit(2)
if not passes(FAST + SLOW):
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, B, f)
    open(path, "w", encoding="utf8").write(origs[f].replace(old, new, 1))
    try:
        ok = passes(FAST)
        slow_killed = False
        if ok:
            ok = passes(SLOW)
            slow_killed = not ok
    finally:
        open(path, "w", encoding="utf8").write(origs[f])
    if ok and i not in EQUIVALENT:
        alive.append((i, why)); print(f"[{i:02d}] ✗ زنده: {why}", flush=True)
    else:
        killed += 1
        print(f"[{i:02d}] ✓ کشته{' (فقط PostgreSQL)' if slow_killed else ''}: {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
