#!/usr/bin/env python3
"""
آزمون جهشی «آداپتور PostgreSQL نسخه‌های سیاستِ ابزار» (ماژول tool-policy-store-pg؛ برش CT-5c-2b-2، ADR-0070): هر جهش یک تغییر کوچکِ معنادار
در منبعِ ماژول است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است (یا کدِ زائد).
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/tool-policy-store-pg.py          (همه)
       … tool-policy-store-pg.py 3 9                                                          (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL (آزمون‌های اصلی پایگاه می‌خواهند)؛ جزو CI نیست. جهش‌های SQLِ migrations.ts فقط با آزمون‌های PostgreSQL سنجیده
می‌شوند (آزمونِ قفلِ checksum هر ویرایشِ آن فایل را بی‌ارزش می‌کشد). فایل‌ها پس از هر جهش همیشه برمی‌گردند؛ پیش‌بازرسی: متنِ اصلیِ هر جهش دقیقاً یک بار.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/tool-policy-store-pg/"
PG = [B + "store.pg.test.ts", "tooling/tool-policy-store-pg-contract.pg.test.ts", "tooling/tool-policy-store-pg-admin.pg.test.ts"]
ALL = [B] + PG[1:]
M = []


def m(f, old, new, why, tests=None):
    M.append((f, old, new, why, tests or ALL))


ST, ER, MG, RW, MS = "store.ts", "errors.ts", "migrate.ts", "rows.ts", "migrations.ts"
# ── store.ts
m(ST, 'if (!isSafeInt(version, 1)) return fail("INVALID");', "", "get بی‌اعتبارسنجیِ ورودی")
m(ST, 'if (rec === null) return fail("INVALID");', "", "append رکوردِ بدشکل را به پایگاه می‌دهد")
m(ST, 'return r.value ? ok(null) : fail("CONFLICT");', "return ok(null);", "بازندهٔ مسابقه موفق گزارش می‌شود")
m(ST, "return res.rows.length === 1;", "return true;", "نبودنِ ردیفِ RETURNING نادیده گرفته می‌شود")
m(ST, 'if (mode === "write") await assertWritable(tx, schema);', "", "نگهبانِ نوشتن برداشته می‌شود")
m(ST, "await assertCurrent(tx, schema);", "", "بررسیِ همخوانیِ مهاجرت برداشته می‌شود")
m(ST, "set_config('statement_timeout', ${String(timeout)}, true)", "set_config('statement_timeout', ${String(timeout)}, false)", "مهلت روی اتصالِ استخر می‌ماند (نه فقط تراکنش)")
m(ST, 'accessMode: mode === "read" ? "read only" : "read write"', 'accessMode: "read write"', "خواندن هم read write")
m(ST, "limit > STORE_LIMITS.maxListLimit ||", "", "limit بی‌سقف")
m(ST, 'if (res.rows.length > limit) throw corrupt("پرسشِ فهرست بیش از limit ردیف برگرداند.");', "", "بیش از limit ردیف پذیرفته می‌شود")
m(ST, "rec.version >= prev.version)", "rec.version > prev.version)", "نسخهٔ تکراریِ پشتِ‌سرهم در list")
m(ST, "rec.version >= beforeVersion))", "rec.version > beforeVersion))", "نسخهٔ برابر با beforeVersion در list")
m(ST, 'if (rec.version !== version) throw corrupt("ردیفِ برگشتی نسخهٔ خواسته‌شده نیست.");', "", "get نسخهٔ دیگری را می‌پذیرد")
m(ST, "ORDER BY version DESC LIMIT 1", "ORDER BY version ASC LIMIT 1", "latest قدیمی‌ترین را می‌دهد")
m(ST, "version < ${before}::bigint", "version <= ${before}::bigint", "beforeVersion انحصاری نیست")
m(ST, 'rec.source.kind === "rollback" ? String(rec.source.toVersion) : null', "null", "toVersionِ rollback ذخیره نمی‌شود")
m(ST, "if (res.rows.length !== 1) throw corrupt(", "if (false) throw corrupt(", "get چند ردیف را می‌پذیرد")
m(ST, "timeout > STORE_LIMITS.maxTimeoutMs", "false", "مهلتِ بی‌سقف")
# ── errors.ts
m(ER, 'if (pg.code === "23000" || pg.code === "23505") return "CONFLICT";', 'if (pg.code === "23505") return "CONFLICT";', "تریگرِ زنجیره (23000) CONFLICT نمی‌شود")
m(ER, 'return e.error.code === "CORRUPT_DATA" ? "INVALID" : "UNAVAILABLE";', 'return e.error.code === "CORRUPT_DATA" ? "UNAVAILABLE" : "INVALID";', "جابه‌جاییِ INVALID/UNAVAILABLE")
m(ER, 'if (pg.code.startsWith("23") || pg.code.startsWith("22")) return "INVALID";', 'if (pg.code.startsWith("23")) return "INVALID";', "دادهٔ نامعتبرِ کلاس ۲۲ UNAVAILABLE می‌شود")
m(ER, "depth < 6 &&", "depth < 0 &&", "خطای pgِ داخلِ cause پیدا نمی‌شود")
# ── migrate.ts
m(MG, 'row?.["role"] !== "origin" ||', "false ||", "جلسهٔ replica مجاز می‌شود")
m(MG, 'row["active"] !== String(EXPECTED_TRIGGERS.length)', "false", "نبودِ تریگر مجاز می‌شود")
m(MG, "t.tgisinternal AND t.tgenabled = 'O'\n         AND t.tgname IN", "t.tgisinternal\n         AND t.tgname IN", "تریگرِ خاموش فعال حساب می‌شود")
m(MG, "if (stored !== migrationChecksum(m)) {", "if (false) {", "checksumِ ناهمخوان پذیرفته می‌شود")
m(MG, "if (pending.length > 0) {\n      throw new PolicyPgError({ code: \"MIGRATION_TAMPERED\", message: `مهاجرت «${m.name}» اعمال شده", "if (false) {\n      throw new PolicyPgError({ code: \"MIGRATION_TAMPERED\", message: `مهاجرت «${m.name}» اعمال شده", "حفرهٔ دفتر پذیرفته می‌شود")
m(MG, "contiguous = latest === null ? rows === 0 : rows === latest;", "contiguous = true;", "شکافِ نسخه‌ها در status دیده نمی‌شود")
m(MG, "AND convalidated`", "`", "قیدِ NOT VALID سالم حساب می‌شود")
m(MG, "await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tool-policy-store:migrate:${schema}`}, 0))`);", "", "migrate بی‌قفل")
m(MG, "ready: rec.pending.length === 0 && problems.length === 0 && contiguous", "ready: true", "ready همیشه true")
m(MG, "if (!(await schemaExists(tx, schema))) {\n        throw", "if (false) {\n        throw", "migrate شِمای ناموجود را نمی‌شناسد")
m(MG, "if (led.rows[0]?.[\"present\"] !== true) return empty(true);", "", "جدولِ دفترِ ناموجود شناخته نمی‌شود")
# ── rows.ts
m(RW, 'if (kind === "set" && toVersion === null) source = { kind: "set" };', 'if (kind === "set") source = { kind: "set" };', "set با toVersion پذیرفته می‌شود")
m(RW, 'if (parsed === null) throw corrupt("ردیفِ نسخه با مرزِ رکورد نمی‌خواند.");', "", "ردیفِ خراب پذیرفته می‌شود")
# ── migrations.ts (SQL؛ فقط با آزمون‌های PostgreSQL)
mg = lambda old, new, why: m(MS, old, new, why, PG)
mg("IF NEW.version <> COALESCE((SELECT max(version) FROM ${T}), 0) + 1 THEN", "IF false THEN", "تریگرِ زنجیره بی‌اثر")
mg("BEFORE UPDATE OR DELETE ON", "BEFORE DELETE ON", "UPDATE مجاز")
mg("BEFORE INSERT ON ${T}", "BEFORE UPDATE ON ${T}", "تریگرِ زنجیره روی INSERT نیست")
mg("never truncated' USING ERRCODE = 'integrity_constraint_violation'", "never truncated' USING ERRCODE = 'raise_exception'", "کدِ TRUNCATE تغییر کرد")
mg("{0,127}$'", "{0,200}$'", "actor بلندتر از ۱۲۸")
mg("char_length(reason) BETWEEN 1 AND 500", "char_length(reason) BETWEEN 1 AND 600", "reason بلندتر از ۵۰۰")
mg("char_length(reason) BETWEEN 1 AND 500", "char_length(reason) BETWEEN 0 AND 500", "reason خالی")
mg("\\\\u2066-\\\\u2069", "\\\\u2067-\\\\u2069", "U+2066 مجاز")
mg("\\\\u202a-\\\\u202e", "\\\\u202a-\\\\u202d", "RLO مجاز")
mg("\\\\u2028\\\\u2029", "\\\\u2029", "جداکنندهٔ خط مجاز")
mg("\\\\u0001-\\\\u001f", "\\\\u0002-\\\\u001f", "U+0001 مجاز")
mg("source_to_version <= version", "source_to_version <= version + 1", "rollback به آینده")
mg("jsonb_array_length(changes) <= 64", "jsonb_array_length(changes) <= 65", "changes بیش از ۶۴")
mg("created_at_ms >= 0 AND", "created_at_ms >= -1 AND", "زمانِ منفی")
mg("(source_kind = 'set' AND source_to_version IS NULL)", "(source_kind = 'set')", "set با toVersion")
mg("jsonb_typeof(overrides) = 'object'", "true", "overrides غیرِ شیء")


def run_tests(tests):
    env = dict(os.environ)
    return subprocess.run(["npx", "vitest", "run", *tests], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode


def main():
    lo, hi = 1, len(M)
    if len(sys.argv) >= 3:
        lo, hi = int(sys.argv[1]), int(sys.argv[2])
    if "DATABASE_URL" not in os.environ and "KB_TEST_DATABASE_URL" not in os.environ:
        print("DATABASE_URL لازم است.")
        sys.exit(2)
    for i, (f, old, new, why, _t) in enumerate(M, 1):
        src = open(os.path.join(ROOT, B + f), encoding="utf-8").read()
        if src.count(old) < 1:
            print(f"پیش‌بازرسی: جهش {i} ({f}) متنِ اصلی را پیدا نکرد: {old[:60]!r}")
            sys.exit(2)
    if run_tests(ALL) != 0:
        print("آزمون‌ها بدونِ جهش قرمزند؛ ابتدا درست کنید.")
        sys.exit(2)
    live = []
    for i, (f, old, new, why, tests) in enumerate(M, 1):
        if not (lo <= i <= hi):
            continue
        path = os.path.join(ROOT, B + f)
        src = open(path, encoding="utf-8").read()
        try:
            open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
            killed = run_tests(tests) != 0
        finally:
            open(path, "w", encoding="utf-8").write(src)
        print(f"{'کشته  ' if killed else 'زنده! '} {i:3d}  {f:14s} {why}", flush=True)
        if not killed:
            live.append((i, f, why))
    print(f"\nجهش‌ها: {hi - lo + 1}  زنده: {len(live)}")
    for i, f, why in live:
        print(f"  زنده: {i} {f} — {why}")
    sys.exit(1 if live else 0)


if __name__ == "__main__":
    main()
