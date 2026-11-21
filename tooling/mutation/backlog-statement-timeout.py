#!/usr/bin/env python3
"""
آزمون جهشی «سقفِ زمانِ سمتِ پایگاهِ خواندن‌های outbox و سیم‌کشیِ پایش» (م۳‑ه‑۴‑الف‑۲‑۴‑آ، ADR-0045) روی
`src/modules/settlement/pg/store.ts` و `src/modules/settlement-bootstrap/bootstrap.ts`: هر جهش یک تغییرِ کوچکِ معنادار است و باید دست‌کم یک آزمون را
قرمز کند؛ جهشِ زنده یعنی آزمونی کم است (یا جهش هم‌ارز است و باید دلیلش نوشته شود).
اجرا:  KB_TEST_DATABASE_URL=postgresql://… python3 tooling/mutation/backlog-statement-timeout.py          (همه)
       KB_TEST_DATABASE_URL=… python3 tooling/mutation/backlog-statement-timeout.py 3 9                    (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL؛ جزو CI نیست. پیش از هر اجرا وجودِ متنِ اصلیِ همهٔ جهش‌ها (دقیقاً یک بار) در فایل را می‌سنجد؛ فایل‌ها همیشه بازیابی می‌شوند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
STORE = "src/modules/settlement/pg/store.ts"
BOOT = "src/modules/settlement-bootstrap/bootstrap.ts"
TESTS = [
    "src/modules/settlement/pg/read-timeout.unit.test.ts",
    "src/modules/settlement/pg/read-timeout.pg.test.ts",
    "src/modules/settlement-bootstrap/backlog.statement-timeout.test.ts",
    "src/modules/settlement-bootstrap/backlog.statement-timeout.pg.test.ts",
]
M = []
# جهشِ هم‌ارز (مستند): `Number.isSafeInteger` روی غیرعدد (رشته…) بی‌تبدیل `false` می‌دهد، پس `typeof … !== "number"` فقط دفاعِ دوم است و اثرِ مشاهده‌پذیر ندارد.
EQUIVALENT = {4}


def m(src, old, new, why):
    M.append((src, old, new, why))


# ───── آداپتور: گزینه و اعتبارسنجی ─────
m(STORE, "  minMs: 1,\n", "  minMs: 0,\n", "حدِ پایین ۰ می‌شود (statement_timeout=0 یعنی بی‌سقف)")
m(STORE, "  maxMs: 7_200_000,\n", "  maxMs: 7_200_001,\n", "حدِ بالا یکی بالا می‌رود")
m(STORE, "if (value === undefined) return { ok: true, value: null };", "if (value === undefined || value === null) return { ok: true, value: null };", "null به‌جای رد شدن بی‌سقف می‌شود")
m(STORE, "!Number.isSafeInteger(value) || value < L.minMs", "value < L.minMs", "عددِ اعشاری/NaN پذیرفته می‌شود")
m(STORE, "typeof value !== \"number\" || !Number.isSafeInteger", "!Number.isSafeInteger", "رشتهٔ عددی پذیرفته می‌شود")
m(STORE, "|| value < L.minMs || value > L.maxMs)", "|| value > L.maxMs)", "حدِ پایین حذف می‌شود")
m(STORE, "|| value < L.minMs || value > L.maxMs)", "|| value < L.minMs)", "حدِ بالا حذف می‌شود")
m(STORE, "  if (!readTimeout.ok) return readTimeout;\n", "", "گزینهٔ نامعتبر بی‌صدا رد نمی‌شود")
m(STORE, "const readTimeout = parseReadStatementTimeout(options.readStatementTimeoutMs);", "const readTimeout = parseReadStatementTimeout(options.readStatementTimeoutMs ?? undefined);", "null در گزینه بی‌سقف شمرده می‌شود")
m(STORE, "buildPgOutbox(db, schema.value, readTimeout.value)", "buildPgOutbox(db, schema.value)", "گزینه به آداپتور نمی‌رسد")
# ───── آداپتور: اعمال ─────
m(STORE, "SELECT set_config('statement_timeout', ${String(ms)}, true)", "SELECT set_config('statement_timeout', ${String(ms)}, false)", "اثرِ سقف به اتصالِ استخر نشت می‌کند (is_local=false)")
m(STORE, "SELECT set_config('statement_timeout', ${String(ms)}, true)", "SELECT set_config('lock_timeout', ${String(ms)}, true)", "به‌جای statement_timeout، lock_timeout")
m(STORE, "SELECT set_config('statement_timeout', ${String(ms)}, true)", "SELECT set_config('statement_timeout', ${String(ms + 1)}, true)", "مقدار یکی بیشتر")
m(STORE, "if (readOnly && readStatementTimeoutMs !== null) await boundStatementTime(tx, readStatementTimeoutMs);", "if (readStatementTimeoutMs !== null) await boundStatementTime(tx, readStatementTimeoutMs);", "نوشتن‌ها هم سقف می‌گیرند")
m(STORE, "if (readOnly && readStatementTimeoutMs !== null) await boundStatementTime(tx, readStatementTimeoutMs);", "if (readOnly && readStatementTimeoutMs !== null) await boundStatementTime(tx, readStatementTimeoutMs).catch(() => undefined);", "شکستِ set_config بلعیده می‌شود (بی‌سقفِ بی‌صدا)")
m(STORE, "if (readOnly && readStatementTimeoutMs !== null) await boundStatementTime(tx, readStatementTimeoutMs);\n          await assertCurrent(tx, schema);", "await assertCurrent(tx, schema);\n          if (readOnly && readStatementTimeoutMs !== null) await boundStatementTime(tx, readStatementTimeoutMs);", "سقف پس از سپرِ مهاجرت (نخستین دستور نیست)")
m(STORE, "if (readOnly && readStatementTimeoutMs !== null) await boundStatementTime(tx, readStatementTimeoutMs);", "if (readOnly && readStatementTimeoutMs !== null && false) await boundStatementTime(tx, readStatementTimeoutMs);", "سقف هرگز اعمال نمی‌شود")
m(STORE, "if (readOnly && readStatementTimeoutMs !== null) await boundStatementTime", "if (readOnly && readStatementTimeoutMs !== null && schema !== \"settlement\") await boundStatementTime", "سقف روی شِمای پیش‌فرض اعمال نمی‌شود")
# ───── سیم‌کشی ─────
m(BOOT, "export const BACKLOG_STATEMENT_GRACE_MS = 1_000;", "export const BACKLOG_STATEMENT_GRACE_MS = 0;", "فرجه صفر: رقابتِ دو مهلت")
m(BOOT, "export const BACKLOG_STATEMENT_GRACE_MS = 1_000;", "export const BACKLOG_STATEMENT_GRACE_MS = 1_001;", "فرجه یکی بیشتر")
m(BOOT, "return timeoutMs + BACKLOG_STATEMENT_GRACE_MS;", "return timeoutMs;", "سقف بی‌فرجه")
m(BOOT, "return timeoutMs + BACKLOG_STATEMENT_GRACE_MS;", "return timeoutMs * 2;", "سقف دو برابر")
m(BOOT, "raw === undefined ? dflt : raw", "raw === undefined ? 1 : raw", "پیش‌فرضِ مهلت اشتباه")
m(BOOT, "|| timeoutMs < 1 ||", "|| timeoutMs < 0 ||", "مرزِ پایینِ مهلت")
m(BOOT, "timeoutMs > SETTLEMENT_BACKLOG_WATCH_LIMITS.maxTimeoutMs) return undefined;", "timeoutMs > SETTLEMENT_BACKLOG_WATCH_LIMITS.maxTimeoutMs + 1) return undefined;", "مرزِ بالای مهلت")
m(BOOT, "!Number.isSafeInteger(timeoutMs) ||", "", "اعشاری پذیرفته می‌شود")
m(BOOT, "      ...(readTimeoutMs === undefined ? {} : { readStatementTimeoutMs: readTimeoutMs }),\n", "", "سیم‌کشی: سقف به نمونهٔ پایش نمی‌رسد")
m(BOOT, "const readTimeoutMs = backlogReadStatementTimeoutMs(settings.backlog.overrides);", "const readTimeoutMs = backlogReadStatementTimeoutMs({});", "مهلتِ env نادیده گرفته می‌شود")
m(BOOT, "schema: settings.settlementSchema ?? SETTLEMENT_DEFAULT_SCHEMA,\n      ...(readTimeoutMs", "schema: SETTLEMENT_DEFAULT_SCHEMA,\n      ...(readTimeoutMs", "شِمای env نادیده گرفته می‌شود")


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
    orig = {p: read(p) for p in (STORE, BOOT)}
    survived = []
    try:
        for i in range(lo, hi + 1):
            src, old, new, why = M[i]
            write(src, orig[src].replace(old, new, 1))
            r = subprocess.run(["npx", "vitest", "run", *TESTS], cwd=ROOT, capture_output=True, text=True)
            out = r.stdout + r.stderr
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
