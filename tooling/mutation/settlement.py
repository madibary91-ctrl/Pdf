#!/usr/bin/env python3
"""
آزمون جهشی ماژول settlement (ADR-0021): هر جهش یک تغییر کوچکِ معناداری در کد منبع است؛ مجموعهٔ آزمون باید قرمز شود (جهش «کشته شود»).
اجرا:  python3 tooling/mutation/settlement.py        (بدون پایگاه؛ تست‌های حافظه‌ای کافی‌اند)
جهش زنده = ضعفِ آزمون، مگر با دلیل در فهرست EQUIVALENT مستند شود. فایل اصلی همیشه پس از هر جهش برمی‌گردد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = "src/modules/settlement/"
M = [
    # (فایل، قطعهٔ اصلی، جایگزین، توضیح)
    # ── دکوراتور دفتر
    ("durable-ledger.ts", "if (c.ttlMs < 2 * cfg.graceMs)", "if (false)", "بی‌نگهبانِ نیمهٔ عمر رزرو"),
    ("durable-ledger.ts", "if (!res.ok || res.value.replayed) return res;", "if (!res.ok) return res;", "begin روی رزروِ بازتکراری"),
    ("durable-ledger.ts", 'reservationId: c.reservationId, remainder: "release" }));', 'reservationId: c.reservationId, remainder: "forfeit" }));', "بازگرداندنِ رزرو با سوخت"),
    ("durable-ledger.ts", "if (!begun.ok) {", "if (false) {", "شکست begin نادیده"),
    ("durable-ledger.ts", "if (!rec.ok) return toLedgerError(rec.error);\n      return safeLedger(() => ledger.charge", "return safeLedger(() => ledger.charge", "charge بی‌ثبتِ قصد (بازشکست)"),
    ("durable-ledger.ts", "if (!rec.ok) return toLedgerError(rec.error);\n      const res = await safeLedger(() => ledger.close", "const res = await safeLedger(() => ledger.close", "close بی‌ثبتِ قصد (بازشکست)"),
    ("durable-ledger.ts", "if (res.ok) {\n        // پایانِ رکورد", "if (true) {\n        // پایانِ رکورد", "finish حتی با شکستِ دفتر"),
    ("durable-ledger.ts", 'origin: "caller" }', 'origin: "sweeper" }', "origin اشتباه"),
    ("durable-ledger.ts", "dueAtMs: now + cfg.graceMs", "dueAtMs: now", "بی‌مهلتِ تماس"),
    ("durable-ledger.ts", "orphanRemainder: cfg.onUnknownCost", 'orphanRemainder: "release"', "سیاستِ یتیم نادیده"),
    ("durable-ledger.ts", "expiresAtMs: res.value.expiresAtMs", "expiresAtMs: now", "سررسید رکورد ≠ رسید دفتر"),
    # ── رفتگر
    ("sweeper.ts", "if (e.attempts + 1 < cfg.maxAttempts)", "if (e.attempts + 1 <= cfg.maxAttempts)", "مرز سقفِ تلاش"),
    ("sweeper.ts", "cfg.retryDelayMs * (e.attempts + 1)", "cfg.retryDelayMs", "بی‌افزایشِ تأخیر"),
    ("sweeper.ts", 'code === "RESERVATION_EXPIRED" ? "EXPIRED_UNBILLED" : "LEDGER_REJECTED"', 'code === "RESERVATION_EXPIRED" ? "LEDGER_REJECTED" : "EXPIRED_UNBILLED"', "دلیل مرگ برعکس"),
    ("sweeper.ts", "if (e.charge !== null) {\n      const intent", "if (false) {\n      const intent", "قصدِ مصرف اجرا نمی‌شود"),
    ("sweeper.ts", "remainder: close.remainder }", 'remainder: "release" }', "باقیمانده نادیده"),
    ("sweeper.ts", "const fin = await safeOutbox(() => cfg.outbox.finish(e, now));", "const fin = { ok: true as const, value: { replayed: false } };", "finish صدا زده نمی‌شود"),
    ("sweeper.ts", "if (!c.ok) return onLedgerError(e, c.error.code, now);", "if (!c.ok) void 0;", "شکستِ مصرف نادیده"),
    ("sweeper.ts", "if (!cl.ok) return onLedgerError(e, cl.error.code, now);", "if (!cl.ok) void 0;", "شکستِ بستن نادیده"),
    ("sweeper.ts", 'return rc.error.code === "STORE_FAILURE" ? { kind: "outbox-failure" } : { kind: "raced" };', 'return { kind: "raced" };', "خطای outbox = مسابقه"),
    ("sweeper.ts", '["STORE_FAILURE", "INTERNAL_ERROR"]', '["STORE_FAILURE"]', "INTERNAL_ERROR گذرا نیست"),
    ("sweeper.ts", "if (now === null) return Object.freeze({ ...EMPTY, listFailed: true });", "if (now === null) return EMPTY;", "ساعت خراب بی‌نشان"),
    ("sweeper.ts", 'else if (step.kind === "raced") raced += 1;', "", "شمارش raced"),
    ("sweeper.ts", "return b.error.code === \"NOT_ACTIVE\" || b.error.code === \"CONFLICT\" ? { kind: \"raced\" } : { kind: \"outbox-failure\" };", 'return { kind: "outbox-failure" };', "مسابقهٔ bury"),
    # ── outbox حافظه‌ای (و قرارداد)
    ("memory-outbox.ts", 'e.charge === null ? e.orphanRemainder : "release"', "e.orphanRemainder", "رفتگر با قصدِ مصرف سوخت می‌کند (بیش‌اخذ)"),
    ("memory-outbox.ts", 'if (e.close !== null) return conflict("پس از قصدِ بستن، قصدِ مصرف ممنوع است.");', "", "مصرف پس از قصدِ بستن"),
    ("memory-outbox.ts", 'if (e.close === null) return conflict("پایان بدون قصدِ بستن ممکن نیست.");', "", "finish بی‌قصدِ بستن"),
    ("memory-outbox.ts", "cur.reserved === b.reserved &&", "true &&", "begin: مبلغ مقایسه نمی‌شود"),
    ("memory-outbox.ts", "e.dueAtMs <= q.value.nowMs", "e.dueAtMs < q.value.nowMs", "مرز سررسید"),
    ("memory-outbox.ts", "a.dueAtMs - b.dueAtMs ||", "0 ||", "ترتیبِ سررسید"),
    ("memory-outbox.ts", "e.deadReason === b.value.reason ? ok({ replayed: true })", "true ? ok({ replayed: true })", "bury با دلیل دیگر"),
    ("memory-outbox.ts", "e.close.remainder === i.value.remainder ? ok({ replayed: true })", "e.close.origin === i.value.origin ? ok({ replayed: true })", "recordClose: مقایسهٔ origin"),
    ("memory-outbox.ts", "Object.freeze({ ...e.charge })", "e.charge", "کپیِ منجمدِ قصدِ مصرف"),
    ("memory-outbox.ts", "a.value.attempts += 1;", "a.value.attempts += 0;", "شمارندهٔ تلاش"),
    ("memory-outbox.ts", 'if (e.state === "done") return ok({ replayed: true });', 'if (e.state === "done") return notActive();', "finish بازتکراری"),
    # ── اعتبارسنجی، پیکربندی، ترجمه
    ("validate.ts", "reserved < 1", "reserved < 0", "رزرو صفر"),
    ("validate.ts", "raw <= LIST_LIMIT_MAX", "raw <= LIST_LIMIT_MAX + 1", "سقف limit"),
    ("config.ts", 'isIntIn(raw["graceMs"], 1, SETTLEMENT_LIMITS.maxGraceMs)', 'isIntIn(raw["graceMs"], 0, SETTLEMENT_LIMITS.maxGraceMs)', "graceMs صفر"),
    ("config.ts", 'if (isDecoratedLedger(raw["ledger"])) issues.push("رفتگر', 'if (false) issues.push("رفتگر', "رفتگر با دفتر دکوراته"),
    ("config.ts", 'if (isDecoratedLedger(raw["ledger"])) issues.push("ledger خودش', 'if (false) issues.push("ledger خودش', "دکوراتورِ دوباره"),
    ("durable-gateway.ts", "m.value.reservationTtlMs < 2 * d.value.graceMs", "m.value.reservationTtlMs < d.value.graceMs", "نگهبان ttl در کارخانه"),
    ("durable-gateway.ts", 'onUnknownCost: metering["onUnknownCost"]', 'onUnknownCost: "forfeit"', "سیاستِ یتیم از پیکربندی نیست"),
    ("durable-gateway.ts", "ledger: buildDurableLedger(d.value)", "ledger: d.value.ledger", "بی‌دکوراتور"),
    ("ports.ts", 'NOT_FOUND: "RESERVATION_NOT_FOUND"', 'NOT_FOUND: "RESERVATION_CLOSED"', "ترجمهٔ NOT_FOUND"),
    ("ports.ts", 'CONFLICT: "IDEMPOTENCY_CONFLICT"', 'CONFLICT: "INVALID_INPUT"', "ترجمهٔ CONFLICT"),
]
# جهش‌های هم‌ارز مستند: (هر جهشِ زنده باید تست بگیرد یا اینجا با دلیل ثبت شود).
EQUIVALENT: dict[int, str] = {
    # [32] `parseChargeIntent` پیش‌تر شیء را منجمد می‌کند؛ اشتراکِ مرجعِ یک شیءِ منجمد بی‌خطر است و هیچ رفتارِ قابل‌مشاهده‌ای عوض نمی‌شود.
    32: "کپیِ منجمدِ قصدِ مصرف: ورودیِ پارس‌شده از قبل منجمد است",
}

env = {k: v for k, v in os.environ.items() if k not in ("KB_TEST_DATABASE_URL", "DATABASE_URL", "CI")}
env["KB_TEST_DATABASE_URL"] = ""
env["DATABASE_URL"] = ""

def tests_pass() -> bool:
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", D, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=300)
    return r.returncode == 0

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    path = os.path.join(ROOT, D, f)
    src = open(path, encoding="utf8").read()
    if src.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {f}: {old[:60]}"); sys.exit(2)
    open(path, "w", encoding="utf8").write(src.replace(old, new, 1))
    try:
        ok = tests_pass()
    finally:
        open(path, "w", encoding="utf8").write(src)
    if ok and i not in EQUIVALENT:
        alive.append((i, f, why)); print(f"[{i:02d}] ✗ زنده: {f} — {why}")
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {f} — {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}")
print(f"\nجهش‌ها: {len(M)} | کشته: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
