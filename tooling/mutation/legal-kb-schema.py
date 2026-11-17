"""
آزمون جهشی دستی برای legal-kb-schema: هر جهش را اعمال می‌کند، تست‌های ماژول را اجرا می‌کند و فایل را برمی‌گرداند.
هر جهش باید «KILLED» شود (تست قرمز). «SURVIVED» = تست ضعیف یا کد مرده. فقط با Python 3 استاندارد؛ جزو CI نیست.
اجرا: python3 tooling/mutation/legal-kb-schema.py
"""
import subprocess, sys
import os
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))
D=os.path.join(ROOT,'src/modules/legal-kb-schema')+'/'
M=[
 ('lookup.ts','compareIsoDates(date, v.validTo) < 0','compareIsoDates(date, v.validTo) <= 0'),
 ('lookup.ts','if (compareIsoDates(date, v.validFrom) < 0) {','if (compareIsoDates(date, v.validFrom) <= 0) {'),
 ('lookup.ts','verified: found.provenance.review.status === "legally-verified",','verified: true,'),
 ('lookup.ts','return Array.from(new Set([...docLevel, ...exact]));','return [...docLevel, ...exact];'),
 ('lookup.ts','if (!entry) return ok({ status: "unknown-article" });','if (!entry) return ok({ status: "unknown-document" });'),
 ('integrity.ts','compareIsoDates(a.validTo, b.validFrom) > 0)','compareIsoDates(a.validTo, b.validFrom) >= 0)'),
 ('integrity.ts','compareIsoDates(v.validTo, v.validFrom) <= 0','compareIsoDates(v.validTo, v.validFrom) < 0'),
 ('integrity.ts','a.validTo === null || compareIsoDates','false || compareIsoDates'),
 ('integrity.ts','if (directional.has(`${r.type}|${to}|${from}`)) {','if (false) {'),
 ('integrity.ts','else if (r.article !== null && !labels.has(r.article))','else if (false)'),
 ('integrity.ts','if (from === to) addIssue','if (false) addIssue'),
 ('integrity.ts','if (a.validFrom === b.validFrom) {','if (false) {'),
 ('reader.ts','return Array.from(v);','return v;'),
 ('reader.ts','\\u202A-\\u202E','\\u202A-\\u202D'),
 ('reader.ts','if (!allowed.includes(k))','if (false)'),
 ('reader.ts','return proto === Object.prototype || proto === null;','return true;'),
 ('reader.ts','if (!has(rec, key)) {\n    addIssue(ctx, "MISSING_FIELD", p, "این کلید الزامی است؛ اگر','if (false) {\n    addIssue(ctx, "MISSING_FIELD", p, "این کلید الزامی است؛ اگر'),
 ('reader.ts','(multiline ? raw.replace(/\\r\\n?/g, "\\n") : raw).trim()','raw'),
 ('parse.ts','if (v === undefined) return PENDING;','if (v === undefined) return { status: "legally-verified", reviewedBy: "x", reviewedOn: "2000-01-01" };'),
 ('parse.ts','if (status === "pending-legal-review" && (reviewedBy !== null || reviewedOn !== null))','if (false)'),
 ('parse.ts','if (status === "legally-verified" && (reviewedBy === null || reviewedOn === null))','if (status === "legally-verified" && (reviewedBy === null && reviewedOn === null))'),
 ('load.ts','.map((a) => ({ ...a, versions: [...a.versions].sort((x, y) => compareIsoDates(x.validFrom, y.validFrom)) }))','.map((a) => ({ ...a }))'),
 ('load.ts','if (corpus && ctx.issues.length === 0) checkIntegrity(corpus, ctx);','if (corpus) checkIntegrity(corpus, ctx);'),
 ('dates.ts','(y % 4 === 0 && y % 100 !== 0) || y % 400 === 0','y % 4 === 0'),
 ('dates.ts','MIN_ISO_YEAR = 1800','MIN_ISO_YEAR = 1000'),
 ('label.ts','if (repeat < 2 || repeat > MAX_REPEAT)','if (repeat < 1 || repeat > MAX_REPEAT)'),
 ('label.ts','if (articleKey({ kind: "numbered", number, repeat }) !== key)','if (false)'),
 ('label.ts','if (n < 1) return err("OUT_OF_RANGE", "شمارهٔ تبصره/بند','if (n < 0) return err("OUT_OF_RANGE", "شمارهٔ تبصره/بند'),
 ('label.ts','return a.number - b.number || a.repeat - b.repeat;','return a.number - b.number;'),
 ('label.ts','ch === "ك") out += "ک"','ch === "ك") out += "ك"'),
 ('issues.ts','if (ctx.issues.length >= KB_LIMITS.maxIssues) {','if (ctx.issues.length >= 100000) {'),
 ('reader.ts','!/^https?:\\/\\/[^\\s<>"\']+$/i.test(v)','false'),
]
survived=[]
for f,a,b in M:
    p=D+f
    s=open(p,encoding='utf8').read()
    if a not in s:
        print('NOT FOUND',f,a[:50]); survived.append(('NOTFOUND',f,a)); continue
    open(p,'w',encoding='utf8').write(s.replace(a,b,1))
    r=subprocess.run(['npx','vitest','run','src/modules/legal-kb-schema'],cwd=ROOT,capture_output=True,text=True)
    open(p,'w',encoding='utf8').write(s)
    killed = r.returncode!=0
    print('KILLED ' if killed else 'SURVIVED',f,a[:60].replace('\n',' '))
    if not killed: survived.append((f,a))
print('SURVIVORS',len(survived))
for x in survived: print(x)
