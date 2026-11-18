#!/usr/bin/env python3
"""
آزمون جهشی «تأیید رسیدگی به مرده‌ها» در ماژول settlement (برش م۳‑د‑۱؛ ADR-0025): هر جهش یک تغییر کوچکِ معنادار در کد منبع است؛ آزمون‌های تازهٔ این برش باید قرمز شوند.
اجرا:  python3 tooling/mutation/settlement-dead-ack.py            (همه)
       python3 tooling/mutation/settlement-dead-ack.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و پایگاه (DATABASE_URL یا KB_TEST_DATABASE_URL)؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل‌ها هست؛ فایل اصلی پس از هر جهش همیشه برمی‌گردد.

جهش‌های SQL (migrations.ts) فقط با آزمونِ «رفتار پایگاه» (`dead-ack.pg.test.ts`) سنجیده می‌شوند، نه با `dead-ack.unit.test.ts`: هر ویرایشِ مهاجرت checksum قفل‌شده را
می‌شکند و آن تست همه را «بی‌ارزش» می‌کُشد؛ می‌خواهیم **رفتارِ** پایگاه جهش را بگیرد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement/"
NEW_TESTS = [B + "memory-dead-ack.test.ts", B + "pg/dead-ack.unit.test.ts", B + "pg/dead-ack.pg.test.ts"]
SQL_TESTS = [B + "pg/dead-ack.pg.test.ts"]
M = []


def m(f, old, new, why, tests=None):
    M.append((f, old, new, why, tests or (SQL_TESTS if f.endswith("migrations.ts") else NEW_TESTS)))


# ── memory-outbox.ts
m("memory-outbox.ts", 'e.state === "dead" && !acks.has(keyOf(e))', 'e.state === "dead"', "فهرستِ تأییدنشده، تأییدشده‌ها را هم دارد")
m("memory-outbox.ts", 'e.state === "dead" && !acks.has(keyOf(e))', "!acks.has(keyOf(e))", "فهرستِ تأییدنشده، رکوردهای غیرمرده را هم دارد")
m("memory-outbox.ts", '        if (e.state !== "dead") return conflict("فقط رکوردِ مرده تأیید رسیدگی می‌شود.");\n', "", "تأیید رکوردِ غیرمرده مجاز است")
m("memory-outbox.ts", "        if (acks.has(keyOf(e))) return ok({ replayed: true });\n", "", "تأییدِ تکراری replayed نیست")
m("memory-outbox.ts", "        acks.set(keyOf(e), a.value.atMs);\n", "", "تأیید ذخیره نمی‌شود")
m("memory-outbox.ts", "!acks.has(keyOf(e))).sort(byDeath)", "!acks.has(keyOf(e)))", "ترتیبِ (زمان مرگ، شناسه) در فهرستِ تأییدنشده")
m("memory-outbox.ts", "e.state === \"dead\" && !acks.has(keyOf(e))", "e.state === \"dead\" && !acks.has(e.reservationId)", "تأیید فقط با شناسهٔ رزرو (نه هویتِ سه‌بخشی) سنجیده می‌شود")
m("memory-outbox.ts", "        return ok(Object.freeze(dead.slice(0, l.value).map(view)));\n      }),\n\n    acknowledgeDead", "        return ok(dead.slice(0, l.value).map(view));\n      }),\n\n    acknowledgeDead", "فهرستِ تأییدنشده منجمد نیست")
m("memory-outbox.ts", "        if (e === undefined) return notFound();\n        if (e.state !== \"dead\")", "        if (e === undefined) return conflict(\"x\");\n        if (e.state !== \"dead\")", "بی‌رکورد ⇒ NOT_FOUND نیست")
# ── validate.ts
m("validate.ts", "    if (!isCount(atMs)) return invalid();\n    return { ok: true, value: Object.freeze({ atMs }) };", "    return { ok: true, value: Object.freeze({ atMs: atMs as number }) };", "زمانِ تأیید اعتبارسنجی نمی‌شود")
# ── pg/store.ts
m("pg/store.ts", "            AND NOT EXISTS (SELECT 1 FROM ${A} a WHERE a.tenant_id = o.tenant_id AND a.account_id = o.account_id AND a.reservation_id = o.reservation_id)\n", "", "فهرست: ضدپیوند با جدول تأیید نیست")
m("pg/store.ts", "          WHERE o.state = 'dead'\n            AND NOT EXISTS", "          WHERE o.state <> 'done'\n            AND NOT EXISTS", "فهرست: رکوردهای فعال را هم می‌آورد")
m("pg/store.ts", "ORDER BY o.settled_at_ms, o.tenant_id, o.account_id, o.reservation_id\n          LIMIT", "ORDER BY o.tenant_id, o.account_id, o.reservation_id\n          LIMIT", "فهرست: ترتیبِ زمانِ مرگ")
m("pg/store.ts", "a.account_id = o.account_id AND ", "", "ضدپیوند: حساب مقایسه نمی‌شود")
m("pg/store.ts", "a.tenant_id = o.tenant_id AND ", "", "ضدپیوند: مستأجر مقایسه نمی‌شود")
m("pg/store.ts", "AND a.reservation_id = o.reservation_id)", "AND true)", "ضدپیوند: رزرو مقایسه نمی‌شود")
m("pg/store.ts", "        return ok(Object.freeze(res.rows.map(entryFromRow)));\n      }, true);\n    },\n\n    acknowledgeDead", "        return ok(Object.freeze(res.rows.map(entryFromRow)));\n      });\n    },\n\n    acknowledgeDead", "فهرستِ تأییدنشده فقط‌خواندنی نیست")
m("pg/store.ts", '        if (e.state !== "dead") return conflict("فقط رکوردِ مرده تأیید رسیدگی می‌شود.");\n', "", "تأیید: بی‌بررسیِ مرده‌بودن در آداپتور")
m("pg/store.ts", "return ok({ replayed: ins.rows.length === 0 });", "return ok({ replayed: false });", "تأیید: replayed همیشه false")
m("pg/store.ts", "return ok({ replayed: ins.rows.length === 0 });", "return ok({ replayed: true });", "تأیید: replayed همیشه true")
m("pg/store.ts", "          ON CONFLICT (tenant_id, account_id, reservation_id) DO NOTHING\n          RETURNING 1 AS inserted`);\n        return ok({ replayed: ins", "          RETURNING 1 AS inserted`);\n        return ok({ replayed: ins", "تأیید بی‌ON CONFLICT")
m("pg/store.ts", "        const e = await select(tx, ref2, true);\n        if (e === null) return notFound();\n        if (e.state !== \"dead\")", "        const e = await select(tx, ref2, false);\n        if (e === null) return notFound();\n        if (e.state !== \"dead\")", "تأیید بی‌قفلِ ردیف")
m("pg/store.ts", "if (e === null) return notFound();\n        if (e.state !== \"dead\")", "if (e === null) return conflict(\"x\");\n        if (e.state !== \"dead\")", "تأیید: بی‌رکورد ⇒ NOT_FOUND نیست")
m("pg/store.ts", "VALUES (${ref2.tenantId}, ${ref2.accountId}, ${ref2.reservationId}, ${want.atMs})", "VALUES (${ref2.tenantId}, ${ref2.accountId}, ${ref2.reservationId}, 0)", "زمانِ تأیید ثبت نمی‌شود")
# ── pg/migrations.ts (0002): فقط با رفتارِ پایگاه
m("pg/migrations.ts", "IF TG_OP <> 'INSERT' THEN", "IF false THEN", "تأیید ویرایش/حذف‌پذیر است")
m("pg/migrations.ts", "o.reservation_id = NEW.reservation_id AND o.state = 'dead'", "o.reservation_id = NEW.reservation_id", "تأییدِ رکوردِ غیرمرده در پایگاه مجاز است")
m("pg/migrations.ts", "o.tenant_id = NEW.tenant_id AND o.account_id = NEW.account_id AND o.reservation_id = NEW.reservation_id", "o.account_id = NEW.account_id AND o.reservation_id = NEW.reservation_id", "وجودِ رکورد بی‌مستأجر سنجیده می‌شود")
m("pg/migrations.ts", "o.tenant_id = NEW.tenant_id AND o.account_id = NEW.account_id AND o.reservation_id = NEW.reservation_id", "o.tenant_id = NEW.tenant_id AND o.reservation_id = NEW.reservation_id", "وجودِ رکورد بی‌حساب سنجیده می‌شود")
m("pg/migrations.ts", "o.tenant_id = NEW.tenant_id AND o.account_id = NEW.account_id AND o.reservation_id = NEW.reservation_id", "o.tenant_id = NEW.tenant_id AND o.account_id = NEW.account_id", "وجودِ رکورد بی‌رزرو سنجیده می‌شود")
m("pg/migrations.ts", "BEFORE INSERT OR UPDATE OR DELETE ON ${S}.settlement_dead_ack", "BEFORE INSERT ON ${S}.settlement_dead_ack", "TRIGGER فقط روی درج")
m("pg/migrations.ts", "CREATE TRIGGER settlement_dead_ack_no_truncate BEFORE TRUNCATE ON ${S}.settlement_dead_ack", "CREATE TRIGGER settlement_dead_ack_no_truncate BEFORE TRUNCATE ON ${S}.settlement_outbox", "ضدTRUNCATE روی جدولِ تأیید نیست")
m("pg/migrations.ts", "PRIMARY KEY (tenant_id, account_id, reservation_id)\n     )`,\n    `CREATE FUNCTION ${S}.settlement_dead_ack_guard", "PRIMARY KEY (reservation_id)\n     )`,\n    `CREATE FUNCTION ${S}.settlement_dead_ack_guard", "کلیدِ تأیید فقط شناسهٔ رزرو")
m("pg/migrations.ts", "acked_at_ms ${S}.settlement_count NOT NULL", "acked_at_ms bigint NOT NULL", "زمانِ تأیید بی‌دامنه")
m("pg/migrations.ts", "reservation_id ${S}.settlement_id NOT NULL,\n       acked_at_ms", "reservation_id text NOT NULL,\n       acked_at_ms", "شناسهٔ رزرو بی‌دامنه")

EQUIVALENT: dict[int, str] = {}

env = dict(os.environ)
if not (env.get("KB_TEST_DATABASE_URL") or env.get("DATABASE_URL")):
    print("پایگاه تنظیم نشده است (DATABASE_URL)."); sys.exit(2)


def tests_pass(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
for i, (f, old, new, why, _t) in enumerate(M):  # پیش‌بازرسی
    src = open(os.path.join(ROOT, B, f), encoding="utf8").read()
    if src.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {f}: {old[:70]!r}"); sys.exit(2)
if not tests_pass(NEW_TESTS):
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why, tests) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, B, f)
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
