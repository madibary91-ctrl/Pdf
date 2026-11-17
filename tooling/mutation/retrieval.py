"""
آزمون جهشی دستی برای retrieval: هر جهش را اعمال می‌کند، تست‌های ماژول (و قرارداد retrieval→citation-verifier) را اجرا می‌کند و فایل را برمی‌گرداند.
هر جهش باید «KILLED» شود (تست قرمز). «SURVIVED» = تست ضعیف یا کد مرده/هم‌ارز. فقط Python 3 استاندارد؛ جزو CI نیست.
نیاز: Node ≥ 22 و پایگاه آزمون (KB_TEST_DATABASE_URL یا DATABASE_URL)؛ بدون پایگاه تست‌های پایگاه رد می‌شوند و جهش‌های پایگاه‌محور زنده می‌مانند.
اجرا: python3 tooling/mutation/retrieval.py          (همه)
      python3 tooling/mutation/retrieval.py 3 9      (فقط جهش‌های ۳ تا ۹)
هر جهش یک بار (و فقط نخستین رخداد) اعمال می‌شود؛ اگر متن اصلی پیدا نشود اجرا متوقف می‌شود (کد عوض شده و فهرست باید به‌روز شود).
"""
import subprocess, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
D = os.path.join(ROOT, 'src/modules/retrieval') + '/'
TESTS = ['src/modules/retrieval', 'tooling/retrieval-verifier-pipeline.test.ts']
# (عمداً نیامده — جهش‌های هم‌ارز: «if (!merged.has(key)) merged.set(key, p)» ⇒ «merged.set(key, p)»، چون دو بار دیدنِ یک نسخه همان بند را می‌سازد؛
#  و «S${sources.length + 1}» ⇒ «S${i + 1}»، چون هر دور یا منبعی می‌افزاید یا حلقه را می‌شکند، پس i === sources.length است.)
M = [
 # retrieve.ts — پیش‌فرض‌های ایمن و عبور بی‌تغییر فیلترها
 ('retrieve.ts', 'rec["verifiedOnly"] === undefined ? true : rec["verifiedOnly"]', 'rec["verifiedOnly"] === undefined ? false : rec["verifiedOnly"]'),
 ('retrieve.ts', 'verifiedOnly: req.verifiedOnly,\n      limit: req.limit,', 'verifiedOnly: false,\n      limit: req.limit,'),
 ('retrieve.ts', 'asOf: req.asOf,\n      verifiedOnly: req.verifiedOnly,\n      limit', 'asOf: "2024-01-01",\n      verifiedOnly: req.verifiedOnly,\n      limit'),
 ('retrieve.ts', '...(req.documentId === null ? {} : { documentId: req.documentId }),', ''),
 ('retrieve.ts', 'for (const k of Object.keys(rec)) if (!KEYS.has(k))', 'for (const k of []) if (!KEYS.has(k as string))'),
 ('retrieve.ts', 'if (typeof rec["asOf"] !== "string") return bad(', 'if (false) return bad('),
 ('retrieve.ts', 'v < lo || v > hi)', 'v < lo || v > hi + 1)'),
 ('retrieve.ts', 'mc <= 0 || mc > 1)', 'mc < 0 || mc > 1)'),
 # آرام‌سازی و ایستادن
 ('retrieve.ts', 'if (merged.size >= req.limit) {\n        stoppedEarly = true;', 'if (merged.size > req.limit) {\n        stoppedEarly = true;'),
 ('retrieve.ts', 'if (variant.length < level) {', 'if (false) {'),
 ('retrieve.ts', 'budgetExhausted: !stoppedEarly && !complete,', 'budgetExhausted: !complete,'),
 ('retrieve.ts', 'relaxed: queriesRun > 1,', 'relaxed: false,'),
 ('retrieve.ts', 'staleSkipped = Math.max(staleSkipped, res.value.staleSkipped);', ''),
 ('retrieve.ts', 'incomplete: staleSkipped > 0,', 'incomplete: false,'),
 ('retrieve.ts', 'hasMore: all.length > req.limit || storeHasMore,', 'hasMore: all.length > req.limit,'),
 ('retrieve.ts', 'passages: all.slice(0, req.limit),', 'passages: all,'),
 ('retrieve.ts', 'if (!res.ok) return { ok: false, error: { code: "STORE_ERROR", message: res.error.message, storeCode: res.error.code } };', 'if (!res.ok) continue;'),
 ('retrieve.ts', 'catch {\n      return { ok: false, error: { code: "STORE_ERROR", message: "جست‌وجو در پایگاه دانش با خطای پیش‌بینی‌نشده شکست خورد." } };', 'catch (e) {\n      return { ok: false, error: { code: "STORE_ERROR", message: String(e) } };'),
 # پوشش و امتیاز
 ('retrieve.ts', 'coverage: terms.length === 0 ? 0 : matchedTerms.length / terms.length,', 'coverage: 1,'),
 ('retrieve.ts', '...hit.subparts.map((s) => s.text)', ''),
 ('retrieve.ts', 'score += c;', 'score += 1;'),
 # query.ts
 ('query.ts', 'else if (STOP.has(t)) stopwords.push(t);', 'else if (false) stopwords.push(t);'),
 ('query.ts', 'if (seen.has(t)) continue;', ''),
 ('query.ts', 'if (t.length > SEARCH_LIMITS.maxTokenChars) unsearchable.push(t);', 'if (false) unsearchable.push(t);'),
 ('query.ts', '.sort((a, b) => b.t.length - a.t.length || a.i - b.i)', '.sort((a, b) => a.t.length - b.t.length || a.i - b.i)'),
 ('query.ts', 'if (question.length > MAX_QUESTION_CHARS)', 'if (question.length > MAX_QUESTION_CHARS + 1)'),
 ('query.ts', 'if (content.length === 0) {', 'if (content.length < 0) {'),
 ('query.ts', 'Math.ceil(n * minCoverage - 1e-9)', 'Math.floor(n * minCoverage)'),
 ('query.ts', '.sort((a, b) => a.weight - b.weight || compareLex(a.dropped, b.dropped));', '.sort((a, b) => b.weight - a.weight || compareLex(a.dropped, b.dropped));'),
 ('query.ts', 'return { variants, complete: total <= cap };', 'return { variants, complete: true };'),
 ('query.ts', 'if (variants.length < cap) {', 'if (variants.length <= cap) {'),
 # rank.ts
 ('rank.ts', 'b.matchedTerms.length - a.matchedTerms.length ||\n    b.score - a.score ||', 'b.score - a.score ||\n    b.matchedTerms.length - a.matchedTerms.length ||'),
 ('rank.ts', 'if (na !== nb) return na - nb;', 'if (na !== nb) return nb - na;'),
 ('rank.ts', 'const ra = a.includes("مکرر") ? 1 + Number(ma[2] ?? 0) : 0;', 'const ra = 0;'),
 # context.ts
 ('context.ts', 'const eligible = passages.filter((p) => allowUnverified || p.verified);', 'const eligible = passages;'),
 ('context.ts', 'const allowUnverified = options.allowUnverified === true;', 'const allowUnverified = options.allowUnverified !== false;'),
 ('context.ts', 'if (used + cost <= maxChars) {', 'if (used + cost < maxChars) {'),
 ('context.ts', 'if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);', ''),
 ('context.ts', 'omitted = eligible.length - i - 1;\n        break;', 'omitted = 0;\n        break;'),
 ('context.ts', 'return context.sources.find((s) => s.id === id) ?? null;', 'return context.sources.find((s) => s.id.toLowerCase() === String(id).toLowerCase()) ?? context.sources[0] ?? null;'),
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
    else:
        survived.append(i)
    print(f'#{i:02d} {f:12s} {"KILLED" if red else "SURVIVED"}  {old[:60]!r}', flush=True)
print(f'\nکشته: {killed}  زنده: {len(survived)} {survived}')
sys.exit(1 if survived else 0)
