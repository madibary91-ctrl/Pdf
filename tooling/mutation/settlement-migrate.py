#!/usr/bin/env python3
"""
آزمون جهشی «مهاجرت‌دهندهٔ تسویه» (ماژول settlement-migrate؛ برش م۳‑ه‑۳‑ج، ADR-0034): هر جهش یک تغییر کوچکِ معنادار در منبعِ ماژول است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/settlement-migrate.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/settlement-migrate.py 3 9                    (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL (cli.pg.test.ts و آزمونِ runtime بخشی از کشتنِ جهش‌ها هستند)؛ جزو CI نیست.
آزمونِ فرایندِ واقعی (process.pg.test.ts، کُند) عمداً در این مجموعه نیست؛ جهشی روی گلو (tooling/cli) نمی‌زنیم.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-migrate/"
TESTS = [
    B + "args.test.ts", B + "cli.test.ts", B + "cli.pg.test.ts", B + "purity.test.ts",
    "tooling/settlement-migrate-parity.test.ts", "tooling/settlement-migrate-runtime.pg.test.ts",
]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


A, X, C, L, CL, D, R, S, T = "args.ts", "execute.ts", "exit-codes.ts", "lazy-database.ts", "cli.ts", "deadline.ts", "report.ts", "stores.ts", "types.ts"
# ── args.ts
m(A, "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /^[0-9]{1,10}$/;", "صفرِ آغازین پذیرفته می‌شود")
m(A, "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /[1-9][0-9]{0,9}/;", "الگوی عدد بی‌لنگر است")
m(A, "export const MIN_TIMEOUT_MS = 1_000;", "export const MIN_TIMEOUT_MS = 1;", "مهلتِ ۱ms مجاز می‌شود")
m(A, "export const MAX_TIMEOUT_MS = 600_000;", "export const MAX_TIMEOUT_MS = 6_000_000;", "سقفِ مهلت بالا می‌رود (قفلِ سمتِ سرور کوتاه‌تر می‌شود)")
m(A, "export const DEFAULT_TIMEOUT_MS = 60_000;", "export const DEFAULT_TIMEOUT_MS = 30_000;", "مهلتِ پیش‌فرض عوض می‌شود")
m(A, "n >= MIN_TIMEOUT_MS && n <= MAX_TIMEOUT_MS", "n >= MIN_TIMEOUT_MS", "سقفِ مهلت سنجیده نمی‌شود")
m(A, "} else if (seenTimeout) {", "} else if (false) {", "فلگِ مهلتِ تکراری پذیرفته می‌شود")
m(A, "issues.push(`فلگِ ناشناختهٔ ${safeFlag(name)}.`);", "void 0;", "فلگِ ناشناخته بی‌صدا پذیرفته می‌شود")
m(A, 'else issues.push("دستورِ ناشناخته (status یا up).");', 'else command = a as "status" | "up";', "دستورِ ناشناخته پذیرفته می‌شود")
m(A, 'if (a === "status" || a === "up") command = a;', 'if (a.toLowerCase() === "status" || a.toLowerCase() === "up") command = a as "status" | "up";', "«UP» بی‌صدا پذیرفته می‌شود")
m(A, "} else if (seenCommand) {", "} else if (false) {", "آرگومانِ موضعیِ اضافه پذیرفته می‌شود")
m(A, 'if (!seenCommand) issues.push("دستور لازم است (status یا up).");', "", "بی‌دستور پذیرفته می‌شود")
m(A, 'if (typeof url !== "string" || url === "") issues.push', 'if (typeof url !== "string") issues.push', "DATABASE_URLِ خالی پذیرفته می‌شود")
m(A, 'if (typeof url !== "string" || url === "") issues.push', "if (false) issues.push", "DATABASE_URL الزامی نیست")
m(A, "k.startsWith(ENV_PREFIX) && !KNOWN_SETTLEMENT_ENV.includes(k)", "false", "غلطِ تایپیِ نامِ SETTLEMENT_* دیده نمی‌شود")
m(A, "k.startsWith(ENV_PREFIX) && !KNOWN_SETTLEMENT_ENV.includes(k)", "!KNOWN_SETTLEMENT_ENV.includes(k)", "هر کلیدِ ناشناخته (حتی PATH) خطاست")
m(A, 'if (v === undefined || v === "") return null;', "if (v === undefined) return null;", "شِمای خالی رشتهٔ خالی می‌شود نه پیش‌فرض (ناهمارز با bootstrap)")
m(A, 'if (typeof v !== "string") {\n        issues.push(`${name} باید رشته باشد.`);', 'if (false) {\n        issues.push(`${name} باید رشته باشد.`);', "شِمای غیررشته‌ای پذیرفته می‌شود")
m(A, '(/^--[a-z][a-z0-9-]{0,31}$/.test(name) ? JSON.stringify(name) : "?")', "JSON.stringify(name)", "هر «نامِ فلگ» (حتی رشتهٔ اتصال) پژواک می‌شود")
m(A, 'if (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))', 'if (args.includes("--help") || args.includes("-h"))', "--help کنارِ دستور پذیرفته می‌شود")
m(A, 'issues.push("--help باید تنها بیاید.");', "void 0;", "--help کنارِ آرگومانِ دیگر خطا نیست")
m(A, " || argv.some((a) => typeof a !== \"string\")", "", "argvِ با عنصرِ غیررشته‌ای پذیرفته می‌شود")
m(A, "if (typeof env !== \"object\" || env === null || Array.isArray(env)) {", "if (typeof env !== \"object\" || env === null) {", "envِ آرایه پذیرفته می‌شود")
m(A, "return { ok: true, value: Object.freeze({ command, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, ledgerSchema, settlementSchema }) };", "return { ok: true, value: { command, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, ledgerSchema, settlementSchema } };", "نتیجهٔ موفق فریز نیست")
m(A, "if (issues.length > 0 || command === null) return { ok: false, command, issues: Object.freeze(issues) };", "if (issues.length > 0 || command === null) return { ok: false, command, issues };", "issuesِ شکست فریز نیست")
m(A, "const ledgerSchema = schemaVar(ENV_LEDGER_SCHEMA);", "const ledgerSchema = schemaVar(ENV_OUTBOX_SCHEMA);", "شِمای دفتر از متغیرِ outbox خوانده می‌شود")
m(A, '  "SETTLEMENT_HOST",\n', "", "نامِ SETTLEMENT_HOST از فهرستِ شناخته‌شده‌ها می‌افتد")
# ── execute.ts
m(X, "for (const stage of STAGES) {\n    if (progress.cancelled) return fail(progress, { code: \"TIMEOUT\" });\n    progress.stage = stage;\n    const r = await readStatus", "for (const stage of STAGES) {\n    progress.stage = stage;\n    const r = await readStatus", "پس از مهلت، check فروشگاهِ بعدی را می‌خواند")
m(X, "if (before.pending.length === 0) continue;\n    if (progress.cancelled) return fail(progress, { code: \"TIMEOUT\" });", "if (before.pending.length === 0) continue;", "پس از مهلت، مهاجرتِ تازه‌ای شروع می‌شود")
m(X, "for (const stage of touched) {\n    if (progress.cancelled) return fail(progress, { code: \"TIMEOUT\" });", "for (const stage of touched) {", "پس از مهلت، verifyِ بعدی شروع می‌شود")
m(X, "const anyPending = STAGES.some(", "const anyPending = STAGES.every(", "فقط وقتی هر دو معلق باشند PENDING است")
m(X, 'code: anyPending ? ("PENDING" as const) : ("OK" as const)', 'code: anyPending ? ("OK" as const) : ("PENDING" as const)', "status معلق را ۰ و اعمال‌شده را ۳ می‌دهد")
m(X, 'if (!anyPending) return Object.freeze({ code: "OK" as const, phase: "check" as const });', "", "up بی‌کار وارد apply/verify می‌شود")
m(X, "if (before.pending.length === 0) continue;\n    if (progress.cancelled)", "if (progress.cancelled)", "فروشگاهِ بی‌معلق هم migrate می‌شود")
m(X, "if (rec.ok === false) return fail(progress, classifyError(rec.error, classifyApply));", "if (rec.ok === false) return fail(progress, classifyError(rec.error, classifyRead));", "خطای apply با نگاشتِ خواندن طبقه‌بندی می‌شود")
m(X, "for (const stage of touched) {\n    if", "for (const stage of STAGES) {\n    if", "verify برای فروشگاهِ دست‌نخورده هم اجرا می‌شود")
m(X, 'if (r.pending.length > 0) return fail(progress, { code: "MIGRATION_FAILED" });', "", "معلقِ باقی‌مانده پس از migrate «ok» حساب می‌شود")
m(X, "progress[stage] = state([...before.applied, ...applied], before.pending.filter((n) => !applied.includes(n)), applied);", "progress[stage] = state(before.applied, before.pending, []);", "appliedNow پس از migrate ثبت نمی‌شود")
m(X, "progress[stage] = state(r.applied, r.pending, now);", "progress[stage] = state(r.applied, r.pending, []);", "appliedNow در verify گم می‌شود")
m(X, "SCHEMA_MISMATCH: 2,", "SCHEMA_MISMATCH: 9,", "ناهمخوانی بر در دسترس‌نبودن می‌چربد")
m(X, "SEVERITY[c.code] > SEVERITY[worst.c.code]", "SEVERITY[c.code] >= SEVERITY[worst.c.code]", "در شدتِ برابر stageِ آخرین فروشگاه گزارش می‌شود")
m(X, "export const APPLY_ATTEMPTS = 3;", "export const APPLY_ATTEMPTS = 4;", "سقفِ تلاش عوض می‌شود")
m(X, 'new Set(["23505", "40001", "40P01"])', 'new Set(["23505"])', "40001 و 40P01 بازتلاش نمی‌شوند")
m(X, 'new Set(["23505", "40001", "40P01"])', 'new Set(["23505", "40001", "40P01", "42501"])', "نبودِ دسترسی (42501) هم بازتلاش می‌شود")
m(X, '(rec.code === "COMMIT_REJECTED" || rec.code === "DB_ERROR")', "true", "ناهمخوانیِ دفتر با SQLSTATE بازتلاش می‌شود")
m(X, "attempt < APPLY_ATTEMPTS && retryable(rec.error)", "attempt <= APPLY_ATTEMPTS && retryable(rec.error)", "یک تلاشِ اضافه")
m(X, "        progress.retries++;\n", "", "شمارِ بازتلاش گزارش نمی‌شود")
m(X, "        progress.retries++;\n        if (progress.cancelled) return fail(progress, { code: \"TIMEOUT\" });", "        progress.retries++;", "پس از مهلت بازتلاش می‌شود")
m(X, "if (!isNames(v.applied) || !isNames(v.pending)) return \"malformed\";", "", "شکلِ نامعتبرِ status پذیرفته می‌شود")
m(X, "if (rec.ok !== true || !isNames(applied)) return fail(progress, INTERNAL);", "", "شکلِ نامعتبرِ migrate پذیرفته می‌شود")
# ── exit-codes.ts
m(C, 'case "DB_ERROR":\n      return withPg("UNAVAILABLE", error);', 'case "DB_ERROR":\n      return withPg("MIGRATION_FAILED", error);', "خطای اتصالِ خواندن «مهاجرت ناموفق» می‌شود")
m(C, 'case "NOT_MIGRATED":\n      return withPg("PENDING", error);', 'case "NOT_MIGRATED":\n      return withPg("UNAVAILABLE", error);', "NOT_MIGRATEDِ خواندن «در دسترس نیست» می‌شود")
m(C, "const SQLSTATE = /^[0-9A-Z]{5}$/;", "const SQLSTATE = /^.*$/;", "هر pgCodeی (حتی قناری) در گزارش می‌آید")
m(C, 'case "DB_ERROR":\n    case "COMMIT_REJECTED":\n    case "NOT_MIGRATED":\n      return withPg("MIGRATION_FAILED", error);', 'case "DB_ERROR":\n    case "COMMIT_REJECTED":\n    case "NOT_MIGRATED":\n      return withPg("UNAVAILABLE", error);', "شکستِ apply «در دسترس نیست» می‌شود")
m(C, "    default:\n      return { code: \"INTERNAL\" };\n  }\n}\n\n/** مرحلهٔ `apply`", "    default:\n      return { code: \"UNAVAILABLE\" };\n  }\n}\n\n/** مرحلهٔ `apply`", "کدِ ناشناختهٔ فروشگاه بی‌صدا «در دسترس نیست» می‌شود")
# ── lazy-database.ts
m(L, 'if (state === "idle" || state === "failed") return true;', 'if (state === "idle" || state === "failed") return false;', "نبودنِ اتصال «بسته‌نشده» گزارش می‌شود")
m(L, "        if (abandoned) {\n          await closeQuietly(o);\n          throw new Error(\"abandoned\");\n        }\n", "", "اتصالِ دیرِ باز‌شده پس از مهلت نشت می‌کند")
m(L, "  async function close(timer: LoopTimer): Promise<boolean> {\n    abandoned = true;\n", "  async function close(timer: LoopTimer): Promise<boolean> {\n", "رهاکردنِ اجرا ثبت نمی‌شود")
m(L, "if (opening === null) {", "if (true) {", "هر فراخوانی اتصالِ تازه باز می‌کند")
m(L, "export const CLOSE_TIMEOUT_MS = 5_000;", "export const CLOSE_TIMEOUT_MS = 50_000;", "مهلتِ بستن عوض می‌شود")
m(L, "          invalidDb = true;\n", "", "پایگاهِ نامعتبر «در دسترس نیست» حساب می‌شود")
m(L, "          if (hasFn(o, \"close\")) await closeQuietly(o);\n", "", "پایگاهِ نامعتبرِ دارای close بسته نمی‌شود")
m(L, "return r.kind === \"done\";", "return true;", "بستنِ آویزان «بسته شد» گزارش می‌شود")
# ── cli.ts
m(CL, 'if (run.kind !== "done") progress.cancelled = true;', "", "اجرای رهاشده پس از مهلت ادامه می‌دهد")
m(CL, 'code: lazy.invalid() ? "INTERNAL" : v.code,', "code: v.code,", "پایگاهِ نامعتبر کدِ فروشگاه را می‌گیرد")
m(CL, 'code: run.kind === "timeout" ? "TIMEOUT" : "INTERNAL",', 'code: "TIMEOUT",', "خطای داخلی «مهلت» گزارش می‌شود")
m(CL, "code: \"USAGE\", issues: parsed.issues, usage: USAGE });", "code: \"USAGE\", issues: parsed.issues });", "راهنما در خطای آرگومان نیست")
m(CL, "(p.createStores ?? createRealStores)", "createRealStores", "createStoresِ تزریقی نادیده گرفته می‌شود")
m(CL, "bounded(p.timer, settings.timeoutMs,", "bounded(p.timer, 60_000,", "مهلتِ کاربر نادیده گرفته می‌شود")
m(CL, "        retries: progress.retries,\n        closed,\n      });\n    } else {", "        closed,\n      });\n    } else {", "شمارِ بازتلاش در گزارش نمی‌آید")
m(CL, "        pgCode: lazy.invalid() ? undefined : v.pgCode,\n        ledger", "        pgCode: v.pgCode,\n        ledger", "SQLSTATEِ نامعتبر می‌آید (هم‌ارزِ نزدیک: پایگاهِ نامعتبر pgCode ندارد)")
m(CL, "    const closed = await lazy.close(p.timer);", "    const closed = true;", "وضعیتِ بستنِ اتصال گزارش نمی‌شود")
# ── report.ts
m(R, "ok: p.code === \"OK\",", "ok: true,", "ok همیشه true")
m(R, "p.retries === undefined || p.retries === 0 ? {}", "p.retries === undefined ? {}", "retries=۰ در گزارش می‌آید")
# ── deadline.ts
m(D, "      if (armed) {\n        try {\n          timer.cancel(handle);", "      if (false) {\n        try {\n          timer.cancel(handle);", "زمان‌سنجِ مهلت پس از پایان لغو نمی‌شود")
m(D, "      armed = false;\n      finish({ kind: \"error\" });", "      armed = false;\n      finish({ kind: \"timeout\" });", "زمان‌سنجِ خراب «مهلت» گزارش می‌شود")
m(D, "    if (done) return;\n    try {\n      Promise.resolve(work())", "    try {\n      Promise.resolve(work())", "با زمان‌سنجِ خراب کار بی‌مهلت اجرا می‌شود")
# ── stores.ts
m(S, "schemas.ledger === null ? {} : { schema: schemas.ledger }", "{}", "شِمای دفتر نادیده گرفته می‌شود")
m(S, "if (!ledger.ok) issues.push(`${ENV_LEDGER_SCHEMA} نامعتبر است.`);", "if (!ledger.ok) issues.push(`${ENV_OUTBOX_SCHEMA} نامعتبر است.`);", "نامِ متغیرِ شِمای نامعتبر جابه‌جا می‌شود")
m(S, "schemas.settlement === null ? {} : { schema: schemas.settlement }", "{}", "شِمای outbox نادیده گرفته می‌شود")
# ── types.ts
m(T, "  UNAVAILABLE: 4,", "  UNAVAILABLE: 9,", "کدِ خروجِ در دسترس‌نبودن عوض می‌شود")

# جهش‌های هم‌ارزِ توضیح‌داده‌شده (متنِ why ← دلیل). هر ورودی باید دلیلِ رفتاریِ روشن داشته باشد.
EQUIVALENT_BY_WHY: dict = {
    "SQLSTATEِ نامعتبر می‌آید (هم‌ارزِ نزدیک: پایگاهِ نامعتبر pgCode ندارد)": "پایگاهِ نامعتبر (بی‌execute/transaction) هیچ SQL‌ای اجرا نمی‌کند؛ خطا TypeErrorِ بی‌SQLSTATE است ⇒ v.pgCode همیشه undefined؛ سنجه فقط دفاعی است",
}
EQUIVALENT: dict = {}
for _i, (_f, _o, _n, _why) in enumerate(M):
    if _why in EQUIVALENT_BY_WHY:
        EQUIVALENT[_i] = EQUIVALENT_BY_WHY[_why]

env = dict(os.environ)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
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
if not tests_pass():
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, B, f)
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
