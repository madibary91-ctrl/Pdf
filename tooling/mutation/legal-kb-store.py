"""
آزمون جهشی دستی برای legal-kb-store: هر جهش را اعمال می‌کند، تست‌های ماژول را اجرا می‌کند و فایل را برمی‌گرداند.
هر جهش باید «KILLED» شود (تست قرمز). «SURVIVED» = تست ضعیف یا کد مرده/هم‌ارز. فقط Python 3 استاندارد؛ جزو CI نیست.
نیاز: پایگاه آزمون (DATABASE_URL یا KB_TEST_DATABASE_URL). تست «قفل checksum» عمداً کنار گذاشته می‌شود تا جهش‌های SQL فقط
با تست‌های رفتاری سنجیده شوند (وگرنه هر تغییر SQL را آن یک تست می‌کُشت).
اجرا: python3 tooling/mutation/legal-kb-store.py            (همه)
      python3 tooling/mutation/legal-kb-store.py 5 12        (فقط جهش‌های ۵ تا ۱۲)
"""
import subprocess, sys, os
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))
D=os.path.join(ROOT,'src/modules/legal-kb-store')+'/'
M=[
 # migrations.ts — قیدهای پایگاه
 ('migrations.ts','valid_during WITH &&)','valid_during WITH =)'),
 ('migrations.ts',"daterange(valid_from, valid_to, '[)')","daterange(valid_from, valid_to, '[]')"),
 ('migrations.ts','CHECK (valid_to IS NULL OR valid_to > valid_from)','CHECK (valid_to IS NULL OR valid_to >= valid_from)'),
 ('migrations.ts',"(review_status = 'pending-legal-review' AND reviewed_by IS NULL AND reviewed_on IS NULL)","(review_status = 'pending-legal-review')"),
 ('migrations.ts',"(review_status = 'legally-verified' AND reviewed_by IS NOT NULL AND reviewed_on IS NOT NULL)","(review_status = 'legally-verified')"),
 ('migrations.ts',"review_status text NOT NULL DEFAULT 'pending-legal-review'","review_status text NOT NULL DEFAULT 'legally-verified'"),
 ('migrations.ts','\\u202A-\\u202E','\\u202A-\\u202D'),
 ('migrations.ts','\\u2066-\\u2069','\\u2066-\\u2068'),
 ('migrations.ts','\\u007F-\\u009F','\\u007F-\\u008F'),
 ('migrations.ts','\\uFEFF]','\\uFEFE]'),
 ('migrations.ts','^https?://[^','^http://[^'),
 ('migrations.ts','char_length(source_url) <= 2048','char_length(source_url) <= 4096'),
 ('migrations.ts','NOT (from_document_id = to_document_id AND from_article IS NOT DISTINCT FROM to_article)','NOT (from_document_id = to_document_id AND from_article = to_article)'),
 ('migrations.ts',"coalesce(from_article, ''), to_document_id","from_article, to_document_id"),
 ('migrations.ts',"coalesce(effective_from, DATE '9999-12-31')","effective_from"),
 ('migrations.ts',"WHEN article_repeat = 1 THEN article_number::text || ' مکرر'","WHEN article_repeat = 1 THEN article_number::text || ' مکرر 1'"),
 ('migrations.ts',"VALUE BETWEEN DATE '1800-01-01'","VALUE BETWEEN DATE '1000-01-01'"),
 ('migrations.ts',"AND DATE '2200-12-31'","AND DATE '9999-12-31'"),
 ('migrations.ts','char_length(VALUE) <= 200000','char_length(VALUE) <= 300000'),
 ('migrations.ts',"position(E'\\\\r' in VALUE) = 0","true"),
 ('migrations.ts',"position(E'\\\\n' in VALUE) = 0","true"),
 ('migrations.ts',']{1,6})$\'',']{1,60})$\''),
 ('migrations.ts','CHECK (ordinal BETWEEN 0 AND 99)','CHECK (ordinal BETWEEN 0 AND 199)'),
 ('migrations.ts','CONSTRAINT relation_from_article_fk FOREIGN KEY (from_document_id, from_article) REFERENCES ${S}.article (document_id, label),',''),
 ('migrations.ts','CONSTRAINT article_subpart_version_fk FOREIGN KEY (document_id, article_label, valid_from)\n         REFERENCES ${S}.article_version (document_id, article_label, valid_from),',''),
 ('migrations.ts',"CONSTRAINT ruling_cite_ordinal_ck CHECK (ordinal BETWEEN 0 AND 199)","CONSTRAINT ruling_cite_ordinal_ck CHECK (ordinal BETWEEN 0 AND 299)"),
 # migrate.ts
 ('migrate.ts','if (stored !== migrationChecksum(m)) {','if (false) {'),
 ('migrate.ts','    if (pending.length > 0) {\n      throw new StoreAbort({ code: "MIGRATION_TAMPERED"','    if (false) {\n      throw new StoreAbort({ code: "MIGRATION_TAMPERED"'),
 ('migrate.ts','if (!known.has(row.name)) {','if (false) {'),
 ('migrate.ts','await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"legal-kb-store:migrate"}, 0))`);','await tx.execute(sql`SELECT 1`);'),
 ('migrate.ts','if (status.pending.length > 0) {\n    throw new StoreAbort({ code: "NOT_MIGRATED"','if (false) {\n    throw new StoreAbort({ code: "NOT_MIGRATED"'),
 # insert.ts
 ('insert.ts','if (clashes.length > 0) {','if (false) {'),
 ('insert.ts','+ t.idx + 1, t.id, t.kind, t.title','+ t.idx + 2, t.id, t.kind, t.title'),
 ('insert.ts','SELECT (SELECT coalesce(max(seq), 0) FROM ${q("document")})','SELECT (SELECT coalesce(max(seq), 0) * 0 FROM ${q("document")})'),
  ('insert.ts','pg_advisory_xact_lock(hashtextextended(${`legal-kb-store:write:${schema}`}, 0))','pg_advisory_xact_lock(hashtextextended(${`legal-kb-store:write:${schema}`}, 0)) WHERE false'),
 # temporal.ts
 ('temporal.ts','WHERE document_id = ${documentId} AND article_label = ${label.value} AND valid_during @> ${date.value}::date`','WHERE document_id = ${documentId} AND article_label = ${label.value} AND valid_during @> (${date.value}::date + 1)`'),
 ('temporal.ts','if (hits.length > 1) throw','if (false) throw'),
 ('temporal.ts','verified: version.provenance.review.status === "legally-verified" };\n    }, REPEATABLE_READ_ONLY);\n    return { ok: true, value: result };','verified: true };\n    }, REPEATABLE_READ_ONLY);\n    return { ok: true, value: result };'),
 ('temporal.ts','ORDER BY d.seq, a.article_number, a.article_repeat','ORDER BY a.article_number'),
 ('temporal.ts','if (int(exists, "docs") === 0) return { status: "unknown-document" };','if (int(exists, "docs") === 0) return { status: "unknown-article" };'),
 ('temporal.ts','if (prev === undefined) return { status: "not-yet-in-force", firstValidFrom: isoDate(first, "valid_from") };','if (prev === undefined) return { status: "gap", previousValidTo: "2000-01-01", nextValidFrom: isoDate(first, "valid_from") };'),
 ('temporal.ts','if (next === undefined) return { status: "no-longer-in-force", lastValidTo: previousValidTo };','if (next === undefined) return { status: "gap", previousValidTo, nextValidFrom: previousValidTo };'),
 ('temporal.ts','ORDER BY ordinal`','ORDER BY label`'),
 ('temporal.ts','if (seen.has(key)) throw new CorruptRowError','if (false) throw new CorruptRowError'),
 # read.ts
 ('read.ts','FROM ${q("document")} ORDER BY seq`','FROM ${q("document")} ORDER BY id`'),
 ('read.ts','FROM ${q("relation")} ORDER BY seq`','FROM ${q("relation")} ORDER BY type`'),
 ('read.ts','FROM ${q("article_subpart")} ORDER BY document_id, article_label, valid_from, ordinal`','FROM ${q("article_subpart")} ORDER BY document_id, article_label, valid_from, label`'),
 ('read.ts','const loaded = loadCorpus(raw);\n    if (!loaded.ok) {','const loaded = { ok: true as const, value: raw as unknown as Corpus };\n    if (!loaded.ok) {'),
 ('read.ts',"WHERE review_status = 'legally-verified'","WHERE review_status <> 'legally-verified'"),
 # rows.ts
 ('rows.ts','if (!consistent) throw','if (false) throw'),
 ('rows.ts','if (typeof v !== "string") throw new CorruptRowError(`ستون ${k}`);\n  return v;\n}\n\nexport function strOrNull','if (false) throw new CorruptRowError(`ستون ${k}`);\n  return v as string;\n}\n\nexport function strOrNull'),
 # errors.ts / naming.ts
 ('errors.ts','pg.code === "23505"','pg.code === "23506"'),
 ('errors.ts','pg.code.startsWith("22")','pg.code.startsWith("2X")'),
 ('errors.ts','pg.code === "42P01" || pg.code === "3F000"','pg.code === "42P01"'),
 ('naming.ts','const RESERVED = new Set(["public", "information_schema"]);','const RESERVED = new Set(["information_schema"]);'),
 ('naming.ts','|| value.startsWith("pg_")',''),
 ('naming.ts','{0,39}$/','{0,99}$/'),

 # ── بخش ۴ب‑۲ ──
 ('insert.ts','      await assertCurrent(tx, schema);\n\n      await assertNoClashes(tx, schema, loaded.value);','      await assertNoClashes(tx, schema, loaded.value);'),
 ('migrations.ts',"action IN ('verify', 'revoke', 'correct')","action IN ('verify', 'revoke', 'correct', 'delete')"),
 ('migrations.ts',"CHECK (action = 'verify' OR reason IS NOT NULL)","CHECK (true)"),
 ('migrations.ts','char_length(reason) <= 2000','char_length(reason) <= 5000'),
 ('migrations.ts',"jsonb_typeof(before_snapshot) = 'object' AND ",""),
 ('migrations.ts','BEFORE UPDATE OR DELETE ON ${A}.version_audit','BEFORE DELETE ON ${A}.version_audit'),
 ('naming.ts','if (value.endsWith(AUDIT_SUFFIX)) {','if (false) {'),
 ('trust.ts','    requireHash(before, hash);\n    if (before.review.status === "legally-verified") {','    if (before.review.status === "legally-verified") {'),
 ('trust.ts',"SET body = ${content.text}, review_status = 'pending-legal-review', reviewed_by = NULL, reviewed_on = NULL","SET body = ${content.text}"),
 ('trust.ts','if (versionContentHash(content) === current.snapshot.contentHash) {','if (false) {'),
 ('trust.ts','if (before.review.status === "legally-verified") {\n      throw new StoreAbort({ code: "CONFLICT", message: "این نسخه از قبل','if (false) {\n      throw new StoreAbort({ code: "CONFLICT", message: "این نسخه از قبل'),
 ('trust.ts','if (before.review.status !== "legally-verified") {','if (false) {'),
 ('trust.ts','if (after.contentHash !== versionContentHash(content))','if (false)'),
 ('trust.ts','ORDER BY seq ASC LIMIT ${limit}','ORDER BY seq DESC LIMIT ${limit}'),
 ('trust.ts','${lock ? sql`FOR UPDATE` : sql``}',''),
 ('trust.ts','      await assertCurrent(tx, schema);\n      return run(tx);','      return run(tx);'),
 ('incremental.ts','      await assertNoClashes(tx, schema, fresh);\n',''),
 ('incremental.ts','          ...raw,\n          documents:','          documents:'),
 ('incremental.ts','relations: combined.value.relations.slice(context.relations.length)','relations: combined.value.relations.slice(0)'),
 ('incremental.ts','const k = Number(n) - offset;','const k = Number(n);'),
 ('incremental.ts','await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legal-kb-store:write:${schema}`}, 0))`);\n      await assertCurrent(tx, schema);\n\n      let fresh','await assertCurrent(tx, schema);\n\n      let fresh'),
 ('incremental.ts','AND to_document_id IN (SELECT jsonb_array_elements_text(${param}::jsonb))',''),
 ('incremental.ts','if (external !== null && external.length > MAX_EXTERNAL_DOCUMENTS) {','if (false) {'),
 ('content-hash.ts','content.subparts.map((s) => [s.kind, s.label, s.text])','[]'),
 ('version-input.ts','if (input.reasonRequired && (typeof input.reason','if (false && (typeof input.reason'),
 ('version-input.ts','const reason = input.reason === undefined || input.reason === null ? null : input.reason;','const reason = null;'),
]
lo=int(sys.argv[1]) if len(sys.argv)>1 else 1
hi=int(sys.argv[2]) if len(sys.argv)>2 else len(M)
survived=[]
for n,(f,a,b) in enumerate(M,1):
    if n<lo or n>hi: continue
    p=D+f
    s=open(p,encoding='utf8').read()
    if a not in s:
        print(n,'NOT FOUND',f,a[:50]); survived.append(('NOTFOUND',f,a)); continue
    open(p,'w',encoding='utf8').write(s.replace(a,b,1))
    try:
        r=subprocess.run(['npx','vitest','run','src/modules/legal-kb-store','-t','^(?!.*ویرایش‌ناپذیر)'],cwd=ROOT,capture_output=True,text=True,timeout=300)
        killed = r.returncode!=0
    except subprocess.TimeoutExpired:
        killed = True  # قفل/گیر = تست قرمز
    finally:
        open(p,'w',encoding='utf8').write(s)
    print(n,'KILLED ' if killed else 'SURVIVED',f,a[:60].replace('\n',' '),flush=True)
    if not killed: survived.append((n,f,a))
print('SURVIVORS',len(survived))
for x in survived: print(x)
