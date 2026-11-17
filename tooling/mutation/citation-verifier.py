"""
آزمون جهشی دستی برای citation-verifier: هر جهش را اعمال می‌کند، تست‌های ماژول را اجرا می‌کند و فایل را برمی‌گرداند.
هر جهش باید «KILLED» شود (تست قرمز). «SURVIVED» = تست ضعیف یا کد مرده/هم‌ارز. فقط Python 3 استاندارد؛ جزو CI نیست.
نیاز: Node ≥ 22. (ماژول خالص است؛ پایگاه لازم نیست.)
اجرا: python3 tooling/mutation/citation-verifier.py          (همه)
      python3 tooling/mutation/citation-verifier.py 3 9      (فقط جهش‌های ۳ تا ۹)
هر جهش یک بار (و فقط نخستین رخداد) اعمال می‌شود؛ اگر متن اصلی پیدا نشود اجرا متوقف می‌شود (کد عوض شده و فهرست باید به‌روز شود).
"""
import subprocess, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
D = os.path.join(ROOT, 'src/modules/citation-verifier') + '/'
TESTS = ['src/modules/citation-verifier']
# (عمداً نیامده — جهش‌های هم‌ارز: «accepted: found.verified || true» در شاخهٔ valid، چون valid یعنی verified؛ و حذف بررسی نوع `article` در shapeProblem،
#  چون resolveCitation همان را با canonicalArticleLabel رد می‌کند و حکم همچنان malformed است — لایهٔ دفاعی دوم.)
M = [
 # verify.ts — پذیرش
 ('verify.ts', 'accepted: allowed,', 'accepted: true,'),
 ('verify.ts', 'const allowed = policy.allowUnverified === true;', 'const allowed = policy.allowUnverified !== false;'),
 ('verify.ts', 'if (!found.verified) {', 'if (found.verified) {'),
 ('verify.ts', 'if (!q.ok) return reject("quote-mismatch"', 'if (q.ok) return reject("quote-mismatch"'),
 ('verify.ts', 'if (claim.quote !== undefined && claim.quote !== null) {', 'if (claim.quote) {'),
 ('verify.ts', 'const texts = found.subpart !== null ? [found.subpart.text] : [found.version.text, ...found.version.subparts.map((s) => s.text)];', 'const texts = [found.version.text, ...found.version.subparts.map((s) => s.text)];'),
 ('verify.ts', 'const texts = found.subpart !== null ? [found.subpart.text] : [found.version.text, ...found.version.subparts.map((s) => s.text)];', 'const texts = found.subpart !== null ? [found.subpart.text] : [found.version.text];'),
 ('verify.ts', 'const ref = { ...claim.ref, subpart: claim.ref.subpart ?? null };', 'const ref = claim.ref;'),
 ('verify.ts', 'if (problem !== null) return reject("malformed", claim, problem);', ''),
 ('verify.ts', 'if (!r.ok) return reject("malformed", claim, r.error.message);', 'if (!r.ok) return reject("unknown-article", claim, r.error.message);'),
 ('verify.ts', 'case "gap":\n      return reject("gap"', 'case "gap":\n      return reject("no-longer-in-force"'),
 ('verify.ts', 'verified: found.verified,\n      };', 'verified: true,\n      };'),
 ('verify.ts', 'if (typeof ref["documentId"] !== "string" || ref["documentId"] === "")', 'if (typeof ref["documentId"] !== "string")'),
 ('verify.ts', 'allAccepted: rejected.length === 0', 'allAccepted: accepted.length > 0'),
 ('verify.ts', 'const rejected = verdicts.filter((v) => !v.accepted);', 'const rejected = verdicts.filter((v) => v.code !== "valid" && !v.accepted && v.code !== "unverified-source");'),
 # tokens.ts — نقل‌قول و واژه‌بندی
 ('tokens.ts', 'export const MIN_QUOTE_CHARS = 8;', 'export const MIN_QUOTE_CHARS = 1;'),
 ('tokens.ts', 'if (chars < MIN_QUOTE_CHARS)', 'if (chars < 0)'),
 ('tokens.ts', 'if (hay[i + j] !== needle[j]) continue outer;', 'if (hay[i + j] !== needle[j] && j === 0) continue outer;'),
 ('tokens.ts', 'from = at + f.length;', 'from = at;'),
 ('tokens.ts', 'if (all) return { ok: true };', 'if (true) return { ok: true };'),
 ('tokens.ts', 'else if (ch === "ي" || ch === "ى") out += "ی";', 'else if (ch === "ى") out += "ی";'),
 ('tokens.ts', 'else if (ch === "ك") out += "ک";', 'else if (false) out += "ک";'),
 ('tokens.ts', 'if (ch === "\\u0640" || MARK_RE.test(ch)) continue;', 'if (ch === "\\u0640") continue;'),
 ('tokens.ts', 'const LINK_GAP_RE = /^[\\s\\u200c\\u00a0()[\\]«»"\'\\-–—]*$/;', 'const LINK_GAP_RE = /^[\\s\\u200c\\u00a0()[\\]«»"\'\\-–—.،,;؛:]*$/;'),
 ('tokens.ts', 'if (folded === "") continue;', ''),
 ('tokens.ts', '.filter((f) => f.length > 0);', ''),
 # extract.ts — تشخیص ارجاع
 ('extract.ts', 'if (next === undefined || !linked(j, j + 1)) return { kind: "none" };', 'if (next === undefined) return { kind: "none" };'),
 ('extract.ts', 'if (alias.docIds.length === 1) return', 'if (alias.docIds.length >= 1) return'),
 ('extract.ts', 'b.tokens.length - a.tokens.length ||', 'a.tokens.length - b.tokens.length ||'),
 ('extract.ts', 'if (DOCUMENT_WORDS.has((at(p) as Token).folded)) return', 'if (false) return'),
 ('extract.ts', 'defaultDocumentId !== null\n      ? { status: "resolved"', 'true\n      ? { status: "resolved"'),
 ('extract.ts', 'if (at(p)?.folded === "از" && linked(last, p)) p += 1;', ''),
 ('extract.ts', 'if (next.folded === "واحده" && word === "ماده") raw = "واحده";', 'if (next.folded === "واحده") raw = "واحده";'),
 ('extract.ts', 'if (rep !== undefined && rep.folded === "مکرر" && linked(last, last + 1)) {', 'if (false) {'),
 ('extract.ts', 'const label = canonicalArticleLabel(raw);\n    return label.ok ? { kind: "article", last, label: label.value, problem: "" } : { kind: "article", last, label: null, problem: label.error.message };', 'return { kind: "article", last, label: raw, problem: "" };'),
 ('extract.ts', 'else if (!sub.ok) emit(i, art.last, "malformed", null, sub.error.message);', 'else if (false) emit(i, art.last, "malformed", null, "");'),
 ('extract.ts', 'if (prev !== undefined && i - 1 > consumed && SUBPART_WORDS[prev.folded] !== undefined && linked(i - 1, i)) {', 'if (false) {'),
 ('extract.ts', 'for (;;) {\n        const a = at(last + 1);', 'for (let guard = 0; guard < 0; guard++) {\n        const a = at(last + 1);'),
 ('extract.ts', 'while (open > 0 && guard-- > 0) {', 'while (false) {'),
 ('extract.ts', 'add(doc.title.replace(PARENS_RE, " "), doc.id);', ''),
 ('extract.ts', 'add(doc.shortTitle, doc.id);', ''),
 ('extract.ts', 'const SUBPART_WORDS: Readonly<Record<string, "note" | "clause">> = { تبصره: "note", بند: "clause" };', 'const SUBPART_WORDS: Readonly<Record<string, "note" | "clause">> = { تبصره: "clause", بند: "note" };'),
 ('extract.ts', 'consumed = Math.max(art.last, doc.end);\n      i = consumed + 1;', 'consumed = art.last;\n      i = consumed + 1;'),
 # guard.ts
 ('guard.ts', 'if (mention.status !== "resolved" || mention.claim === null) return { mention, verdict: null, accepted: false };', 'if (mention.claim === null) return { mention, verdict: null, accepted: mention.status !== "resolved" };'),
 ('guard.ts', 'text.slice(m.start, m.end) !== m.text', 'false'),
 ('guard.ts', 'm.end > limit ||', ''),
 ('guard.ts', '.sort((a, b) => b.start - a.start);', '.sort((a, b) => a.start - b.start);'),
 ('guard.ts', 'return { mentions: checked, rejected, ok: rejected.length === 0 };', 'return { mentions: checked, rejected, ok: true };'),
 ('guard.ts', 'export const DEFAULT_REDACTION = "[ارجاع نامعتبر حذف شد]";', 'export const DEFAULT_REDACTION = "[ماده ۱ قانون حذف شد]";'),
 ('guard.ts', 'const verdict = verifyCitation(index, mention.claim, onDate, options);', 'const verdict = verifyCitation(index, mention.claim, onDate, {});'),
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
