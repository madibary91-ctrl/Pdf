#!/usr/bin/env python3
"""
آزمون جهشیِ «حقوق نقش زمان اجرای سیاست ابزار» (src/modules/tool-policy-grants/*.ts؛ برش ۰۰۸۰، ADR-0081): هر جهش یک تغییر کوچکِ معنادار
در منبع است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  python3 tooling/mutation/tool-policy-grants.py            (همه)
       python3 tooling/mutation/tool-policy-grants.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL (KB_TEST_DATABASE_URL/DATABASE_URL) برای آزمون‌های *.pg.test.ts؛ جزو CI نیست. فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = "src/modules/tool-policy-grants/"
TESTS = [D + "args.test.ts", D + "cli.test.ts", D + "plan.test.ts", D + "lifecycle.test.ts", D + "purity.test.ts", "tooling/tool-policy-grants-parity.test.ts", "tooling/tool-policy-grants-runtime.pg.test.ts"]
M = []


def m(f, old, new, why):
    M.append((D + f, old, new, why))


# ── contract.ts
m("contract.ts", 'Object.freeze<readonly TablePrivilege[]>(["SELECT", "INSERT"])', 'Object.freeze<readonly TablePrivilege[]>(["SELECT", "INSERT", "UPDATE"])', "نسخه‌ها UPDATE هم می‌گیرد")
m("contract.ts", 'Object.freeze<readonly TablePrivilege[]>(["SELECT", "INSERT"])', 'Object.freeze<readonly TablePrivilege[]>(["SELECT"])', "نسخه‌ها INSERT نمی‌گیرد")
m("contract.ts", '[LEDGER_TABLE]: Object.freeze<readonly TablePrivilege[]>(["SELECT"])', '[LEDGER_TABLE]: Object.freeze<readonly TablePrivilege[]>(["SELECT", "INSERT"])', "دفتر INSERT می‌گیرد")
m("contract.ts", '[LEDGER_TABLE]: Object.freeze<readonly TablePrivilege[]>(["SELECT"])', '[LEDGER_TABLE]: Object.freeze<readonly TablePrivilege[]>([])', "دفتر SELECT نمی‌گیرد")
m("contract.ts", 'schema: Object.freeze<readonly SchemaPrivilege[]>(["USAGE"])', 'schema: Object.freeze<readonly SchemaPrivilege[]>(["USAGE", "CREATE"])', "شِما CREATE می‌گیرد")
m("contract.ts", 'const ROLE_RE = /^[a-z][a-z0-9_]{0,62}$/;', 'const ROLE_RE = /^[a-z][a-z0-9_]{0,63}$/;', "نقشِ ۶۴نویسه‌ای مجاز")
m("contract.ts", 'const ROLE_RE = /^[a-z][a-z0-9_]{0,62}$/;', 'const ROLE_RE = /^[a-zA-Z][a-z0-9_]{0,62}$/;', "نقشِ با حرفِ بزرگ مجاز")
m("contract.ts", '"public", "postgres", "none"', '"public", "none"', "postgres نقشِ مجاز")
m("contract.ts", 'ROLE_RESERVED.has(value) || value.startsWith("pg_")', 'ROLE_RESERVED.has(value)', "نقش‌های pg_* مجاز")
m("contract.ts", 'const SCHEMA_RE = /^[a-z][a-z0-9_]{0,39}$/;', 'const SCHEMA_RE = /^[a-z][a-z0-9_]{0,40}$/;', "شِمای ۴۱نویسه‌ای مجاز")
m("contract.ts", 'new Set(["public", "information_schema"])', 'new Set(["information_schema"])', "شِمای public مجاز")
# ── plan.ts
m("plan.ts", "`REVOKE ALL ON SCHEMA ${s} FROM ${r}`,", "`SELECT 1`,", "حقِ شِما برداشته نمی‌شود (CREATE باقی می‌ماند)")
m("plan.ts", "REVOKE ALL ON ALL TABLES IN SCHEMA", "REVOKE SELECT ON ALL TABLES IN SCHEMA", "REVOKE فقط SELECT را می‌برد")
m("plan.ts", "REVOKE ALL ON ALL SEQUENCES IN SCHEMA", "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA", "دنباله‌ها پاک نمی‌شوند")
m("plan.ts", "tool-policy-grants:apply:${schema}", "tool-policy-grants:apply", "کلیدِ قفل شِما را نمی‌شناسد")
m("plan.ts", "Math.max(500, Math.floor(timeoutMs / 2))", "Math.max(500, timeoutMs)", "سقفِ سرور برابرِ مهلتِ کل")
m("plan.ts", "Math.max(500, Math.floor(timeoutMs / 2))", "Math.max(400, Math.floor(timeoutMs / 2))", "کفِ سقفِ سرور ۴۰۰")
m("plan.ts", "if (rows === null || rows.length > 1) return null;", "if (rows === null || rows.length > 2) return null;", "دو ردیفِ نقش پذیرفته می‌شود")
m("plan.ts", '["replication", "role_replication"]', '["replication", "role_replicat"]', "نامِ یافتهٔ replication عوض می‌شود")
m("plan.ts", '["bypassrls", "role_bypassrls"],\n', "", "bypassrls بررسی نمی‌شود")
m("plan.ts", "return relRows.length === 0 ? SCHEMA_ONLY_PENDING : null;", "return SCHEMA_ONLY_PENDING;", "شِمای ناموجود با رابطهٔ موجود بدشکل نیست")
m("plan.ts", "if (want && !have) drift.push(`missing:schema:${p}`);", "", "حقِ کمِ شِما دیده نمی‌شود")
m("plan.ts", "if (!want && have) drift.push(`excess:schema:${p}`);", "", "حقِ زیادِ شِما دیده نمی‌شود")
m("plan.ts", "if (want && !have) drift.push(`missing:${t}:${p}`);", "", "حقِ کمِ جدول دیده نمی‌شود")
m("plan.ts", "if (!want && have) drift.push(`excess:${t}:${p}`);", "", "حقِ زیادِ جدول دیده نمی‌شود")
m("plan.ts", 'if (e === undefined || e.kind !== "r") {', "if (e === undefined) {", "نما به‌جای جدول پذیرفته می‌شود")
m("plan.ts", 'if (sc.owner) owner.push("owner:schema");', "", "مالکیتِ شِما دیده نمی‌شود")
m("plan.ts", "if (e.owner) owner.push(`owner:${t}`);", "", "مالکیتِ جدول دیده نمی‌شود")
m("plan.ts", "if (e.owner || [...e.privs.values()].some((f) => f.granted)) {", "if ([...e.privs.values()].some((f) => f.granted)) {", "مالکیتِ رابطهٔ ناشناخته دیده نمی‌شود")
m("plan.ts", "if (e.owner || [...e.privs.values()].some((f) => f.granted)) {", "if (e.owner) {", "حقِ رابطهٔ ناشناخته دیده نمی‌شود")
m("plan.ts", "if (known.has(name)) continue;", "", "جدول‌های قرارداد هم «ناشناخته» حساب می‌شوند")
m("plan.ts", "entry.owner !== owner || entry.kind !== kind || entry.privs.has(priv)", "entry.privs.has(priv)", "ردیفِ ناسازگار پذیرفته می‌شود")
m("plan.ts", "entry.owner !== owner || entry.kind !== kind || entry.privs.has(priv)", "entry.owner !== owner || entry.kind !== kind", "ردیفِ تکراری پذیرفته می‌شود")
m("plan.ts", "for (const e of relFacts.values()) if (e.privs.size !== TABLE_PRIVILEGES.length) return null;", "", "رابطهٔ ناقص پذیرفته می‌شود")
m("plan.ts", "if (sc === undefined || sc.privs.size !== SCHEMA_PRIVILEGES.length) return null;", "if (sc === undefined) return null;", "ردیفِ ناقصِ شِما پذیرفته می‌شود")
m("plan.ts", "c.relkind IN ('r','p','v','m','f','S')", "c.relkind IN ('r','p')", "نما و دنباله دیده نمی‌شود")
m("plan.ts", "pg_catalog.pg_has_role($1::name, n.nspowner, 'USAGE') AS owner", "false AS owner", "SQL: مالکِ شِما همیشه false")
m("plan.ts", "pg_catalog.pg_has_role($1::name, c.relowner, 'USAGE') AS owner", "false AS owner", "SQL: مالکِ جدول همیشه false")
m("plan.ts", "'USAGE','CREATE']::text[]) AS p(priv)", "'USAGE']::text[]) AS p(priv)", "SQL: CREATE روی شِما پرسیده نمی‌شود")
m("plan.ts", "'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']::text[]", "'SELECT','INSERT','UPDATE','DELETE','REFERENCES','TRIGGER']::text[]", "SQL: TRUNCATE پرسیده نمی‌شود")
m("plan.ts", "WHERE n.nspname = $2::name AND c.relkind", "WHERE c.relkind", "SQL: رابطه‌های همهٔ شِماها شمرده می‌شود")
# ── execute.ts
m("execute.ts", 'if (first.drift.length === 0) return { code: "OK", phase: "check" };', "", "درست‌بودن بی‌نوشتن نیست")
m("execute.ts", 'if (settings.command === "verify") return { code: "DRIFT", phase: "check" };', "", "verify هم می‌نویسد")
m("execute.ts", 'new Set(["57014", "55P03"])', 'new Set(["57014"])', "55P03 مهلت نیست")
m("execute.ts", 'new Set(["57014", "55P03"])', 'new Set(["55P03"])', "57014 مهلت نیست")
m("execute.ts", "  progress.wrote = true;\n", "", "wrote ثبت نمی‌شود")
m("execute.ts", 'code: second.drift.length === 0 ? "OK" : "APPLY_FAILED"', 'code: "OK"', "ok بر پایهٔ ادعای apply")
m("execute.ts", 'return { code: "ROLE_UNUSABLE", phase: "check" };', 'return { code: "DRIFT", phase: "check" };', "نقشِ نامناسب DRIFT است")
m("execute.ts", 'return { code: "PENDING", phase: "check" };', 'return { code: "UNAVAILABLE", phase: "check" };', "مهاجرتِ معلق در دسترس‌نبودن است")
m("execute.ts", 'if (roleFindings.length > 0) return { kind: "role", findings: roleFindings };', "", "نقشِ ناموجود/خطرناک ادامه می‌دهد")
m("execute.ts", 'if (a.owner.length > 0) return { kind: "owner", findings: a.owner };', "", "مالکیت نادیده است")
m("execute.ts", 'if (a.pending.length > 0) return { kind: "pending", findings: a.pending };', "", "شِما/جدولِ ناموجود نادیده است")
m("execute.ts", 'return { code: "INTERNAL", phase: "check" };', 'return { code: "UNAVAILABLE", phase: "check" };', "بدشکل در دسترس‌نبودن است")
m("execute.ts", 'return { code: "INTERNAL", phase: "verify" };', 'return { code: "OK", phase: "verify" };', "بدشکلِ پس از اعمال ok است")
m("execute.ts", 'return withPg(pg !== null && TIMEOUT_STATES.has(pg) ? "TIMEOUT" : "APPLY_FAILED", "apply", pg);', 'return withPg("APPLY_FAILED", "apply", pg);', "مهلتِ سرور در apply ناموفق است")
m("execute.ts", "  if (progress.cancelled) return { code: \"TIMEOUT\", phase: \"apply\" };\n", "", "نتیجهٔ دیرهنگامِ apply پس از مهلت پذیرفته می‌شود")
m("execute.ts", "  if (progress.cancelled) return { code: \"TIMEOUT\", phase: \"check\" };\n\n  progress.phase = \"apply\";", "  progress.phase = \"apply\";", "پس از مهلت transact شروع می‌شود")
m("execute.ts", "    if (progress.cancelled) return { kind: \"failed\", pg: null };\n    const roleFindings", "    const roleFindings", "پس از مهلت خواندنِ نقش ادامه می‌یابد")
# ── cli.ts
m("cli.ts", 'if (run.kind !== "done") progress.cancelled = true;', "", "رهاشدنِ اجرا ثبت نمی‌شود")
m("cli.ts", 'code: bad ? "INTERNAL" : v.code,', "code: v.code,", "پایگاهِ نامعتبر INTERNAL نیست")
m("cli.ts", 'if (settings.command === "plan") {', "if (false) {", "plan به پایگاه وصل می‌شود")
m("cli.ts", "settings.schema ?? DEFAULT_POLICY_SCHEMA", 'settings.schema ?? "public"', "شِمای پیش‌فرض public")
m("cli.ts", 'code: run.kind === "timeout" ? "TIMEOUT" : "INTERNAL",', 'code: "TIMEOUT",', "خطای زمان‌سنج TIMEOUT است")
m("cli.ts", "statements: planStatements(schema, settings.role, DEFAULT_TIMEOUT_MS)", "statements: planStatements(schema, settings.role, 1000)", "plan با مهلتِ دیگری چاپ می‌شود")
# ── args.ts
m("args.ts", "export const DEFAULT_TIMEOUT_MS = 60_000;", "export const DEFAULT_TIMEOUT_MS = 59_000;", "پیش‌فرضِ مهلت")
m("args.ts", "export const MIN_TIMEOUT_MS = 1_000;", "export const MIN_TIMEOUT_MS = 999;", "کفِ مهلت یکی کمتر")
m("args.ts", "export const MAX_TIMEOUT_MS = 600_000;", "export const MAX_TIMEOUT_MS = 600_001;", "سقفِ مهلت یکی بیشتر")
m("args.ts", "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /^[0-9]{1,10}$/;", "صفرِ پیشرو")
m("args.ts", "if (command !== \"plan\") {\n      const url", "if (true) {\n      const url", "plan هم DATABASE_URL می‌خواهد")
m("args.ts", "if (command === \"plan\" && seenTimeout)", "if (false)", "--timeout-ms با plan مجاز")
m("args.ts", "!KNOWN_TOOL_POLICY_ENV.includes(k))", "false)", "غلط‌یابِ TOOL_POLICY_* خاموش")
m("args.ts", 'if (!seenRole) issues.push(`${FLAG_ROLE} الزامی است.`);', "", "نبودنِ --role خطا نیست")
m("args.ts", ': "?");\n\nexport function', ": name);\n\nexport function", "آرگومانِ غیرفلگ پژواک می‌شود")
m("args.ts", "if (!p.ok) issues.push(`${ENV_SCHEMA} نامعتبر است.`);", "if (false) issues.push(`${ENV_SCHEMA} نامعتبر است.`);", "شِمای نامعتبر پذیرفته می‌شود")
m("args.ts", 'if (schemaRaw !== undefined && schemaRaw !== "")', "if (schemaRaw !== undefined)", "شِمای خالی خطا می‌شود")
m("args.ts", '  "TOOL_POLICY_BOOT_ATTEMPTS",\n', "", "یک نامِ bootstrap از فهرست افتاده")
m("args.ts", "if (seenRole) {\n            issues.push", "if (false) {\n            issues.push", "--role تکراری مجاز")
m("args.ts", 'if (args.length === 1 && (args[0] === "--help"', 'if (args.length >= 1 && (args[0] === "--help"', "help با آرگومانِ دیگر")
# ── lazy-database.ts
m("lazy-database.ts", "if (abandoned) {", "if (false) {", "اتصالِ دیرهنگام بسته نمی‌شود")
m("lazy-database.ts", 'if (state === "opening" || opened === null) return false;', "if (opened === null) return true;", "بازشدنِ در جریان بسته‌شده حساب می‌شود")
m("lazy-database.ts", 'if (!hasFn(o, "close")) {', "if (false) {", "پایگاهِ بی‌close پذیرفته می‌شود")
# ── deadline.ts
m("deadline.ts", 'finish({ kind: "error" });\n    }\n    if (done) return;', 'finish({ kind: "timeout" });\n    }\n    if (done) return;', "خطای زمان‌سنج مهلت حساب می‌شود")
# ── report.ts
m("report.ts", "ok: p.code === \"OK\",", "ok: true,", "ok همیشه true")
m("report.ts", "...(p.wrote === true ? { wrote: true } : {}),", "...({ wrote: p.wrote }),", "wrote همیشه می‌آید")

EQUIVALENT = {
    55: "نگهبانِ افزونه: پس از transactِ دیرهنگام، نگهبانِ نخستِ readState (پس از getDb) همان را می‌گیرد؛ حذفِ یکی به‌تنهایی رفتارِ قابل‌مشاهده ندارد (جهشِ ۵۷ معکوسِ همین است)",
    57: "نگهبانِ افزونه: ابطال فقط هنگامِ آویزان‌بودنِ یک await رخ می‌دهد و پس از getDb بی‌فاصله بررسی نمی‌شود؛ نتیجهٔ دیرهنگامِ transact را نگهبانِ ۵۵ می‌گیرد و پس از خواندنِ نقش نگهبانِ بعدی",
}

env = dict(os.environ)
env.setdefault("CI", "true")


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
