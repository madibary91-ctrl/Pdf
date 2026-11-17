"""
آزمون جهشی دستی برای جست‌وجوی کلمه‌ای (بخش ۴ب‑۳): هر جهش را اعمال می‌کند، تست‌های جست‌وجو را اجرا می‌کند و فایل را برمی‌گرداند.
هر جهش باید «KILLED» شود (تست قرمز). «SURVIVED» = تست ضعیف یا کد مرده/هم‌ارز. فقط Python 3 استاندارد؛ جزو CI نیست.
نیاز: پایگاه آزمون (DATABASE_URL یا KB_TEST_DATABASE_URL) و Node ≥ 22.
اجرا: python3 tooling/mutation/legal-kb-store-search.py          (همه)
      python3 tooling/mutation/legal-kb-store-search.py 3 9      (فقط جهش‌های ۳ تا ۹)
هر جهش یک بار (و فقط نخستین رخداد) اعمال می‌شود؛ اگر متن اصلی پیدا نشود اجرا متوقف می‌شود (کد عوض شده و فهرست باید به‌روز شود).
"""
import subprocess, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
D = os.path.join(ROOT, 'src/modules/legal-kb-store') + '/'
TESTS = ['src/modules/legal-kb-store/search.test.ts', 'src/modules/legal-kb-store/search-text.test.ts']
M = [
 # search.ts — معنای پرس‌وجو
 ('search.ts', 'AND v.valid_during @> ${q.asOf}::date', 'AND TRUE'),
 ('search.ts', "(${q.verifiedOnly}::boolean = false OR v.review_status = 'legally-verified')", '(TRUE)'),
 ('search.ts', 'ORDER BY matches DESC, d.seq, a.article_number, a.article_repeat', 'ORDER BY matches DESC, d.seq, a.label'),
 ('search.ts', 'ORDER BY matches DESC, d.seq', 'ORDER BY matches ASC, d.seq'),
 ('search.ts', 'ORDER BY matches DESC, d.seq, a.article_number, a.article_repeat', 'ORDER BY matches DESC, a.article_number, a.article_repeat'),
 ('search.ts', 'LIMIT ${q.limit + 1}', 'LIMIT ${q.limit}'),
 ('search.ts', 'WHERE x.tokens @> ${tokenArray}', 'WHERE x.tokens && ${tokenArray}'),
 ('search.ts', '(${q.documentId}::text IS NULL OR v.document_id = ${q.documentId}::text)', '(TRUE)'),
 ('search.ts', 'JOIN ${tableRef(schema, "article")} a ON a.document_id = v.document_id AND a.label = v.article_label', 'JOIN ${tableRef(schema, "article")} a ON a.document_id = v.document_id AND a.label = v.article_label AND FALSE'),
 # search.ts — مثبتِ کاذب و کهنگی
 ('search.ts', 'actual.contentHash !== str(r, "indexed_hash") ||', 'false ||'),
 ('search.ts', 'fp !== str(r, "indexed_fp") ||', 'false ||'),
 ('search.ts', '|| truth !== int(r, "matches")', '|| false'),
 ('search.ts', '          staleSkipped++;\n          continue;', '          continue;'),
 ('search.ts', 'verified: provenance.review.status === "legally-verified",', 'verified: true,'),
 ('search.ts', 'matches: truth,', 'matches: int(r, "matches") + 1,'),
 # search.ts — نمایه‌سازی و سلامت
 ('search.ts', 'if (v.indexedHash === row.contentHash && v.indexedFp === fp) {', 'if (v.indexedHash === row.contentHash) {'),
 ('search.ts', 'if (v.indexedHash === null) indexed++;\n          else updated++;', 'indexed++;'),
 ('search.ts', "await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legal-kb-store:search-reindex:${schema}`}, 0))`);", ''),
 ('search.ts', "(v.document_id, v.article_label, v.valid_from) > (${cursor.documentId}", "(v.document_id, v.article_label, v.valid_from) >= (${cursor.documentId}"),
 ('search.ts', 'if (v.indexedHash !== row.contentHash || v.indexedFp !== fp) stale++;', 'if (v.indexedHash !== row.contentHash) stale++;'),
 ('search.ts', 'upToDate: missing === 0 && stale === 0 && orphans === 0,', 'upToDate: missing === 0 && stale === 0,'),
# (عمداً نیامده: نگهبان «شمار ردیفِ نوشته‌شده» در reindexSearch ناممکن است؛ upsert همیشه دقیقاً به شمار ردیف‌ها برمی‌گرداند — جهشِ هم‌ارز)
 ('search.ts', 'ON CONFLICT (document_id, article_label, valid_from) DO UPDATE\n              SET content_hash = EXCLUDED.content_hash, key_fingerprint = EXCLUDED.key_fingerprint, tokens = EXCLUDED.tokens, indexed_at = now()', 'ON CONFLICT (document_id, article_label, valid_from) DO NOTHING'),
 ('search.ts', 'ORDER BY s.ordinal)', 'ORDER BY s.label)'),
 # search-text.ts
 ('search-text.ts', 'const tokens = [...new Set(all)];', 'const tokens = all;'),
 ('search-text.ts', 'maxQueryTokens: 12,', 'maxQueryTokens: 13,'),
 ('search-text.ts', 'limit > SEARCH_LIMITS.maxLimit', 'limit > SEARCH_LIMITS.maxLimit + 1'),
 ('search-text.ts', 'for (const k of Object.keys(rec)) if (!KEYS.has(k)) return', 'for (const k of Object.keys(rec)) if (false) return'),
 ('search-text.ts', 'rec["verifiedOnly"] === undefined ? true :', 'rec["verifiedOnly"] === undefined ? false :'),
 ('search-text.ts', 't.length <= SEARCH_LIMITS.maxTokenChars);\n}', 't.length < SEARCH_LIMITS.maxTokenChars);\n}'),
 ('search-text.ts', '[content.text, ...content.subparts.map((s) => s.text)].join("\\n")', '[content.text].join("\\n")'),
 ('search-text.ts', 'return present.size === set.size ? score : null;', 'return present.size > 0 ? score : null;'),
 ('search-text.ts', 'if (rec["text"].length > SEARCH_LIMITS.maxQueryChars)', 'if (rec["text"].length > SEARCH_LIMITS.maxQueryChars * 2)'),
 ('search-text.ts', 'if (typeof rec["asOf"] !== "string") return bad(', 'if (false) return bad('),
 ('search-text.ts', 'const long = all.find((t) => t.length > SEARCH_LIMITS.maxTokenChars);', 'const long = undefined as string | undefined;'),
 # search-migrate.ts / naming.ts
 ('search-migrate.ts', 'if (status.pending.length > 0) {\n    throw new StoreAbort({ code: "NOT_MIGRATED", message: `مهاجرت معلقِ', 'if (false) {\n    throw new StoreAbort({ code: "NOT_MIGRATED", message: `مهاجرت معلقِ'),
 ('search-migrate.ts', "await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${\"legal-kb-store:search-migrate\"}, 0))`);", ''),
 ('naming.ts', 'if (value.endsWith(SEARCH_SUFFIX)) {', 'if (false) {'),
 ('search-migrations.ts', 'CONSTRAINT article_search_tokens_ck CHECK (cardinality(tokens) <= 100000 AND array_position(tokens, NULL::text) IS NULL)', 'CONSTRAINT article_search_tokens_ck CHECK (cardinality(tokens) <= 100000)'),
]
lo = int(sys.argv[1]) if len(sys.argv) > 1 else 1
hi = int(sys.argv[2]) if len(sys.argv) > 2 else len(M)
node = os.environ.get('MUTATION_NODE', 'node')
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
    print(f'#{i:02d} {f:20s} {"KILLED" if red else "SURVIVED"}  {old[:60]!r}', flush=True)
print(f'\nکشته: {killed}  زنده: {len(survived)} {survived}')
sys.exit(1 if survived else 0)
