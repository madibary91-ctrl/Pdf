"""
آزمون جهشی دستی برای ai-orchestrator (برش ۱): هر جهش را اعمال می‌کند، تست‌های ماژول (و قرارداد با راستی‌آزمای واقعی روی
PostgreSQL) را اجرا می‌کند و فایل را برمی‌گرداند. هر جهش باید «KILLED» شود (تست قرمز). «SURVIVED» = تست ضعیف یا کد مرده/هم‌ارز.
فقط Python 3 استاندارد؛ جزو CI نیست.
نیاز: Node ≥ 22 و پایگاه آزمون (KB_TEST_DATABASE_URL یا DATABASE_URL)؛ بدون پایگاه تست‌های پایگاه رد می‌شوند و جهش‌های وابسته به آن زنده می‌مانند.
اجرا: python3 tooling/mutation/ai-orchestrator.py          (همه)
      python3 tooling/mutation/ai-orchestrator.py 3 9      (فقط جهش‌های ۳ تا ۹)
هر جهش یک بار (و فقط نخستین رخداد) اعمال می‌شود؛ اگر متن اصلی پیدا نشود اجرا متوقف می‌شود (کد عوض شده و فهرست باید به‌روز شود).
"""
import subprocess, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
D = os.path.join(ROOT, 'src/modules/ai-orchestrator') + '/'
TESTS = ['src/modules/ai-orchestrator', 'tooling/orchestrator-pipeline.test.ts']
# (عمداً نیامده — هم‌ارز یا زائد؛ دور نخست ۷ زنده بود: ۴ ضعفِ تست که **تقویت شدند** (ارقام عربی-هندی؛ هشدار RETRIEVAL_RELAXED؛
#  limits=undefined؛ report تک‌تلاشی ⇒ retried=false)، ۲ کدِ زائدِ هم‌ارز که **از کد حذف شدند** (`replace(/^\uFEFF/)` چون `trim` خودش BOM را برمی‌دارد؛
#  `split(REDACTION_MARK)` چون علامت رقم ندارد و آزموده می‌شود)، و ۱ جهشِ هم‌ارزِ مستند: حذف `typeof guard.text !== "string"` در ground.ts —
#  بدون آن `scanMarkers(guard.text)` روی غیررشته پرتاب می‌کند و همان `VERIFICATION_FAILED` می‌شود؛ بررسیِ صریح برای خوانایی قرارداد پورت مانده است.)
M = [
 # request.ts — مرز ورودی
 ('request.ts', 'if (!isRecord(input)) return fail("INVALID_INPUT", { issues: ["input"] });', 'if (false) return fail("INVALID_INPUT", { issues: ["input"] });'),
 ('request.ts', 'for (const k of Object.keys(input)) if (!KEYS.has(k))', 'for (const k of [] as string[]) if (!KEYS.has(k))'),
 ('request.ts', 'q.trim() === "" ||', 'false ||'),
 ('request.ts', 'q.length > MAX_QUESTION_CHARS ||', 'q.length > MAX_QUESTION_CHARS + 1 ||'),
 ('request.ts', r'q.includes("\u0000") ||', 'false ||'),
 ('request.ts', '|| hasLoneSurrogate(q)) issues.push("question")', '|| false) issues.push("question")'),
 ('request.ts', 'typeof asOf !== "string" || !isCalendarDate(asOf)', 'typeof asOf !== "string"'),
 ('request.ts', 'if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;', 'if (mo < 1 || mo > 12 || d < 1) return false;'),
 ('request.ts', '(y % 4 === 0 && y % 100 !== 0) || y % 400 === 0', 'y % 4 === 0'),
 ('request.ts', 'return d <= days;', 'return d < days;'),
 ('request.ts', 'maxOut < 1)', 'maxOut < 0)'),
 ('request.ts', 'c < MIN_CONTEXT_CHARS || c > MAX_CONTEXT_CHARS', 'c < MIN_CONTEXT_CHARS - 1 || c > MAX_CONTEXT_CHARS'),
 ('request.ts', 'Object.keys(r).some((k) => !RETRIEVAL_KEYS.has(k)) ||', 'false ||'),
 ('request.ts', '!parseRetrievalRequest({ question: "x", asOf: "2000-01-01", ...r }).ok', 'false'),
 ('request.ts', '!REQUEST_ID_RE.test(id)', 'false'),
 ('request.ts', 't < 1 || t > REQUEST_LIMITS.maxTimeoutMs', 't < 1 || t > REQUEST_LIMITS.maxTimeoutMs + 1'),
 ('request.ts', 'let contextMaxChars: number = DEFAULT_CONTEXT_CHARS;', 'let contextMaxChars: number = 5000;'),
 ('request.ts', 'model.length > REQUEST_LIMITS.maxModelChars', 'model.length > REQUEST_LIMITS.maxModelChars + 1'),
 ('request.ts', 'd.length > REQUEST_LIMITS.maxDocumentIdChars', 'd.length > REQUEST_LIMITS.maxDocumentIdChars + 1'),
 ('request.ts', 'if (n >= 0xdc00 && n <= 0xdfff) i++;', 'if (false) i++;'),
 # prompt.ts — داده است نه دستور
 ('prompt.ts', '(?=\\\\s*/?\\\\s*(?:sources?|question)\\\\b)', '(?=/?(?:sources?|question)\\\\b)'),
 ('prompt.ts', '"gi"), "\\u2039"', '"g"), "\\u2039"'),
 ('prompt.ts', '${neutralizeFences(contextText)}', '${contextText}'),
 ('prompt.ts', '${neutralizeFences(question)}', '${question}'),
 ('prompt.ts', 'chars: SYSTEM_PROMPT.length + user.length', 'chars: user.length'),
 # model-output.ts — تحلیل سخت‌گیر
 ('model-output.ts', 'if (raw.length > OUTPUT_LIMITS.maxRawChars) return bad("too-large");', 'if (raw.length > OUTPUT_LIMITS.maxRawChars + 1) return bad("too-large");'),
 ('model-output.ts', 'if (m === null) return bad("bad-fence");', 'if (m === null) return bad("not-json");'),
 ('model-output.ts', 'json === null || Array.isArray(json)) return bad("not-object");', 'json === null) return bad("not-object");'),
 ('model-output.ts', 'insRaw !== undefined && typeof insRaw !== "boolean"', 'false'),
 ('model-output.ts', 'citRaw.length > OUTPUT_LIMITS.maxCitations', 'citRaw.length >= OUTPUT_LIMITS.maxCitations'),
 ('model-output.ts', 'source.length > OUTPUT_LIMITS.maxSourceIdChars', 'source.length >= OUTPUT_LIMITS.maxSourceIdChars'),
 ('model-output.ts', 'q.length > OUTPUT_LIMITS.maxQuoteChars', 'q.length >= OUTPUT_LIMITS.maxQuoteChars'),
 ('model-output.ts', 'quote = q.trim() === "" ? null : q;', 'quote = q;'),
 ('model-output.ts', 'answer.length > OUTPUT_LIMITS.maxAnswerChars', 'answer.length >= OUTPUT_LIMITS.maxAnswerChars'),
 ('model-output.ts', 'typeof answer !== "string" || answer.trim() === ""', 'typeof answer !== "string"'),
 ('model-output.ts', 'const extraFields = Object.keys(rec).some((k) => !KNOWN.has(k));', 'const extraFields = false;'),
 # markers.ts
 ('markers.ts', '/^\\[S([1-9][0-9]{0,2})(?:', '/^\\[S([1-9][0-9]{0,3})(?:'),
 ('markers.ts', '[,\\u060C]', '[,]'),
 ('markers.ts', 'const kept = m.ids.filter((id) => accepted.has(id));', 'const kept = m.ids.filter((id) => accepted.has(id) || id.length > 0);'),
 ('markers.ts', 'if (kept.length === m.ids.length) out += m.raw;', 'if (false) out += m.raw;'),
 ('markers.ts', 'if (m.ids === null) out += mark;', 'if (false) out += mark;'),
 ('markers.ts', 'ids = [...new Set([...raw', 'ids = [...([...raw'),
 # numbers.ts
 ('numbers.ts', '.replace(/\\u066B/g, ".")', ''),
 ('numbers.ts', 't = t.replace(/^[ \\t]*[0-9]{1,2}[.)\\-:][ \\t]/gm, " ");', ''),
 ('numbers.ts', '(?=[0-9]{3}(?![0-9]))', '(?=[0-9]{3})'),
 ('numbers.ts', '.replace(markerCandidate(), " ")', ''),
 ('numbers.ts', '.filter((n) => !allowed.has(n))', '.filter((n) => allowed.has(n))'),
 ('numbers.ts', 'out += ar >= 0 ? String(ar) : ch;', 'out += ch;'),
 # ground.ts — مستندسازی
 ('ground.ts', 'if (policy.requireQuotes && quote === null) {', 'if (false && quote === null) {'),
 ('ground.ts', '|| verdicts.length !== claims.length) throw', ') throw'),
 ('ground.ts', 'v.accepted === true && v.code === "valid"', 'v.accepted === true'),
 ('ground.ts', 'new Set(used.filter((id) => !bad.has(id)))', 'new Set(used)'),
 ('ground.ts', 'marker: REDACTION_MARK }', 'marker: "X" }'),
 ('ground.ts', 'defaultDocumentId: input.defaultDocumentId, marker', 'defaultDocumentId: null, marker'),
 ('ground.ts', 'const finalText = rewriteMarkers(guard.text, scanMarkers(guard.text), accepted);', 'const finalText = guard.text;'),
 ('ground.ts', 'if (citations.length === 0) withheldReason = "no-valid-citation";', 'if (false) withheldReason = "no-valid-citation";'),
 ('ground.ts', 'policy.onRejectedCitation === "withhold") withheldReason', 'policy.onRejectedCitation === "redact") withheldReason'),
 ('ground.ts', 'status: finalText === output.answer ? "answered" : "answered-redacted",', 'status: "answered",'),
 ('ground.ts', 'if (unsupportedNumbers.length > 0) warn("UNSUPPORTED_NUMBERS");', ''),
 ('ground.ts', '[...context.sources.map((s) => s.body), input.question]', '[...context.sources.map((s) => s.body)]'),
 ('ground.ts', '(/^S[0-9]{1,3}$/.test(id) ? id : null)', 'id'),
 ('ground.ts', 'for (const quote of listed.get(id) ?? [null])', 'for (const quote of listed.get(id) ?? [])'),
 ('ground.ts', 'if (!l.includes(q)) l.push(q);', 'l.push(q);'),
 ('ground.ts', 's.header.replace(/^\\[S[0-9]+\\]\\s*/, "")', 's.header'),
 ('ground.ts', 'if (allIds.some((id) => !used.includes(id) && sources.has(id) && !bad.has(id))) warn("UNMARKED_CITATION");', ''),
 ('ground.ts', 'const allIds = [...used, ...[...listed.keys()].filter((id) => !used.includes(id))];', 'const allIds = [...used];'),
 ('ground.ts', 'for (const r of guard.rejected) reject(', 'for (const r of [] as typeof guard.rejected) reject('),
 ('ground.ts', 'for (const m of markers) if (m.ids === null) reject("marker", null, "malformed-marker");', ''),
 # errors.ts
 ('errors.ts', '{0,39}$/.test(code)', '{0,5}$/.test(code)'),
 ('errors.ts', 'Object.prototype.hasOwnProperty.call(REJECTION_MESSAGES, code) ?', 'code in REJECTION_MESSAGES ?'),
 ('errors.ts', 'RETRIEVAL_FAILED: { message: "بازیابی از پایگاه دانش شکست خورد.", retryable: true }', 'RETRIEVAL_FAILED: { message: "بازیابی از پایگاه دانش شکست خورد.", retryable: false }'),
 ('errors.ts', 'VERIFIER_UNAVAILABLE: { message: "راستی‌آزمایی استناد در دسترس نیست؛ بدون آن پاسخی داده نمی‌شود.", retryable: true }', 'VERIFIER_UNAVAILABLE: { message: "راستی‌آزمایی استناد در دسترس نیست؛ بدون آن پاسخی داده نمی‌شود.", retryable: false }'),
 # orchestrator.ts — ترتیب و پورت‌ها
 ('orchestrator.ts', 'verifiedOnly: true,', 'verifiedOnly: false,'),
 ('orchestrator.ts', 'if (req.maxOutputTokens > limits.maxOutputTokens)', 'if (req.maxOutputTokens >= limits.maxOutputTokens)'),
 ('orchestrator.ts', 'if (budget < MIN_CONTEXT_CHARS)', 'if (budget <= MIN_CONTEXT_CHARS)'),
 ('orchestrator.ts', 'Math.min(req.contextMaxChars, limits.maxInputChars - fixedChars)', 'Math.max(req.contextMaxChars, limits.maxInputChars - fixedChars)'),
 ('orchestrator.ts', 'if (context.sources.length === 0) {', 'if (false) {'),
 ('orchestrator.ts', 'temperature: 0,', 'temperature: 0.2,'),
 ('orchestrator.ts', 'if (completion.finishReason !== "stop")', 'if (false)'),
 ('orchestrator.ts', 'if (out.value.insufficient) {', 'if (false) {'),
 ('orchestrator.ts', 'if (e.code === "ABORTED") return fail("ABORTED", { accounting });', ''),
 ('orchestrator.ts', 'retryable: e.retryable === true,', 'retryable: true,'),
 ('orchestrator.ts', 'if (isAborted(signal)) return fail("ABORTED");\n\n  // ۱)', 'if (false) return fail("ABORTED");\n\n  // ۱)'),
 ('orchestrator.ts', 'return fail("VERIFIER_UNAVAILABLE");\n  if (isAborted(signal)) return fail("ABORTED");', 'return fail("VERIFIER_UNAVAILABLE");'),
 ('orchestrator.ts', 'accounting: held.accounting ?? unknownAccounting()', 'accounting: null'),
 ('orchestrator.ts', '...(req.requestId === null ? {} : { requestId: req.requestId }),', 'requestId: req.requestId,'),
 ('orchestrator.ts', '...(req.timeoutMs === null ? {} : { timeoutMs: req.timeoutMs }),', ''),
 ('orchestrator.ts', 'if (retrieval.incomplete) warnings.push("RETRIEVAL_INCOMPLETE");', ''),
 ('orchestrator.ts', 'if (retrieval.relaxed) warnings.push("RETRIEVAL_RELAXED");', ''),
 ('orchestrator.ts', 'if (context.omitted > 0) warnings.push("CONTEXT_OMITTED");', ''),
 ('orchestrator.ts', 'if (context.sources.some((s) => s.truncated)) warnings.push("CONTEXT_TRUNCATED");', ''),
 ('orchestrator.ts', 'if (out.value.fenced) warnings.push("MODEL_OUTPUT_FENCED");', ''),
 ('orchestrator.ts', 'if (out.value.extraFields) warnings.push("MODEL_OUTPUT_EXTRA_FIELDS");', ''),
 ('orchestrator.ts', 'if (e.code === "STORE_ERROR") return fail("RETRIEVAL_FAILED", { retrievalCode: e.code });', ''),
 ('orchestrator.ts', 'e.code === "EMPTY_QUERY" ? "question" : "retrieval"', '"retrieval"'),
 ('orchestrator.ts', '...(req.documentId === null ? {} : { documentId: req.documentId }),', ''),
 ('orchestrator.ts', '    ...req.retrieval,\n', ''),
 ('orchestrator.ts', 'defaultDocumentId: req.documentId })', 'defaultDocumentId: null })'),
 ('orchestrator.ts', 'typeof session.guardText !== "function") return fail("VERIFIER_UNAVAILABLE");', 'typeof session.guardText !== "function") return fail("INTERNAL_ERROR");'),
 ('orchestrator.ts', 'typeof session !== "object" || session === null || typeof session.verifyClaims !== "function" || typeof session.guardText !== "function"', 'false'),
 ('orchestrator.ts', 'typeof (s as AbortSignal).addEventListener === "function"', 'true'),
 ('orchestrator.ts', 'if (isAborted(signal)) return fail("ABORTED");\n\n  // ۱)', 'if (false) return fail("ABORTED");\n\n  // ۱)'),
 ('orchestrator.ts', 'if (limits === null || limits === undefined) return fail("UNKNOWN_MODEL");', 'if (limits === null) return fail("UNKNOWN_MODEL");'),
 ('orchestrator.ts', 'typeof limits.maxInputChars !== "number" || typeof limits.maxOutputTokens !== "number"', 'false'),
 # config.ts
 ('config.ts', ' || !hasFn(gateway, "limits")', ''),
 ('config.ts', 'typeof policy["requireQuotes"] === "boolean"', 'true'),
 ('config.ts', 'for (const k of Object.keys(policy)) if (!POLICY_KEYS.has(k))', 'for (const k of [] as string[]) if (!POLICY_KEYS.has(k))'),
 ('config.ts', 'limits: g.limits.bind(g)', 'limits: (m: string) => g.limits(m)'),
 ('config.ts', 'policy: Object.freeze({ onRejectedCitation: onRejected, requireQuotes })', 'policy: config["policy"] as AnswerPolicy'),
 # accounting.ts
 ('accounting.ts', 'providerCalls: 1, spend: [], costUnknownCalls: 1,', 'providerCalls: 1, spend: [], costUnknownCalls: 0,'),
 ('accounting.ts', 'fellBack: reached.some((a) => a["model"] !== requested),', 'fellBack: attempts.some((a) => a["model"] !== requested),'),
 ('accounting.ts', 'providerCalls: reached.length,', 'providerCalls: attempts.length,'),
 ('accounting.ts', 'a["modelAttempt"] > 1', 'a["modelAttempt"] >= 1'),
 ('accounting.ts', ' || typeof r["costUnknownAttempts"] !== "number") return null;', ') return null;'),
 ('accounting.ts', 'return fromReport(error) ?? unknownAccounting();', 'return unknownAccounting();'),
 # checker.ts (آداپتور واقعی)
 ('checker.ts', '{ allowUnverified: false },\n          );', '{ allowUnverified: true },\n          );'),
 ('checker.ts', 'asOf as IsoDate, { allowUnverified: false, defaultDocumentId', 'asOf as IsoDate, { allowUnverified: true, defaultDocumentId'),
 ('checker.ts', 'defaultDocumentId: options.defaultDocumentId }', 'defaultDocumentId: null }'),
 ('checker.ts', 'redactRejected(text, check, options.marker)', 'redactRejected(text, check)'),
 ('checker.ts', 'r.verdict === null ? r.mention.status : r.verdict.code', 'r.mention.status'),
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
        print(f'#{i} {f}: متن اصلی پیدا نشد؛ فهرست جهش‌ها باید به‌روز شود'); sys.exit(2)
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
        print(f'#{i} SURVIVED {f}: {old[:60]!r}')
print(f'\nکشته: {killed} · زنده: {len(survived)} {survived}')
sys.exit(1 if survived else 0)
