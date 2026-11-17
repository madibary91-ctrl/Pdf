"""
آزمون جهشی دستی برای ترمیم کنترل‌شدهٔ ai-orchestrator (برش ۷‑۳الف؛ ADR-0017): هر جهش را اعمال می‌کند، تست‌های ماژول (و قراردادهای
پایگاه واقعی) را اجرا می‌کند و فایل را برمی‌گرداند. هر جهش باید «KILLED» شود. «SURVIVED» = تست ضعیف یا کد مرده/هم‌ارز.
فقط Python 3 استاندارد؛ جزو CI نیست. نیاز: Node ≥ 22 و پایگاه آزمون (KB_TEST_DATABASE_URL یا DATABASE_URL).
اجرا: python3 tooling/mutation/ai-orchestrator-repair.py          (همه)
      python3 tooling/mutation/ai-orchestrator-repair.py 3 9      (فقط جهش‌های ۳ تا ۹)
هر جهش یک بار (و فقط نخستین رخداد) اعمال می‌شود؛ اگر متن اصلی پیدا نشود اجرا متوقف می‌شود (کد عوض شده و فهرست باید به‌روز شود).
# (عمداً نیامده — هم‌ارز: ۱) `held.accounting = merged;` در orchestrator.ts؛ پس از آن فقط توابع خالصِ ما اجرا می‌شود و پرتاب ناممکن است، پس اثرِ قابل‌مشاهده ندارد؛
#  خط برای بستن همان پنجرهٔ نظری مانده است (اگر کد پس از آن روزی چیزی پرتاب کند پول تلاش دوم گم نشود). ۲) حذف `if (issues.length > before) return null;` در parseRepair؛ در هر حال `issues` ناتهی ⇒ INVALID_CONFIG؛ نگهبان فقط برای
#  این است که مقدارِ نامعتبر هرگز به‌صورت شیءِ «معتبر» ساخته نشود و cast پایین‌تر دروغ نگوید.)
"""
import subprocess, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
D = os.path.join(ROOT, 'src/modules/ai-orchestrator') + '/'
TESTS = ['src/modules/ai-orchestrator', 'tooling/orchestrator-pipeline.test.ts', 'tooling/orchestrator-repair-pipeline.test.ts']
M = [
 # accounting.ts — تجمیع
 ('accounting.ts', 'SOURCE_RANK[a.source] >= SOURCE_RANK[b.source] ? a.source : b.source', 'a.source'),
 ('accounting.ts', 'SOURCE_RANK[a.source] >= SOURCE_RANK[b.source] ? a.source : b.source', 'SOURCE_RANK[a.source] >= SOURCE_RANK[b.source] ? b.source : a.source'),
 ('accounting.ts', 'a.providerCalls === null || b.providerCalls === null ? null :', 'a.providerCalls === null && b.providerCalls === null ? null :'),
 ('accounting.ts', ': a.providerCalls + b.providerCalls', ': a.providerCalls'),
 ('accounting.ts', 'a.costUnknownCalls === null || b.costUnknownCalls === null ? null :', 'a.costUnknownCalls === null && b.costUnknownCalls === null ? null :'),
 ('accounting.ts', ': a.costUnknownCalls + b.costUnknownCalls', ': a.costUnknownCalls'),
 ('accounting.ts', 'retried: a.retried || b.retried', 'retried: a.retried && b.retried'),
 ('accounting.ts', 'fellBack: a.fellBack || b.fellBack', 'fellBack: a.fellBack'),
 ('accounting.ts', 'if (cur === null || s.micros === null) total.set(s.currency, null);', 'if (cur === null && s.micros === null) total.set(s.currency, null);'),
 ('accounting.ts', 'Number.isSafeInteger(sum) ? sum : null', 'sum'),
 ('accounting.ts', '      order.push(s.currency);\n', ''),
 ('accounting.ts', 'const sum = cur + s.micros;', 'const sum = s.micros;'),
 # accounting.ts — دروازهٔ هزینه
 ('accounting.ts', 'accounting.source === "unknown" ||', 'false ||'),
 ('accounting.ts', 'accounting.providerCalls === null ||', 'false ||'),
 ('accounting.ts', 'accounting.costUnknownCalls !== 0 ||', 'false ||'),
 ('accounting.ts', 'accounting.spend.length === 0) return "cost-unknown"', 'false) return "cost-unknown"'),
 ('accounting.ts', 'if (s.micros === null || s.currency !== policy.currency) return "cost-unknown";', 'if (s.micros === null) return "cost-unknown";'),
 ('accounting.ts', 'if (s.micros === null || s.currency !== policy.currency) return "cost-unknown";', 'if (s.currency !== policy.currency) return "cost-unknown";'),
 ('accounting.ts', 'total <= policy.maxFirstAttemptSpendMicros ?', 'total < policy.maxFirstAttemptSpendMicros ?'),
 ('accounting.ts', 'total += s.micros;', 'total = s.micros;'),
 # config.ts
 ('config.ts', 'Number.isSafeInteger(spend)', 'Number.isFinite(spend)'),
 ('config.ts', 'spend < 0)', 'spend < -1)'),
 ('config.ts', 'typeof currency !== "string" || !CURRENCY_RE.test(currency)', 'typeof currency !== "string"'),
 ('config.ts', 'const CURRENCY_RE = /^[A-Z]{3}$/;', 'const CURRENCY_RE = /^[A-Z]{3}/;'),
 ('config.ts', 'const CURRENCY_RE = /^[A-Z]{3}$/;', 'const CURRENCY_RE = /^[A-Za-z]{3}$/;'),
 ('config.ts', 'for (const k of Object.keys(v)) if (!REPAIR_KEYS.has(k))', 'for (const k of [] as string[]) if (!REPAIR_KEYS.has(k))'),
 ('config.ts', 'if (policy["repair"] !== undefined) repair = parseRepair', 'if (false) repair = parseRepair'),
 ('config.ts', '...(repair === null ? {} : { repair })', '...({})'),
 ('config.ts', 'return Object.freeze({ maxFirstAttemptSpendMicros: spend as number, currency: currency as string });', 'return { maxFirstAttemptSpendMicros: spend as number, currency: currency as string };'),
 ('config.ts', 'new Set(["onRejectedCitation", "requireQuotes", "repair"])', 'new Set(["onRejectedCitation", "requireQuotes"])'),
 ('config.ts', 'if (!isRecord(v)) {\n    issues.push("policy.repair");', 'if (false) {\n    issues.push("policy.repair");'),
 # prompt.ts — بازخورد و پرامپت ترمیم
 ('prompt.ts', 'new Set(["malformed-marker", "unknown-source", "missing-quote", "quote-mismatch"])', 'new Set(["unknown-source", "missing-quote", "quote-mismatch"])'),
 ('prompt.ts', 'new Set(["malformed-marker", "unknown-source", "missing-quote", "quote-mismatch"])', 'new Set(["malformed-marker", "missing-quote", "quote-mismatch"])'),
 ('prompt.ts', 'new Set(["malformed-marker", "unknown-source", "missing-quote", "quote-mismatch"])', 'new Set(["malformed-marker", "unknown-source", "quote-mismatch"])'),
 ('prompt.ts', 'new Set(["malformed-marker", "unknown-source", "missing-quote", "quote-mismatch"])', 'new Set(["malformed-marker", "unknown-source", "missing-quote"])'),
 ('prompt.ts', 'new Set(["malformed-marker", "unknown-source", "missing-quote", "quote-mismatch"])', 'new Set(["malformed-marker", "unknown-source", "missing-quote", "quote-mismatch", "gap"])'),
 ('prompt.ts', 'if (r.kind === "mention") return "mention";', 'if (false) return "mention";'),
 ('prompt.ts', 'ids.length < MAX_LISTED_IDS', 'ids.length <= MAX_LISTED_IDS'),
 ('prompt.ts', 'r.kind === "claim" && r.id !== null && /^S[0-9]{1,3}$/.test(r.id)', 'r.kind === "claim" && r.id !== null'),
 ('prompt.ts', 'r.kind === "claim" && r.id !== null', 'r.id !== null'),
 ('prompt.ts', '!ids.includes(r.id) &&', 'true &&'),
 ('prompt.ts', 'if (trigger === "output-invalid") keys.add("output-invalid");', 'if (false) keys.add("output-invalid");'),
 ('prompt.ts', 'else if (trigger === "no-valid-citation") keys.add("no-valid-citation");', 'else if (false) keys.add("no-valid-citation");'),
 ('prompt.ts', 'HINT_ORDER.filter((k) => keys.has(k))', 'HINT_ORDER.filter(() => true)'),
 ('prompt.ts', '...(ids.length > 0 ? [`منبع‌های ردشده: ${ids.join(", ")}`] : []), FEEDBACK_FOOTER]', '...(ids.length > 0 ? [`منبع‌های ردشده: ${ids.join(", ")}`] : [])]'),
 ('prompt.ts', 'const body = [FEEDBACK_HEADER, ...lines,', 'const body = [...lines,'),
 ('prompt.ts', '"<(?=\\\\s*/?\\\\s*feedback\\\\b)", "gi"', '"<(?=\\\\s*/?\\\\s*feedback\\\\b)", "g"'),
 ('prompt.ts', '"<(?=\\\\s*/?\\\\s*feedback\\\\b)", "gi"', '"<(?=\\\\s*/?\\\\s*feedback\\\\b)", "i"'),
 ('prompt.ts', 'buildPrompt(neutralizeFeedbackFence(question), neutralizeFeedbackFence(contextText))', 'buildPrompt(question, neutralizeFeedbackFence(contextText))'),
 ('prompt.ts', 'buildPrompt(neutralizeFeedbackFence(question), neutralizeFeedbackFence(contextText))', 'buildPrompt(neutralizeFeedbackFence(question), contextText)'),
 ('prompt.ts', 'REPAIR_FEEDBACK_MAX_CHARS = 1200', 'REPAIR_FEEDBACK_MAX_CHARS = 300'),
 ('prompt.ts', 'REPAIR_PROMPT_VERSION = "qa-grounded-repair/1"', 'REPAIR_PROMPT_VERSION = "qa-grounded/1"'),
 ('prompt.ts', 'chars: SYSTEM_PROMPT.length + user.length };\n}\n', 'chars: user.length };\n}\n'),
 # orchestrator.ts
 ('orchestrator.ts', 'const reserve = repairPolicy === undefined ? 0 : REPAIR_FEEDBACK_MAX_CHARS;', 'const reserve = 0;'),
 ('orchestrator.ts', 'limits.maxInputChars - fixedChars - reserve', 'limits.maxInputChars - fixedChars + reserve'),
 ('orchestrator.ts', 'if (repairPolicy === undefined) return first.ok', 'if (false) return first.ok'),
 ('orchestrator.ts', 'status === "answered" || status === "model-abstained"', 'status === "answered"'),
 ('orchestrator.ts', 'status === "answered" || status === "model-abstained"', 'status === "model-abstained"'),
 ('orchestrator.ts', 'if (status === "withheld" && rejections.length === 0)', 'if (status === "withheld")'),
 ('orchestrator.ts', 'if (hasRepairableRejection(rejections)) return { trigger: "citation-rejected" };', 'if (rejections.length > 0) return { trigger: "citation-rejected" };'),
 ('orchestrator.ts', 'e.code === "MODEL_OUTPUT_INVALID" && e.reason !== undefined && FORMAT_REASONS.has(e.reason)', 'e.code === "MODEL_OUTPUT_INVALID"'),
 ('orchestrator.ts', 'new Set<OutputInvalidReason>(["not-json", "bad-fence", "not-object", "missing-answer", "bad-field"])', 'new Set<OutputInvalidReason>(["bad-fence", "not-object", "missing-answer", "bad-field"])'),
 ('orchestrator.ts', 'new Set<OutputInvalidReason>(["not-json", "bad-fence", "not-object", "missing-answer", "bad-field"])', 'new Set<OutputInvalidReason>(["not-json", "not-object", "missing-answer", "bad-field"])'),
 ('orchestrator.ts', 'new Set<OutputInvalidReason>(["not-json", "bad-fence", "not-object", "missing-answer", "bad-field"])', 'new Set<OutputInvalidReason>(["not-json", "bad-fence", "missing-answer", "bad-field"])'),
 ('orchestrator.ts', 'new Set<OutputInvalidReason>(["not-json", "bad-fence", "not-object", "missing-answer", "bad-field"])', 'new Set<OutputInvalidReason>(["not-json", "bad-fence", "not-object", "bad-field"])'),
 ('orchestrator.ts', 'new Set<OutputInvalidReason>(["not-json", "bad-fence", "not-object", "missing-answer", "bad-field"])', 'new Set<OutputInvalidReason>(["not-json", "bad-fence", "not-object", "missing-answer"])'),
 ('orchestrator.ts', 'new Set<OutputInvalidReason>(["not-json", "bad-fence", "not-object", "missing-answer", "bad-field"])', 'new Set<OutputInvalidReason>(["not-json", "bad-fence", "not-object", "missing-answer", "bad-field", "empty"])'),
 ('orchestrator.ts', 'answered: 4, "answered-redacted": 3,', 'answered: 3, "answered-redacted": 3,'),
 ('orchestrator.ts', '"answered-redacted": 3, "model-abstained": 2,', '"answered-redacted": 4, "model-abstained": 2,'),
 ('orchestrator.ts', '"model-abstained": 2, withheld: 1,', '"model-abstained": 3.5, withheld: 1,'),
 ('orchestrator.ts', '"model-abstained": 2, withheld: 1,', '"model-abstained": 2, withheld: 2,'),
 ('orchestrator.ts', 'gate === "cost-cap" ? "skipped-cost-cap" : "skipped-cost-unknown"', 'gate === "cost-cap" ? "skipped-cost-unknown" : "skipped-cost-cap"'),
 ('orchestrator.ts', 'if (gate !== "ok") return', 'if (false) return'),
 ('orchestrator.ts', 'if (isAborted(signal)) return keepFirst("skipped-aborted", trigger);', 'if (false) return keepFirst("skipped-aborted", trigger);'),
 ('orchestrator.ts', 'RANK[second.shown.status] > RANK[first.shown.status]', 'RANK[second.shown.status] >= RANK[first.shown.status]'),
 ('orchestrator.ts', 'second.ok && RANK[second.shown.status] > RANK[first.shown.status]', 'RANK[second.shown.status] > RANK[first.shown.status]'),
 ('orchestrator.ts', 'second === null ? unknownAccounting() : second.accounting', 'second === null ? first.accounting : second.accounting'),
 ('orchestrator.ts', 'return answerOf(second.shown, merged, ["REPAIRED"], done("adopted"));\n    return answerOf(first.shown, merged, ["REPAIR_FAILED"]', 'return answerOf(second.shown, merged, ["REPAIR_FAILED"], done("adopted"));\n    return answerOf(first.shown, merged, ["REPAIR_FAILED"]'),
 ('orchestrator.ts', 'done(second !== null && second.ok ? "not-improved" : "failed")', 'done(second !== null && second.ok ? "failed" : "not-improved")'),
 ('orchestrator.ts', 'return answerOf(first.shown, merged, ["REPAIR_FAILED"]', 'return answerOf(first.shown, merged, []'),
 ('orchestrator.ts', '  if (second !== null && second.ok) return answerOf(second.shown, merged, ["REPAIRED"], done("adopted"));\n  const source', '  if (false) return answerOf(second.shown, merged, ["REPAIRED"], done("adopted"));\n  const source'),
 ('orchestrator.ts', 'second.failure.error.code === "ABORTED" ? second.failure : first.failure', 'first.failure'),
 ('orchestrator.ts', 'second.failure.error.code === "ABORTED" ? second.failure : first.failure', 'second.failure'),
 ('orchestrator.ts', 'return { ok: false, error: { ...source.error, accounting: merged } };', 'return { ok: false, error: { ...source.error, accounting: first.accounting } };'),
 ('orchestrator.ts', 'promptVersion: attempts === 2 ? REPAIR_PROMPT_VERSION : null', 'promptVersion: attempts >= 1 ? REPAIR_PROMPT_VERSION : null'),
 ('orchestrator.ts', 'repairOf("not-needed", null, 0)', 'repairOf("not-needed", null, 1)'),
 ('orchestrator.ts', 'repairOf(outcome, trigger, 1)) : first.failure', 'repairOf(outcome, trigger, 2)) : first.failure'),
 ('orchestrator.ts', 'repairOf(outcome, trigger, 2);', 'repairOf(outcome, trigger, 1);'),
 ('orchestrator.ts', 'const rejections = first.ok ? first.shown.rejections : [];', 'const rejections: never[] = [];'),
 ('orchestrator.ts', 'buildRepairPrompt(req.question, context.text, trigger, rejections)', 'buildRepairPrompt(req.question, "", trigger, rejections)'),
 ('orchestrator.ts', 'const merged = mergeAccounting(first.accounting,', 'const merged = mergeAccounting(unknownAccounting(),'),
 ('orchestrator.ts', 'e.code === "ABORTED") return { ok: false, failure: fail("ABORTED", { accounting })', 'e.code === "ABORTED") return { ok: false, failure: fail("GENERATION_FAILED", { accounting })'),
]
lo = int(sys.argv[1]) if len(sys.argv) > 1 else 1
hi = int(sys.argv[2]) if len(sys.argv) > 2 else len(M)
survived, killed = [], 0
for i, (f, old, new) in enumerate(M, 1):
    if i < lo or i > hi:
        continue
    path = D + f
    src = open(path, encoding='utf-8').read()
    if old not in src:
        print(f'#{i} {f}: متن اصلی پیدا نشد؛ فهرست جهش‌ها باید به‌روز شود: {old[:70]!r}'); sys.exit(2)
    try:
        open(path, 'w', encoding='utf-8').write(src.replace(old, new, 1))
        r = subprocess.run(['node_modules/.bin/vitest', 'run', *TESTS], cwd=ROOT, capture_output=True, text=True, timeout=300)
        red = r.returncode != 0
    except subprocess.TimeoutExpired:
        red = True  # گیرکردن هم «کشته شدن» است
    finally:
        open(path, 'w', encoding='utf-8').write(src)
    if red:
        killed += 1
        print(f'#{i} KILLED   {f}: {old[:60]!r}')
    else:
        survived.append(i)
        print(f'#{i} SURVIVED {f}: {old[:60]!r} → {new[:60]!r}')
print(f'\nکشته: {killed} · زنده: {len(survived)} {survived}')
sys.exit(1 if survived else 0)
