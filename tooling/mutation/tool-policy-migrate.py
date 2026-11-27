#!/usr/bin/env python3
"""
آزمون جهشیِ «مهاجرت‌دهندهٔ سیاست ابزار» (src/modules/tool-policy-migrate/*.ts؛ برش ۰۰۷۹، ADR-0080): هر جهش یک تغییر کوچکِ معنادار در منبع است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  python3 tooling/mutation/tool-policy-migrate.py            (همه)
       python3 tooling/mutation/tool-policy-migrate.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL (KB_TEST_DATABASE_URL/DATABASE_URL) برای آزمون‌های *.pg.test.ts؛ جزو CI نیست. فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = "src/modules/tool-policy-migrate/"
TESTS = [D + "args.test.ts", D + "cli.test.ts", D + "purity.test.ts", D + "cli.pg.test.ts", "tooling/tool-policy-migrate-parity.test.ts"]
M = []


def m(f, old, new, why):
    M.append((D + f, old, new, why))


# ── args.ts
m("args.ts", "export const DEFAULT_TIMEOUT_MS = 60_000;", "export const DEFAULT_TIMEOUT_MS = 59_000;", "پیش‌فرضِ مهلت عوض می‌شود")
m("args.ts", "export const MIN_TIMEOUT_MS = 1_000;", "export const MIN_TIMEOUT_MS = 1_001;", "کفِ مهلت یکی بیشتر")
m("args.ts", "export const MIN_TIMEOUT_MS = 1_000;", "export const MIN_TIMEOUT_MS = 999;", "کفِ مهلت یکی کمتر")
m("args.ts", "export const MAX_TIMEOUT_MS = 600_000;", "export const MAX_TIMEOUT_MS = 600_001;", "سقفِ مهلت یکی بیشتر")
m("args.ts", "export const MAX_TIMEOUT_MS = 600_000;", "export const MAX_TIMEOUT_MS = 599_999;", "سقفِ مهلت یکی کمتر")
m("args.ts", "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /^[0-9]{1,10}$/;", "صفرِ پیشرو پذیرفته می‌شود")
m("args.ts", "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /^[1-9][0-9]{0,9}/;", "پسوندِ غیررقم پذیرفته می‌شود")
m("args.ts", 'args.length === 1 && (args[0] === "--help"', 'args.length >= 1 && (args[0] === "--help"', "help با آرگومانِ دیگر پذیرفته می‌شود")
m("args.ts", 'if (createSchema && command === "status")', 'if (false && command === "status")', "--create-schema با status مجاز می‌شود")
m("args.ts", 'if (!seenCommand) issues.push("دستور لازم است (status یا up).");', "", "نبودنِ دستور خطا نیست")
m("args.ts", "!KNOWN_TOOL_POLICY_ENV.includes(k))", "false)", "غلط‌یابِ TOOL_POLICY_* خاموش")
m("args.ts", ': "?");\n\nexport function', ": name);\n\nexport function", "آرگومانِ غیرفلگ پژواک می‌شود")
m("args.ts", 'if (schemaRaw !== undefined && schemaRaw !== "")', 'if (schemaRaw !== undefined)', "شِمای خالی خطا می‌شود")
m("args.ts", 'if (typeof url !== "string" || url === "")', 'if (typeof url !== "string")', "DATABASE_URL خالی پذیرفته می‌شود")
m("args.ts", '} else if (a.startsWith("-")) {', '} else if (false) {', "فلگِ کوتاه تشخیص داده نمی‌شود")
m("args.ts", '  "TOOL_POLICY_BOOT_ATTEMPTS",\n', "", "یک نامِ bootstrap از فهرست افتاده")
m("args.ts", "if (seenTimeout) {", "if (false) {", "--timeout-ms تکراری مجاز می‌شود")
m("args.ts", "else if (seenCreate) issues.push", "else if (false) issues.push", "--create-schema تکراری مجاز می‌شود")
m("args.ts", "slice(0, 48)", "slice(0, 4800)", "نامِ بلندِ متغیر کوتاه نمی‌شود")
# ── exit-codes.ts
m("exit-codes.ts", '    case "CORRUPT_DATA":\n    case "UNSAFE_SESSION":\n      return withPg("SCHEMA_MISMATCH", error);\n    case "NOT_MIGRATED":', '    case "CORRUPT_DATA":\n      return withPg("SCHEMA_MISMATCH", error);\n    case "NOT_MIGRATED":', "UNSAFE_SESSION در خواندن ناهمخوانی نیست")
m("exit-codes.ts", 'case "NOT_MIGRATED":\n      return withPg("PENDING", error);', 'case "NOT_MIGRATED":\n      return withPg("UNAVAILABLE", error);', "NOT_MIGRATED معلق نیست")
m("exit-codes.ts", "const SQLSTATE = /^[0-9A-Z]{5}$/;", "const SQLSTATE = /^[0-9A-Z]{5}/;", "SQLSTATE با پسوند پذیرفته می‌شود")
m("exit-codes.ts", '    case "DB_ERROR":\n    case "NOT_MIGRATED":\n    case "UNSAFE_SESSION":\n      return withPg("MIGRATION_FAILED", error);', '    case "DB_ERROR":\n    case "UNSAFE_SESSION":\n      return withPg("MIGRATION_FAILED", error);', "NOT_MIGRATED در اعمال ناموفق نیست")
m("exit-codes.ts", '    case "UNSAFE_SESSION":\n      return withPg("MIGRATION_FAILED", error);', "", "UNSAFE_SESSION در اعمال ناموفق نیست")
m("exit-codes.ts", '    case "MIGRATION_UNKNOWN":\n    case "CORRUPT_DATA":\n      return withPg("SCHEMA_MISMATCH", error);\n    case "DB_ERROR":\n    case "NOT_MIGRATED"', '    case "MIGRATION_UNKNOWN":\n      return withPg("SCHEMA_MISMATCH", error);\n    case "DB_ERROR":\n    case "CORRUPT_DATA":\n    case "NOT_MIGRATED"', "CORRUPT_DATA در اعمال ناهمخوانی نیست")
# ── execute.ts
m("execute.ts", 'new Set(["23505", "40001", "40P01"])', 'new Set(["40001", "40P01"])', "23505 قابل‌تکرار نیست")
m("execute.ts", 'new Set(["23505", "40001", "40P01"])', 'new Set(["23505", "40P01"])', "40001 قابل‌تکرار نیست")
m("execute.ts", 'new Set(["23505", "40001", "40P01"])', 'new Set(["23505", "40001"])', "40P01 قابل‌تکرار نیست")
m("execute.ts", 'new Set(["23505", "40001", "40P01"])', 'new Set(["23505", "40001", "40P01", "42501"])', "42501 قابل‌تکرار می‌شود")
m("execute.ts", "export const APPLY_ATTEMPTS = 3;", "export const APPLY_ATTEMPTS = 2;", "تعدادِ تلاش دو")
m("execute.ts", "export const APPLY_ATTEMPTS = 3;", "export const APPLY_ATTEMPTS = 4;", "تعدادِ تلاش چهار")
m("execute.ts", 'rec.code === "DB_ERROR";\n}\n\nconst verdict', 'true;\n}\n\nconst verdict', "هر خطایی با SQLSTATEِ هم‌زمانی تکرار می‌شود")
m("execute.ts", 'if (s0.ready) return verdict(progress, { code: "OK" });', "", "آماده بودن بی‌نوشتن نیست")
m("execute.ts", 'if (!needsApply) return verdict(progress, { code: "SCHEMA_MISMATCH" });', 'if (!needsApply) return verdict(progress, { code: "PENDING" });', "ناهمخوانی معلق حساب می‌شود")
m("execute.ts", 'if (command === "status") return verdict(progress, { code: "PENDING" });', "", "status هم می‌نویسد")
m("execute.ts", 'if (!createSchema) return verdict(progress, { code: "SCHEMA_MISSING" });', "", "بی‌فلگ هم شِما ساخته می‌شود")
m("execute.ts", "progress.schemaCreated = true;", "progress.schemaCreated = false;", "schemaCreated ثبت نمی‌شود")
m("execute.ts", 'return verdict(progress, { code: again.state.ready ? "OK" : "MIGRATION_FAILED" });', 'return verdict(progress, { code: "OK" });', "راستی‌آزمایی بی‌اثر")
m("execute.ts", 'c.code === "PENDING" ? { ...c, code: "MIGRATION_FAILED" } : c', "c", "NOT_MIGRATED در verify معلق می‌ماند")
m("execute.ts", 'progress.phase = "verify";\n  if (progress.cancelled) return verdict(progress, { code: "TIMEOUT" });', 'progress.phase = "verify";', "مهلت پیش از verify سنجیده نمی‌شود")
m("execute.ts", 'progress.phase = "check";\n  if (progress.cancelled) return verdict(progress, { code: "TIMEOUT" });', 'progress.phase = "check";', "مهلت پیش از check سنجیده نمی‌شود")
m("execute.ts", "if (typeof rows !== \"number\" || !Number.isSafeInteger(rows) || rows < 0) return null;", "if (typeof rows !== \"number\" || rows < 0) return null;", "rows اعشاری پذیرفته می‌شود")
m("execute.ts", "if (typeof rows !== \"number\" || !Number.isSafeInteger(rows) || rows < 0) return null;", "if (typeof rows !== \"number\" || !Number.isSafeInteger(rows)) return null;", "rows منفی پذیرفته می‌شود")
m("execute.ts", "if (n < APPLY_ATTEMPTS && retryable", "if (n <= APPLY_ATTEMPTS && retryable", "تلاشِ اضافه")
m("execute.ts", "      progress.retries++;\n", "", "retries شمرده نمی‌شود")
m("execute.ts", 'isNames(v["alreadyApplied"]) ? ', "true ? ", "شکلِ alreadyApplied سنجیده نمی‌شود")
m("execute.ts", "const appliedNow = applied.value;", "const appliedNow: string[] = [];", "appliedNow همیشه خالی")
m("execute.ts", "problemCount: problems.length,", "problemCount: 0,", "problemCount همیشه صفر")
m("execute.ts", "if (r[\"ok\"] !== true) return \"malformed\";", "", "ok نامعتبر پذیرفته می‌شود")
# ── cli.ts
m("cli.ts", 'code: lazy.invalid() ? "INTERNAL" : v.code,', "code: v.code,", "پایگاهِ نامعتبر INTERNAL نیست")
m("cli.ts", 'if (run.kind !== "done") progress.cancelled = true;', "", "پس از مهلت لغو نمی‌شود")
m("cli.ts", 'run.kind === "timeout" ? "TIMEOUT" : "INTERNAL"', '"TIMEOUT"', "خطای زمان‌سنج TIMEOUT می‌شود")
m("cli.ts", "(lazy.db, settings.schema)", "(lazy.db, null)", "شِمای محیط به فروشگاه نمی‌رسد")
m("cli.ts", "execute(settings.command, settings.createSchema, made.store, progress)", "execute(settings.command, true, made.store, progress)", "فلگ همیشه روشن")
m("cli.ts", "    const closed = await lazy.close(p.timer);\n", "    const closed = true;\n", "بستنِ اتصال انجام نمی‌شود")
# ── lazy-database.ts / deadline.ts
m("lazy-database.ts", "export const CLOSE_TIMEOUT_MS = 5_000;", "export const CLOSE_TIMEOUT_MS = 6_000;", "مهلتِ بستن عوض می‌شود")
m("lazy-database.ts", 'if (state === "opening" || opened === null) return false;', 'if (state === "opening" || opened === null) return true;', "بازشدنِ در جریان بسته حساب می‌شود")
m("lazy-database.ts", "        if (abandoned) {\n          await closeQuietly(o);\n          throw new Error(\"abandoned\");\n        }\n", "", "اتصالِ دیرهنگام بسته نمی‌شود")
m("lazy-database.ts", '!hasFn(o.db, "transaction")', "false", "transaction سنجیده نمی‌شود")
m("lazy-database.ts", '!hasFn(o.db, "execute") || ', "", "execute سنجیده نمی‌شود")
m("deadline.ts", "      done = true;\n      if (armed) {", "      done = true;\n      if (false) {", "زمان‌سنج لغو نمی‌شود")
# ── store.ts (ماژول SQL ندارد؛ DDL پورتِ گلو است)
m("store.ts", "createSchemaPort(db, store.schema)", 'createSchemaPort(db, "public")', "پورت با شِمای اشتباه صدا زده می‌شود")
m("store.ts", 'createSchemaPort === undefined ? Promise.reject(new Error("no port")) : ', "", "بی‌پورت هم خطا نیست (TypeError به‌جای خطای صریح)")
m("store.ts", 'createSchemaPort === undefined ? Promise.reject(new Error("no port"))', "false ? Promise.reject(new Error(\"no port\"))", "بی‌پورت پذیرفته می‌شود")
m("store.ts", "typeof rec.code === \"string\" && /^[0-9A-Z]{5}$/.test(rec.code)", "typeof rec.code === \"string\" && /^[0-9A-Z]{5}/.test(rec.code)", "SQLSTATE با پسوند")
m("store.ts", "depth < 6", "depth < 1", "cause دنبال نمی‌شود")
m("store.ts", "depth < 6", "depth < 7", "عمقِ cause یکی بیشتر")
m("store.ts", '(code === null ? {} : { pgCode: code })', "{}", "pgCode ساخت‌شِما گم می‌شود")
m("store.ts", 'code: "DB_ERROR", message: "ساختنِ شِما ناموفق بود."', 'code: "INVALID_INPUT", message: "ساختنِ شِما ناموفق بود."', "کدِ خطای ساخت‌شِما")
m("cli.ts", "settings.schema, p.createSchema)", "settings.schema, undefined)", "پورتِ گلو به فروشگاه نمی‌رسد")
m("cli.ts", 'ports["createStore"] === undefined && !isFn(ports["createSchema"])', "false", "نبودنِ پورتِ createSchema بی‌خطا")
# ── report.ts / types.ts
m("report.ts", "p.retries === undefined || p.retries === 0 ? {}", "p.retries === undefined ? {}", "retries=0 هم گزارش می‌شود")
m("report.ts", "p.schemaCreated === true ? { schemaCreated: true } : {}", "p.schemaCreated !== undefined ? { schemaCreated: p.schemaCreated } : {}", "schemaCreated=false هم گزارش می‌شود")
m("report.ts", 'ok: p.code === "OK",', "ok: true,", "ok همیشه درست")
m("types.ts", "SCHEMA_MISSING: 8,", "SCHEMA_MISSING: 9,", "کدِ خروجِ SCHEMA_MISSING")
m("types.ts", "PENDING: 3,", "PENDING: 4,", "کدِ خروجِ PENDING")

EQUIVALENT = {
    62: "بی‌پورت: فراخوانیِ undefined یک TypeError می‌دهد که همان زنجیرهٔ .then(…، رد) می‌گیرد و به همان DB_ERRORِ بی‌pgCode می‌رسد؛ نگهبانِ صریح فقط خوانایی است",
    63: "همان هم‌ارزیِ ۶۲ با شکلِ دیگرِ جهش (شرطِ ثابتاً نادرست)",
}
env = dict(os.environ)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
origs = {}
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
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
