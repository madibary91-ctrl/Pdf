#!/usr/bin/env python3
"""
آزمون جهشی «مهاجرت‌دهندهٔ نمایهٔ مرده‌های در انتظارِ تأیید» (ماژول settlement-pending-migrate؛ برش م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۱، ADR-0047): هر جهش یک تغییر کوچکِ معنادار
در منبعِ ماژول است و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است.
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/settlement-pending-migrate.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/settlement-pending-migrate.py 3 9                    (فقط جهش‌های ۳ تا ۹)
هر جهش نخست با آزمون‌های سریع (بی‌پایگاه) سنجیده می‌شود؛ فقط اگر زنده ماند، `cli.pg.test.ts` (PostgreSQL واقعی، کُند) هم اجرا می‌شود.
آزمونِ فرایندِ واقعی (process.pg.test.ts) عمداً در این مجموعه نیست. جزو CI نیست.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل‌ها پس از هر جهش همیشه برمی‌گردند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement-pending-migrate/"
FAST = [B + "args.test.ts", B + "cli.test.ts", B + "purity.test.ts", "tooling/settlement-pending-migrate-parity.test.ts"]
SLOW = [B + "cli.pg.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


A, X, C, CL, S, R = "args.ts", "execute.ts", "exit-codes.ts", "cli.ts", "stores.ts", "report.ts"
# ── exit-codes.ts
m(C, 'withPg(error.pgCode === QUERY_CANCELED ? "TIMEOUT" : "UNAVAILABLE", error)', 'withPg("UNAVAILABLE", error)', "لغوِ زمانِ سمتِ پایگاه در خواندن «در دسترس نیست» می‌شود")
m(C, 'case "NOT_MIGRATED":\n      return withPg("PENDING", error);', 'case "NOT_MIGRATED":\n      return withPg("UNAVAILABLE", error);', "NOT_MIGRATED در خواندن معلق نیست")
m(C, 'case "NOT_MIGRATED":\n      return withPg("PREREQUISITE", error);', 'case "NOT_MIGRATED":\n      return withPg("MIGRATION_FAILED", error);', "نبودِ پیش‌نیاز ۶ می‌شود نه ۸")
m(C, 'if (error.pgCode === LOCK_NOT_AVAILABLE) return withPg("LOCK_BUSY", error);', "", "قفل‌مشغول (55P03) ۶ می‌شود")
m(C, 'const LOCK_NOT_AVAILABLE = "55P03";', 'const LOCK_NOT_AVAILABLE = "55P04";', "SQLSTATE قفل‌مشغول اشتباه است")
m(C, 'case "COMMIT_REJECTED":\n      return withPg("MIGRATION_FAILED", error);', 'case "COMMIT_REJECTED":\n      return withPg("INTERNAL", error);', "ردِ قید توسطِ TRIGGER/backfill ۱ می‌شود")
m(C, 'return withPg(error.pgCode === QUERY_CANCELED ? "TIMEOUT" : "MIGRATION_FAILED", error);', 'return withPg("MIGRATION_FAILED", error);', "لغوِ زمان در apply ۶ می‌شود نه ۷")
m(C, 'return c.code === "PENDING" ?', "return false ?", "NOT_MIGRATED پس از اعمال معلق می‌ماند نه شکست")
m(C, "const SQLSTATE = /^[0-9A-Z]{5}$/;", "const SQLSTATE = /^.*$/;", "هر pgCode (حتی متنِ دلخواه) در گزارش می‌آید")
# ── execute.ts
m(X, 'new Set(["40001", "40P01"])', 'new Set(["40001", "40P01", "55P03"])', "قفل‌مشغول خودکار تکرار می‌شود (نویسنده‌ها بارها در صف)")
m(X, 'new Set(["40001", "40P01"])', 'new Set(["40001", "40P01", "23505"])', "23505 تکرار می‌شود")
m(X, 'new Set(["40001", "40P01"])', 'new Set(["40001"])', "بن‌بست (40P01) تکرار نمی‌شود")
m(X, "export const APPLY_ATTEMPTS = 3;", "export const APPLY_ATTEMPTS = 1;", "هیچ بازتلاشی نیست")
m(X, "attempt < APPLY_ATTEMPTS && retryable", "attempt <= APPLY_ATTEMPTS && retryable", "یک تلاشِ اضافه")
m(X, "    if (progress.cancelled) return fail(progress, { code: \"TIMEOUT\" });\n    let r: unknown;", "    let r: unknown;", "پس از مهلت، migrate (backfill) تازه‌ای شروع می‌شود")
m(X, "      if (progress.cancelled) return fail(progress, { code: \"TIMEOUT\" });\n      continue;", "      continue;", "پس از مهلت، بازتلاش ادامه می‌یابد")
m(X, 'if (v.consistent !== (v.missing === 0 && v.stale === 0)) return "malformed";', "", "ادعای consistent بی‌بازمحاسبه پذیرفته می‌شود")
m(X, 'code: v.report.consistent ? ("OK" as const) : ("INCONSISTENT" as const)', 'code: "OK" as const', "ناهمخوانی هرگز ۹ نیست")
m(X, 'if (again.pending.length > 0) return fail(progress, { code: "MIGRATION_FAILED" });', "", "معلقِ باقی‌مانده پس از اعمال پذیرفته می‌شود")
m(X, 'if (!pending) return Object.freeze({ code: "OK" as const, phase: "check" as const });', "", "بی‌کاری هم migrate می‌زند")
m(X, 'if (pending) return Object.freeze({ code: "PENDING" as const, phase: "check" as const });\n    return checkIndex', "return checkIndex", "verify روی نصب‌نشده هم اجرا می‌شود")
m(X, 'code: pending ? ("PENDING" as const) : ("OK" as const)', 'code: pending ? ("OK" as const) : ("PENDING" as const)', "status معلق را ۰ می‌دهد")
m(X, "Number.isSafeInteger(v) && v >= 0", "Number.isSafeInteger(v)", "شمارشِ منفی پذیرفته می‌شود")
m(X, "typeof v === \"number\" && Number.isSafeInteger(v)", "typeof v === \"number\"", "شمارشِ اعشاری پذیرفته می‌شود")
m(X, "  progress.phase = \"verify\";\n  if (progress.cancelled) return fail(progress, { code: \"TIMEOUT\" });\n  const v = await readVerify", "  progress.phase = \"verify\";\n  const v = await readVerify", "پس از مهلت، verify (سنگین) شروع می‌شود")
m(X, "  progress.phase = \"verify\";\n  if (progress.cancelled) return fail(progress, { code: \"TIMEOUT\" });\n  const now", "  progress.phase = \"verify\";\n  const now", "پس از مهلت، status ی راستی‌آزمایی شروع می‌شود")
m(X, "      progress.retries++;\n", "", "شمارِ بازتلاش گزارش نمی‌شود")
m(X, 'if (!isNames(v.applied) || !isNames(v.pending)) return "malformed";', "", "شکلِ مخدوشِ status پذیرفته می‌شود")
m(X, "return fail(progress, classifyError(again.error, classifyVerify));", "return fail(progress, classifyError(again.error, classifyRead));", "خطای status پس از اعمال با نگاشتِ خواندن")
m(X, "return checkIndex(index, progress, classifyVerify);", "return checkIndex(index, progress, classifyRead);", "خطای verify پس از اعمال با نگاشتِ خواندن")
m(X, "progress.migrations = state(again.applied, again.pending, now);", "progress.migrations = state(again.applied, again.pending, []);", "appliedNow پس از راستی‌آزمایی گم می‌شود")
# ── args.ts
m(A, "const DIGITS = /^[1-9][0-9]{0,9}$/;", "const DIGITS = /^[0-9]{1,10}$/;", "صفرِ آغازین پذیرفته می‌شود")
m(A, "export const MAX_TIMEOUT_MS = 600_000;", "export const MAX_TIMEOUT_MS = 6_000_000;", "سقفِ مهلت بالا می‌رود")
m(A, "export const MIN_TIMEOUT_MS = 1_000;", "export const MIN_TIMEOUT_MS = 1;", "مهلتِ ۱ms مجاز می‌شود")
m(A, "k.startsWith(ENV_PREFIX) && !KNOWN_SETTLEMENT_ENV.includes(k)", "false", "غلطِ تایپیِ نامِ SETTLEMENT_* دیده نمی‌شود")
m(A, "  ENV_BACKLOG_WATCH,\n", "", "SETTLEMENT_BACKLOG_WATCH ناشناخته می‌شود")
m(A, "  ...Object.values(SETTLEMENT_BACKLOG_WATCH_ENV),\n", "", "آستانه‌های پایش ناشناخته می‌شوند (همان نقصِ settlement-migrate)")
m(A, 'if (typeof url !== "string" || url === "") issues.push', "if (false) issues.push", "DATABASE_URL الزامی نیست")
m(A, 'const COMMANDS: readonly string[] = ["status", "up", "verify"];', 'const COMMANDS: readonly string[] = ["status", "up"];', "verify پذیرفته نمی‌شود")
m(A, 'if (raw === undefined || raw === "") continue;', 'if (raw === undefined) continue;', "شِمای خالی رشتهٔ خالی می‌شود نه پیش‌فرض")
m(A, "else if (name === ENV_OUTBOX_SCHEMA) schema = raw;", "else schema = raw;", "شِمای ledger جایگزینِ شِمای outbox می‌شود")
m(A, 'if (typeof raw !== "string") issues.push(`${name} باید رشته باشد.`);', "if (false) issues.push(`${name} باید رشته باشد.`);", "شِمای غیررشته‌ای پذیرفته می‌شود")
m(A, '(/^--[a-z][a-z0-9-]{0,31}$/.test(name) ? JSON.stringify(name) : "?")', "JSON.stringify(name)", "هر «نامِ فلگ» (حتی رشتهٔ اتصال) پژواک می‌شود")
m(A, "} else if (seenTimeout) {", "} else if (false) {", "فلگِ مهلتِ تکراری پذیرفته می‌شود")
m(A, "} else if (seenCommand) {", "} else if (false) {", "آرگومانِ موضعیِ اضافه پذیرفته می‌شود")
# ── cli.ts / stores.ts / report.ts
m(CL, "readStatementTimeoutMs: settings.timeoutMs", "readStatementTimeoutMs: 600_000", "سقفِ سمتِ پایگاه با مهلتِ کل یکی نیست")
m(CL, 'code: lazy.invalid() ? "INTERNAL" : v.code,', "code: v.code,", "پایگاهِ نامعتبر نادیده گرفته می‌شود")
m(CL, 'if (run.kind !== "done") progress.cancelled = true;', "", "پس از مهلت اجرای رهاشده لغو نمی‌شود")
m(CL, 'code: run.kind === "timeout" ? "TIMEOUT" : "INTERNAL",', 'code: "TIMEOUT",', "خطای زمان‌سنج TIMEOUT گزارش می‌شود")
m(S, "...(options.schema === null ? {} : { schema: options.schema }), ", "", "شِمای env نادیده گرفته می‌شود (شِمای پیش‌فرض مهاجرت می‌شود)")
m(S, "readStatementTimeoutMs: options.readStatementTimeoutMs", "readStatementTimeoutMs: 7_200_000", "سقفِ سمتِ پایگاهِ verify رها می‌شود")
m(S, 'issues: Object.freeze([`${ENV_OUTBOX_SCHEMA} نامعتبر است.`])', "issues: Object.freeze([`${ENV_OUTBOX_SCHEMA} نامعتبر است.`, String(options.schema)])", "مقدارِ شِما در پیام می‌آید")
m(R, 'ok: p.code === "OK",', "ok: true,", "ok همیشه true است")

# هم‌ارزهای مستند (جهشی که رفتارِ بیرونی را عوض نمی‌کند). هر مورد با دلیل.
EQUIVALENT_BY_WHY = {
    "پس از مهلت، بازتلاش ادامه می‌یابد": "دفاعِ دوم: ابتدای هر دورِ حلقه همان چکِ cancelled را دارد؛ حذفِ چکِ پیش از continue رفتارِ بیرونی را عوض نمی‌کند (جهشِ پیش‌ازآن، که چکِ ابتدای حلقه را برمی‌دارد، کشته می‌شود)",
}
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
