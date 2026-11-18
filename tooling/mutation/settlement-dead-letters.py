#!/usr/bin/env python3
"""
آزمون جهشی «زنگِ ماندگار در حلقهٔ رفتگر» در ماژول settlement (برش م۳‑د‑۲؛ ADR-0026): هر جهش یک تغییر کوچکِ معنادار در کد من
(نه در آزمون‌ها) است که باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده = ضعفِ آزمون (یا جهشِ هم‌ارز که باید توضیح داده شود).
اجرا:  python3 tooling/mutation/settlement-dead-letters.py            (همه)
       python3 tooling/mutation/settlement-dead-letters.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و پایگاه (DATABASE_URL یا KB_TEST_DATABASE_URL)؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل‌ها هست؛ فایل اصلی پس از هر جهش همیشه برمی‌گردد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement/"
TESTS = [
    B + "sweep-loop.dead-letters.test.ts",
    B + "sweep-loop.dead-letters.property.test.ts",
    B + "sweep-loop.dead-letters.integration.test.ts",
    B + "sweep-loop.dead-letters.pg.test.ts",
    B + "sweep-loop.test.ts",
]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


L = "sweep-loop.ts"
# ── تأیید فقط پس از تحویلِ موفق
m(L, "acked = isOk(await dl.outbox.acknowledgeDead(item.ref, { atMs }));", "await dl.outbox.acknowledgeDead(item.ref, { atMs });\n            acked = true;", "شکستِ تأیید نادیده گرفته می‌شود (رکورد «تأییدشده» حساب می‌شود)")
m(L, "        if (!delivered) {", "        if (false as boolean) {", "تأیید حتی وقتی تحویل شکست خورده")
m(L, "          () => finish(true),", "          () => finish(false),", "تحویلِ موفق هرگز موفق حساب نمی‌شود")
m(L, "          () => finish(false),\n        );", "          () => finish(true),\n        );", "رد‌شدنِ deliver موفق حساب می‌شود")
m(L, "      } catch {\n        finish(false);\n      }\n    });\n  }", "      } catch {\n        finish(true);\n      }\n    });\n  }", "پرتابِ همگامِ deliver موفق حساب می‌شود")
m(L, "        if (atMs !== null) {\n          try {\n            acked", "        if (true as boolean) {\n          try {\n            acked", "تأیید با ساعتِ نامعتبر")
# ── مهلت و زمان‌سنج
m(L, "        armedTimeout = false;\n        finish(false);\n        return;", "        armedTimeout = false;", "زمان‌سنجِ خراب: deliver بی‌مهلت صدا زده می‌شود")
m(L, "      if (settled) return; // زمان‌سنجِ همگام", "      // (حذف)", "زمان‌سنجِ همگام: deliver پس از گذشتنِ مهلت صدا زده می‌شود")
m(L, "        const h = cfg.timer.after(() => finish(false), timeoutMs);", "        const h = cfg.timer.after(() => undefined, timeoutMs);", "مهلت هرگز اعمال نمی‌شود (deliverِ آویزان حلقه را می‌بندد)")
m(L, "        if (armedTimeout) {\n          try {\n            cfg.timer.cancel(timeoutHandle);", "        if (false as boolean) {\n          try {\n            cfg.timer.cancel(timeoutHandle);", "تایمرِ مهلت پس از پایانِ deliver لغو نمی‌شود (نشتِ تایمر)")
# ── رکوردِ مسموم و تخلیه
m(L, "          failed.add(item.key);\n          dead.deliverFailures", "          dead.deliverFailures", "رکوردِ مسموم از دسته‌های همان گذر کنار نمی‌رود (چندین تلاش)")
m(L, "          failed.add(item.key);\n          dead.ackFailures", "          dead.ackFailures", "رکوردِ تأییدنشده از دسته‌های همان گذر کنار نمی‌رود")
m(L, "dl.batchLimit + failed.size)", "dl.batchLimit)", "رکوردهای مسموم گرسنگی می‌دهند")
m(L, "      if (listed.length < want) return { fault, more: false }; // همهٔ", "      if (false as boolean) return { fault, more: false }; // همهٔ", "پایانِ فهرست تشخیص داده نمی‌شود")
m(L, "      if (batch === dl.maxBatchesPerRun - 1) more = true;", "      if (false as boolean) more = true;", "تخلیه: گذرِ بعد بی‌انتظار نیست")
m(L, "        deadMore = d.more;", "        deadMore = false;", "تخلیه: more نادیده گرفته می‌شود")
m(L, "      if (!alive()) return { fault, more: false };\n      const want", "      const want", "stop پیش از هر دسته نادیده گرفته می‌شود")
m(L, "        if (!alive()) return { fault, more: false };\n        const delivered", "        const delivered", "stop میانِ رکوردها نادیده گرفته می‌شود")
m(L, "    const anyFault = fault ?? deadFault;", "    const anyFault = fault;", "شکستِ زنگ عقب‌نشینی/شکستِ پیاپی نمی‌شمارد")
m(L, "    if (deadFault !== null) emitFault(deadFault, nextDelayMs);\n", "", "خطای زنگ اعلام نمی‌شود")
m(L, "        dead.lastAckAtMs = atMs;", "", "lastAckAtMs ثبت نمی‌شود")
m(L, "deadLetters: Object.freeze({ enabled: cfg.deadLetters !== null, ...dead })", "deadLetters: Object.freeze({ enabled: true, ...dead })", "enabled همیشه true")
m(L, "      } catch {\n        deadFault = \"DEAD_LIST_FAILED\";\n      }", "      } catch {\n        deadFault = null;\n      }", "پرتابِ درونی بی‌خطا")
m(L, "        dead.listFailures = cap(dead.listFailures + 1);\n        note(\"DEAD_LIST_FAILED\");", "        note(\"DEAD_LIST_FAILED\");", "شمارندهٔ خطای فهرست")
# ── اعتبارسنجیِ فهرست
P = "loop-policy.ts"
m(P, 'state !== "dead" || typeof deadReason', "typeof deadReason", "رکوردِ غیرمرده پذیرفته می‌شود")
m(P, "raw.length > maxItems", "false", "فهرستِ بزرگ‌تر از limit پذیرفته می‌شود")
m(P, "if (!isCount(reserved) || !isCount(attempts)) return null;", "", "مبلغ/تلاشِ نامعتبر پذیرفته می‌شود")
m(P, "  if (settledAtMs !== null && !isTime(settledAtMs)) return null;\n", "", "زمانِ مرگِ نامعتبر پذیرفته می‌شود")
m(P, "  if (lastErrorCode !== null && !isShort(lastErrorCode)) return null;\n", "", "کدِ خطای نامعتبر پذیرفته می‌شود")
m(P, "      if (p === null) return null;", "      if (p === null) continue;", "رکوردِ خراب رد می‌شود ولی بقیه تأیید می‌شوند (به‌جای ردِ کلِ فهرست)")
m(P, "deadAtMs: settledAtMs }", "deadAtMs: null }", "زمانِ مرگ به نامه نمی‌رسد")
m(P, "!isShort(tenantId) || !isShort(accountId) || !isShort(reservationId) || !isShort(unit)) return null;\n  if (state", "!isShort(tenantId) || !isShort(accountId) || !isShort(reservationId)) return null;\n  if (state", "unit بی‌اعتبارسنجی")
# ── پیکربندی
C = "config.ts"
m(C, 'if (typeof raw["deliver"] !== "function")', "if (false as boolean)", "deliver بی‌اعتبارسنجی")
m(C, '["listUnacknowledgedDead", "acknowledgeDead"])', '["listUnacknowledgedDead"])', "acknowledgeDead در outbox بی‌اعتبارسنجی")
m(C, "isIntIn(batchLimit, 1, SETTLEMENT_LIMITS.maxDeadBatchLimit)", "isIntIn(batchLimit, 0, SETTLEMENT_LIMITS.maxDeadBatchLimit)", "batchLimit=0 مجاز")
m(C, "isIntIn(batchLimit, 1, SETTLEMENT_LIMITS.maxDeadBatchLimit)", "isIntIn(batchLimit, 1, Infinity)", "batchLimit بی‌سقف")
m(C, "isIntIn(batches, 1, SETTLEMENT_LIMITS.maxDeadBatchesPerRun)", "isIntIn(batches, 0, SETTLEMENT_LIMITS.maxDeadBatchesPerRun)", "maxBatchesPerRun=0 مجاز")
m(C, "isIntIn(batches, 1, SETTLEMENT_LIMITS.maxDeadBatchesPerRun)", "isIntIn(batches, 1, Infinity)", "maxBatchesPerRun بی‌سقف")
m(C, "isIntIn(timeout, 1, SETTLEMENT_LIMITS.maxDeliverTimeoutMs)", "isIntIn(timeout, 0, SETTLEMENT_LIMITS.maxDeliverTimeoutMs)", "deliverTimeoutMs=0 مجاز")
m(C, "isIntIn(timeout, 1, SETTLEMENT_LIMITS.maxDeliverTimeoutMs)", "isIntIn(timeout, 1, Infinity)", "deliverTimeoutMs بی‌سقف")
m(C, "defaultDeliverTimeoutMs: 30_000", "defaultDeliverTimeoutMs: 31_000", "پیش‌فرضِ مهلت عوض می‌شود")
m(C, "defaultDeadBatchesPerRun: 5", "defaultDeadBatchesPerRun: 1", "پیش‌فرضِ دسته‌ها عوض می‌شود")
m(C, "if (!DEAD_LETTER_KEYS.has(k))", "if (false as boolean)", "کلیدِ ناشناختهٔ deadLetters پذیرفته می‌شود")
m(C, '"observer", "deadLetters"]);', '"observer"]);', "deadLetters در کلیدهای مجازِ حلقه نیست")

EQUIVALENT: dict[int, str] = {
    22: "catch دفاعیِ دسترس‌ناپذیر: deliverDead خودش هر وابسته (outbox، deliver، ساعت، زمان‌سنج) را جدا می‌پوشاند و نمی‌پرتابد؛ این catch فقط «حلقه هرگز نمی‌پرتابد» را برای خطای برنامه‌نویسیِ آینده تضمین می‌کند",
}

env = dict(os.environ)
if not (env.get("KB_TEST_DATABASE_URL") or env.get("DATABASE_URL")):
    print("پایگاه تنظیم نشده است (DATABASE_URL)."); sys.exit(2)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
    src = open(os.path.join(ROOT, B, f), encoding="utf8").read()
    if src.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {f}: {old[:70]!r}"); sys.exit(2)
if not tests_pass():
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, B, f)
    src = open(path, encoding="utf8").read()
    open(path, "w", encoding="utf8").write(src.replace(old, new, 1))
    try:
        ok = tests_pass()
    finally:
        open(path, "w", encoding="utf8").write(src)
    if ok and i not in EQUIVALENT:
        alive.append((i, f, why)); print(f"[{i:02d}] ✗ زنده: {f} — {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {f} — {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
