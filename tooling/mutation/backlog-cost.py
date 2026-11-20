#!/usr/bin/env python3
"""
آزمون جهشی «اندازه‌گیریِ هزینهٔ پایشِ پسماند» (م۳‑ه‑۴‑الف‑۲‑۳، ADR-0044) روی `tooling/backlog-cost.ts` (خالص)،
`tooling/backlog-cost-measure.ts` (I/O) و `tooling/cli/backlog-cost.ts` (گلو): هر جهش یک تغییر کوچکِ معنادار است و باید دست‌کم یک آزمون را
قرمز کند؛ جهشِ زنده یعنی آزمونی کم است (یا جهش هم‌ارز است و باید دلیلش نوشته شود).
اجرا:  DATABASE_URL=postgresql://… python3 tooling/mutation/backlog-cost.py            (همه)
       DATABASE_URL=… python3 tooling/mutation/backlog-cost.py 3 9                      (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و PostgreSQL؛ جزو CI نیست. پیش از هر اجرا پیش‌بازرسی می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل هست؛ فایل پس از هر جهش همیشه برمی‌گردد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PURE = "tooling/backlog-cost.ts"
MEAS = "tooling/backlog-cost-measure.ts"
CLI = "tooling/cli/backlog-cost.ts"
TESTS = [
    "tooling/backlog-cost.test.ts",
    "tooling/backlog-cost.property.test.ts",
    "tooling/backlog-cost-measure.pg.test.ts",
    "tooling/backlog-cost-cli.test.ts",
]
M = []


def m(src, old, new, why):
    M.append((src, old, new, why))


# ───── summarizePlan ─────
m(PURE, "outboxRows += (rows + removed) * loops;", "outboxRows += rows * loops;", "ردیف‌های فیلترشده در اسکنِ outbox نادیده می‌شوند")
m(PURE, "outboxRows += (rows + removed) * loops;", "outboxRows += rows + removed;", "تعدادِ تکرار (loops) در اسکنِ outbox نادیده می‌شود")
m(PURE, "ackRows += (rows + removed) * loops;", "ackRows += rows * loops;", "ردیف‌های فیلترشده در جدولِ تأیید نادیده می‌شوند")
m(PURE, "ackRows += (rows + removed) * loops;", "ackRows += rows + removed;", "تکرارِ جست‌وجوهای تأیید نادیده می‌شود")
m(PURE, 'if (type === "Seq Scan") seq = true;', 'if (type !== "Seq Scan") seq = true;', "پرچمِ Seq Scan وارونه")
m(PURE, 'if (type === "Seq Scan") seq = true;', "seq = true;", "هر اسکنِ outbox Seq Scan حساب می‌شود")
m(PURE, "if (/\\bSort\\b/.test(type)) sort = true;", "sort = false;", "گرهٔ Sort هرگز شناخته نمی‌شود")
m(PURE, "if (relation === OUTBOX_TABLE) {", "if (relation !== OUTBOX_TABLE) {", "جدول‌ها جابه‌جا")
m(PURE, "const top = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;", "const top = Array.isArray(raw) ? raw[0] : raw;", "آرایهٔ چندعضوی پذیرفته می‌شود")
m(PURE, "if (!isNum(executionMs) || !isNum(planningMs)) return err(\"BAD_PLAN\");", "if (!isNum(executionMs)) return err(\"BAD_PLAN\");", "Planning Time اعتبارسنجی نمی‌شود")
m(PURE, "if (!isNum(executionMs) || !isNum(planningMs)) return err(\"BAD_PLAN\");", "if (!isNum(planningMs)) return err(\"BAD_PLAN\");", "Execution Time اعتبارسنجی نمی‌شود")
m(PURE, "cur.depth > MAX_DEPTH", "cur.depth >= MAX_DEPTH", "سقفِ عمق یکی کمتر")
m(PURE, "cur.depth > MAX_DEPTH", "cur.depth > MAX_DEPTH + 1", "سقفِ عمق یکی بیشتر")
m(PURE, "out.length >= MAX_NODES", "out.length > MAX_NODES", "سقفِ گره یکی بیشتر")
m(PURE, "out.length >= MAX_NODES", "out.length >= MAX_NODES - 1", "سقفِ گره یکی کمتر")
m(PURE, "if (!Array.isArray(plans)) return null;", "if (!Array.isArray(plans)) continue;", "Plansِ غیرآرایه نادیده گرفته می‌شود")
m(PURE, "if (v === undefined) return 0;", "if (v === undefined) return null;", "فیلدِ اختیاریِ ناموجود خطا می‌شود")
m(PURE, "return isNum(v) ? v : null;", "return typeof v === \"number\" ? v : null;", "فیلدِ اختیاریِ منفی/نامتناهی پذیرفته می‌شود")
m(PURE, "if (typeof type !== \"string\" || type === \"\") return err(\"BAD_PLAN\");", "if (typeof type !== \"string\") return err(\"BAD_PLAN\");", "Node Typeِ تهی پذیرفته می‌شود")
m(PURE, "indexes: Object.freeze([...indexes].sort()),", "indexes: Object.freeze([...indexes]),", "ایندکس‌ها مرتب نمی‌شوند")
m(PURE, "Math.max(1, p.returnedRows)", "p.returnedRows", "تقسیم بر صفر در تقویتِ اسکن")
# ───── نمونه‌ها ─────
m(PURE, "at(Math.ceil(0.95 * n) - 1)", "at(Math.floor(0.95 * n))", "p95 با کفِ نادرست")
m(PURE, "at(Math.ceil(0.95 * n) - 1)", "at(Math.ceil(0.9 * n) - 1)", "p90 به‌جای p95")
m(PURE, "n % 2 === 1 ? at((n - 1) / 2)", "n % 2 === 0 ? at((n - 1) / 2)", "شاخهٔ فرد/زوجِ میانه وارونه")
m(PURE, "(at(n / 2 - 1) + at(n / 2)) / 2", "at(n / 2)", "میانهٔ زوج = عضوِ بالایی")
m(PURE, "if (!samples.every(isNum)) return err(\"BAD_SAMPLE\");", "", "نمونهٔ نامعتبر پذیرفته می‌شود")
m(PURE, "const x = [...(samples as number[])].sort((a, b) => a - b);", "const x = (samples as number[]).sort((a, b) => a - b);", "ورودی در جا مرتب می‌شود")
m(PURE, "const x = [...(samples as number[])].sort((a, b) => a - b);", "const x = [...(samples as number[])].sort();", "مرتب‌سازیِ رشته‌ایِ پیش‌فرض (۱۰ پیش از ۹)")
# ───── برازش ─────
m(PURE, "new Set(points.map((p) => p.x)).size < 2", "new Set(points.map((p) => p.x)).size < 3", "دو نقطه کافی نیست")
m(PURE, "new Set(points.map((p) => p.x)).size < 2", "points.length < 2", "xهای تکراری پذیرفته می‌شوند (تقسیم بر صفر)")
m(PURE, "const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);", "const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);", "r2 برای y ثابت")
m(PURE, "const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);", "const r2 = (sxy * sxy) / (sxx * syy);", "r2 برای y ثابت NaN می‌شود")
m(PURE, "const intercept = my - slope * mx;", "const intercept = my + slope * mx;", "علامتِ عرض از مبدأ")
m(PURE, "return Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : null;", "return Number.isFinite(rows) ? Math.floor(rows) : null;", "افقِ منفی")
m(PURE, "return Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : null;", "return Number.isFinite(rows) ? Math.ceil(rows) : null;", "افق گرد به بالا")
# ───── حکم ─────
m(PURE, "nearTimeoutFraction: 0.5,", "nearTimeoutFraction: 0.6,", "سیاستِ نیمِ مهلت")
m(PURE, "dutyCycleWarn: 0.05,", "dutyCycleWarn: 0.1,", "سیاستِ چرخهٔ کار")
m(PURE, "wideScanAmplification: 100,", "wideScanAmplification: 1000,", "سیاستِ تقویتِ اسکن")
m(PURE, "if (m.stats.p95Ms >= budget.timeoutMs) add(", "if (m.stats.p95Ms > budget.timeoutMs) add(", "مرزِ مهلت اکید")
m(PURE, "else if (m.stats.p95Ms >= budget.timeoutMs * P.nearTimeoutFraction) add(", "else if (m.stats.p95Ms > budget.timeoutMs * P.nearTimeoutFraction) add(", "مرزِ نیمِ مهلت اکید")
m(PURE, "else if (m.stats.p95Ms >= budget.timeoutMs * P.nearTimeoutFraction) add(", "if (m.stats.p95Ms >= budget.timeoutMs * P.nearTimeoutFraction) add(", "هم NEAR هم EXCEEDS گزارش می‌شود")
m(PURE, "m.stats.medianMs / budget.intervalMs >= P.dutyCycleWarn", "m.stats.p95Ms / budget.intervalMs >= P.dutyCycleWarn", "چرخهٔ کار روی p95")
m(PURE, "m.stats.medianMs / budget.intervalMs >= P.dutyCycleWarn", "m.stats.medianMs / budget.intervalMs > P.dutyCycleWarn", "مرزِ چرخهٔ کار اکید")
m(PURE, "m.plan.outboxRowsScanned >= P.wideScanMinRows &&", "m.plan.outboxRowsScanned > P.wideScanMinRows &&", "حدِ ردیفِ تقویت اکید")
m(PURE, "scanAmplification(m.plan) >= P.wideScanAmplification", "scanAmplification(m.plan) > P.wideScanAmplification", "حدِ ضریبِ تقویت اکید")
m(PURE, "m.plan.outboxRowsScanned > m.deadRows * (1 + P.nonDeadTolerance) + P.nonDeadSlack", "m.plan.outboxRowsScanned >= m.deadRows * (1 + P.nonDeadTolerance) + P.nonDeadSlack", "مرزِ غیرِ dead اکید")
m(PURE, "m.plan.outboxRowsScanned > m.deadRows * (1 + P.nonDeadTolerance) + P.nonDeadSlack", "m.plan.outboxRowsScanned > m.deadRows + P.nonDeadSlack", "تلرانسِ غیرِ dead حذف")
m(PURE, "const worse = (a: CostStatus, b: CostStatus): CostStatus => (RANK[a] >= RANK[b] ? a : b);", "const worse = (a: CostStatus, b: CostStatus): CostStatus => (RANK[a] <= RANK[b] ? a : b);", "بدترین با بهترین عوض می‌شود")
m(PURE, "budget.timeoutMs <= 0 ||", "budget.timeoutMs < 0 ||", "مهلتِ صفر پذیرفته می‌شود")
m(PURE, "!measures.every(validMeasure)", "false", "اندازهٔ خراب اعتبارسنجی نمی‌شود")
m(PURE, "isNum(st[\"medianMs\"]) && isNum(st[\"p95Ms\"])", "isNum(st[\"p95Ms\"])", "medianِ اندازه اعتبارسنجی نمی‌شود")
# ───── آرگومان‌ها ─────
m(PURE, "const INT_RE = /^[0-9]{1,9}$/;", "const INT_RE = /^[0-9]+$/;", "عددِ بیش از نُه رقم")
m(PURE, "const INT_RE = /^[0-9]{1,9}$/;", "const INT_RE = /^[0-9۰-۹]{1,9}$/;", "ارقامِ فارسی پذیرفته می‌شوند")
m(PURE, "if (n < 1) return bad(\"BAD_VALUE\", \"scales\");", "if (n < 0) return bad(\"BAD_VALUE\", \"scales\");", "مقیاسِ صفر مجاز")
m(PURE, "if (n > L.maxRows) return bad(\"TOO_LARGE\", \"scales\");", "if (n >= L.maxRows) return bad(\"TOO_LARGE\", \"scales\");", "سقفِ ردیف اکید")
m(PURE, "<= (scales[i - 1] as number)", "< (scales[i - 1] as number)", "مقیاسِ تکراری مجاز")
m(PURE, "parts.length > L.maxScales", "parts.length >= L.maxScales", "سقفِ تعدادِ مقیاس یکی کمتر")
m(PURE, "return n >= min && n <= max ? n : null;", "return n > min && n <= max ? n : null;", "کفِ بازهٔ عددی اکید")
m(PURE, "return n >= min && n <= max ? n : null;", "return n >= min && n < max ? n : null;", "سقفِ بازهٔ عددی اکید")
m(PURE, "if (seen.has(name)) return bad(\"DUPLICATE_FLAG\", name);", "", "فلگِ تکراری پذیرفته می‌شود")
m(PURE, "if (!FLAGS.includes(name)) return bad(\"UNKNOWN_FLAG\", name);", "", "فلگِ ناشناخته پذیرفته می‌شود")
m(PURE, "if (m[2] === undefined) return bad(\"BAD_VALUE\", name);", "", "فلگِ بی‌مقدار پذیرفته می‌شود")
m(PURE, "if (Math.max(...scales) + unacked + done > L.maxRows)", "if (Math.max(...scales) + unacked + done >= L.maxRows)", "سقفِ کلِ ردیف اکید")
m(PURE, "if (Math.max(...scales) + unacked + done > L.maxRows)", "if (Math.max(...scales) > L.maxRows)", "مجموعِ ردیف‌ها سنجیده نمی‌شود")
m(PURE, "unacked: 3, done: 0, limit: 1_000, repeats: 7,", "unacked: 3, done: 0, limit: 1_000, repeats: 8,", "پیش‌فرضِ تکرار")
m(PURE, "timeoutMs: 5_000, intervalMs: 30_000,", "timeoutMs: 5_000, intervalMs: 60_000,", "پیش‌فرضِ بازه")
m(PURE, "const fmt = seen.get(\"format\") ?? D.format;", "const fmt = seen.get(\"format\") ?? \"text\";", "پیش‌فرضِ قالب")
# ───── گزارش ─────
m(PURE, "deadRows: s.ackedDead + args.unacked,", "deadRows: s.ackedDead,", "deadRows بی‌تأییدنشده‌ها")
m(PURE, "fitLinear(scenarios.map((s) => ({ x: s.ackedDead, y: s.stats.p95Ms })))", "fitLinear(scenarios.map((s) => ({ x: s.ackedDead, y: s.stats.medianMs })))", "برازش روی میانه")
m(PURE, "horizonRows(fit, args.timeoutMs * COST_POLICY.nearTimeoutFraction)", "horizonRows(fit, args.timeoutMs)", "افقِ نیمِ مهلت = افقِ مهلت")
m(PURE, "horizonToTimeoutAckedRows: fit === null ? null : horizonRows(fit, args.timeoutMs),", "horizonToTimeoutAckedRows: fit === null ? null : horizonRows(fit, args.intervalMs),", "افق روی بازه")
m(PURE, "if (report.fit !== null) {", "if (report.fit === null) {", "خطِ برازش در متن وارونه")
m(PURE, "lines.push(`overall: ${report.verdict.status}`);", "lines.push(`overall: ok`);", "حکمِ کل در متن")
# ───── I/O ─────
m(MEAS, "const SCHEMA_RE = /^backlog_cost_[0-9a-f]{10}$/;", "const SCHEMA_RE = /^backlog_cost_[0-9a-f]{10}/;", "نامِ شِما بی‌لنگرِ پایان")
m(MEAS, "const SCHEMA_RE = /^backlog_cost_[0-9a-f]{10}$/;", "const SCHEMA_RE = /backlog_cost_[0-9a-f]{10}$/;", "نامِ شِما بی‌لنگرِ آغاز")
m(MEAS, "if (!SCHEMA_RE.test(schema)) return [];", "", "بذرپاشی بی‌سنجشِ نامِ شِما")
m(MEAS, "if (scale.acked > 0) {", "if (scale.acked >= 0) {", "دستورِ تأییدشده‌ها با صفر هم ساخته می‌شود")
m(MEAS, "if (scale.unacked > 0) out.push", "if (scale.unacked >= 0) out.push", "دستورِ تأییدنشده‌ها با صفر هم ساخته می‌شود")
m(MEAS, "if (scale.done > 0) {", "if (scale.done >= 0) {", "دستورِ done با صفر هم ساخته می‌شود")
m(MEAS, "dead(\"u\", scale.unacked, 2_000_000_000)", "dead(\"u\", scale.unacked, 500_000)", "تأییدنشده‌ها قدیمی‌تر از تأییدشده‌ها (بهترین حالت، نه بدترین)")
m(MEAS, "dead(\"k\", scale.acked, 1_000_000)", "dead(\"k\", scale.acked, 2_000_000_000)", "تأییدشده‌ها تازه‌تر از تأییدنشده‌ها")
m(MEAS, "      await ports.pool.query(`VACUUM (ANALYZE) \"${schema}\".settlement_outbox`);\n", "", "VACUUM outbox حذف")
m(MEAS, "      await ports.pool.query(`VACUUM (ANALYZE) \"${schema}\".settlement_dead_ack`);\n", "", "VACUUM جدولِ تأیید حذف")
m(MEAS, "return r.ok ? dt : null;", "return dt;", "شکستِ خواندن نادیده")
m(MEAS, "i < args.repeats && !readFailed", "i <= args.repeats && !readFailed", "یک تکرارِ اضافه")
m(MEAS, "i < args.repeats && !readFailed", "i < args.repeats - 1 && !readFailed", "یک تکرارِ کمتر")
m(MEAS, "if (dt === null) readFailed = true;", "if (dt === null) continue;", "نمونهٔ شکست‌خورده رد می‌شود")
m(MEAS, "const last = log[log.length - 1];", "const last = log[0];", "EXPLAIN روی نخستین دستور (سپرِ مهاجرت) نه پرسشِ داده")
m(MEAS, "FORMAT JSON) ${last.text}", "FORMAT TEXT) ${last.text}", "قالبِ EXPLAIN")
m(MEAS, "values: last.params", "values: []", "پارامترهای پیوندی گم می‌شوند")
m(MEAS, "text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${last.text}`", "text: `EXPLAIN (BUFFERS, FORMAT JSON) ${last.text}`", "EXPLAIN بی‌ANALYZE (شمارِ واقعی نیست)")
m(MEAS, "  if (created) {\n    try {", "  if (false) {\n    try {", "پاک‌سازیِ شِما حذف")
m(MEAS, "      return fail(\"CLEANUP_FAILED\");", "      return result;", "شکستِ پاک‌سازی بلعیده می‌شود")
m(MEAS, "    created = true; // پس از این نقطه هر خروج باید شِما را پاک کند\n", "", "پرچمِ created ثبت نمی‌شود")
m(MEAS, "      phase = \"read\";\n", "", "فاز به «خواندن» نمی‌رسد")
m(MEAS, "!created ? \"DATABASE_UNAVAILABLE\" : phase === \"seed\" ? \"SEED_FAILED\" : \"READ_FAILED\"", "!created ? \"DATABASE_UNAVAILABLE\" : \"SEED_FAILED\"", "کدِ شکستِ خواندن همیشه بذر")
m(MEAS, "if (!one.ok) return one;", "if (!one.ok) continue;", "شکستِ یک سناریو نادیده")
m(MEAS, "    return fail(\"DATABASE_UNAVAILABLE\");\n  }\n  const scenarios", "    server = \"unknown\";\n  }\n  const scenarios", "ناپایگاه بلعیده می‌شود")
m(MEAS, "log.push({ text: compiled.sql, params: [...compiled.params] });", "log.push({ text: compiled.sql, params: [] });", "پارامترها ضبط نمی‌شوند")
m(MEAS, "transaction: (run, config) => db.transaction((tx) => run(wrap(tx)), config),", "transaction: (run, config) => db.transaction((tx) => run(tx), config),", "دستورهای درونِ تراکنش ضبط نمی‌شوند")
m(MEAS, "transaction: (run, config) => db.transaction((tx) => run(wrap(tx)), config),", "transaction: (run) => db.transaction((tx) => run(wrap(tx))),", "پیکربندیِ فقط‌خواندنیِ تراکنش گم می‌شود")
m(MEAS, "} catch {\n      // پیشرفت اختیاری است.", "} catch (e) {\n      throw e;", "خطای پیشرفت منتشر می‌شود")
# ───── CLI ─────
m(CLI, 'return out.value.verdict.status === "fail" ? EXIT.fail : EXIT.ok;', "return EXIT.ok;", "حکمِ fail خروجِ ۰ می‌دهد")
m(CLI, 'return out.value.verdict.status === "fail" ? EXIT.fail : EXIT.ok;', 'return out.value.verdict.status !== "ok" ? EXIT.fail : EXIT.ok;', "warn هم fail می‌شود")
m(CLI, 'if (typeof url !== "string" || url === "") {', 'if (typeof url !== "string") {', "DATABASE_URL تهی پذیرفته می‌شود")
m(CLI, "args.value.format === \"text\" ? renderText(out.value)", "args.value.format === \"json\" ? renderText(out.value)", "قالب‌ها جابه‌جا")
m(CLI, "return EXIT.usage;\n  }\n  const url", "return EXIT.error;\n  }\n  const url", "کدِ خروجِ آرگومانِ بد")
m(CLI, "code: out.error.code", "code: \"X\"", "کدِ خطای اندازه‌گیری گم می‌شود")
m(CLI, "await pool.end().catch(() => undefined);", "", "استخر بسته نمی‌شود")

env = dict(os.environ)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=900)
    return r.returncode == 0


# هم‌ارزهای توضیح‌داده‌شده (شمارهٔ جهش ← دلیلِ رفتاری)؛ فقط پس از بازبینیِ تک‌تکِ زنده‌ها.
EQUIVALENT: dict = {
    108: "فرایند همیشه با process.exit صریح تمام می‌شود (ADR-0044 تصمیم ۵)؛ pool.end فقط بستنِ مؤدبانهٔ اتصال است و اثرِ مشاهده‌پذیر (خروجی/کد) ندارد",
}
lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
origs = {}
for i, (f, old, new, why) in enumerate(M):
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
