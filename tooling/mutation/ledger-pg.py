"""
آزمون جهشی دستی برای آداپتور PostgreSQL ledger (برش ل۲؛ ADR-0019): هر جهش را اعمال می‌کند، تست‌ها را اجرا می‌کند و فایل را برمی‌گرداند.
هر جهش باید «KILLED» شود. «SURVIVED» = تست ضعیف یا کد مرده/هم‌ارز. فقط Python 3 استاندارد؛ جزو CI نیست. نیاز: Node ≥ 22 و پایگاه (DATABASE_URL).
اجرا: python3 tooling/mutation/ledger-pg.py          (همه)
      python3 tooling/mutation/ledger-pg.py 3 9      (فقط جهش‌های ۳ تا ۹)
پیش از هر اجرا، «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل‌ها هست (کد عوض شده ⇒ فهرست باید به‌روز شود) و هیچ فایلی را عوض نمی‌کند.

جهش‌های SQL (migrations.ts) فقط با تست‌های «رفتار پایگاه» سنجیده می‌شوند (نه unit.test.ts) چون هر ویرایش مهاجرت checksum قفل‌شده را می‌شکند و
تستِ checksum همه را «بی‌ارزش» می‌کُشد؛ می‌خواهیم **رفتار** پایگاه آن جهش را بگیرد.
# (عمداً نیامده — هم‌ارز، با دلیل:
#  • `ON DELETE RESTRICT` → `CASCADE` در کلیدهای خارجی: DELETE حساب را پیش از FK، TRIGGER `account_guard` رد می‌کند.
#  • `reservation_status_ck`، `journal_seq_ck`: افزونهٔ عمدی؛ `reservation_shape_ck` و TRIGGER بی‌حفرهٔ ژورنال همان را پوشش می‌دهند.
#  • `ORDER BY` در خواندن‌ها: ترتیب پرس‌وجو در نتیجهٔ `toEqual` (شیء/آرایهٔ ژورنال بر اساس seq در همان ترتیب درج) قابل‌تشخیص نیست؛ ترتیب ژورنال با PK و بازپخش `foldJournal` در audit سنجیده می‌شود.
#  • TRIGGER رزرو (شاخهٔ «بسته نهایی است»): حذف `NEW.status <> 'closed'`؛ بازشدنِ رزرو ناچار `closed_by`/`closed_at_ms` را از غیرتهی به تهی می‌برد (قید شکل رزروِ باز) و آن‌ها جداگانه سنجیده می‌شوند.
#  • TRIGGER رزرو (همان شاخه): حذف فقط یکی از `NEW.charged <> OLD.charged` یا `NEW.closed_amount <> OLD.closed_amount`؛ چون `amount` تغییرناپذیر و `remaining` جداگانه سنجیده می‌شود
#    و `amount = charged + remaining + closed_amount`، هر تغییرِ `charged` ناچار `closed_amount` را هم عوض می‌کند و برعکس؛ هر قید با دیگری پوشش داده می‌شود (تکرارِ عمدی).
#  • تابع `attempts_only_refunds_grow`: حذف `n.key IS NULL`؛ نبودِ کلید در `new_a` همان `IS DISTINCT FROM` فیلدهای `requested/charged/shortfall` را درست می‌کند و شمارش کلیدها هم جداگانه می‌سنجد.
#  • نگهبان `nullableId` در journalFromRow: دامنهٔ پایگاه پیش‌تر هر شناسهٔ نامعتبر را رد کرده است.)
"""
import subprocess, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
D = os.path.join(ROOT, 'src/modules/ledger/pg') + '/'
ALL_TESTS = ['src/modules/ledger/pg']
DB_TESTS = ['src/modules/ledger/pg/store.test.ts', 'src/modules/ledger/pg/store-contract.pg.test.ts', 'src/modules/ledger/pg/ledger.pg.property.test.ts']
M = []
def m(f, old, new, tests=None):
    M.append((f, old, new, tests or (DB_TESTS if f == 'migrations.ts' else ALL_TESTS)))

# store.ts
m('store.ts', r'''        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockName(schema, key)}, 0))`);
''', '')
m('store.ts', r'''        await assertCurrent(tx, schema);
        const before = await loadState(tx, schema, key, true);''', r'''        const before = await loadState(tx, schema, key, true);''')
m('store.ts', r'''        if (before !== null) verify(before);
''', '')
m('store.ts', r'''if (out.commit !== null) await writeCommit(''', r'''if (out.commit !== null && false) await writeCommit(''')
m('store.ts', r'''      if (userError !== null) throw (userError as { e: unknown }).e;
''', '')
m('store.ts', r'''out = fn(before === null ? null : structuredClone(before));''', r'''out = fn(before);''')
m('store.ts', r'''          if (s !== null) verify(s);
          return s;''', r'''          return s;''')
m('store.ts', r'''if (semanticGuards && checkInvariants(s).length > 0) throw corrupt''', r'''if (false && checkInvariants(s).length > 0) throw corrupt''')
m('store.ts', r'''buildPgStore(db, schema.value, true)''', r'''buildPgStore(db, schema.value, false)''')
m('store.ts', r'''          await assertCurrent(tx, schema);
          return loadJournal(tx, schema, key);''', r'''          return loadJournal(tx, schema, key);''')
m('store.ts', r'''|| !isFn(d.transaction)''', '')
m('store.ts', r'''parseSchemaName(options.schema ?? LEDGER_DEFAULT_SCHEMA)''', r'''parseSchemaName(options.schema ?? "public")''')
# write.ts
m('write.ts', r'''if (state.tenantId !== key.tenantId || state.accountId !== key.accountId) throw''', r'''if (false) throw''')
m('write.ts', r'''if (semanticGuards && checkInvariants(state).length > 0) throw''', r'''if (false) throw''')
m('write.ts', r'''if (before !== null && (state.unit !== before.unit || state.createdAtMs !== before.createdAtMs)) throw''', r'''if (false) throw''')
m('write.ts', r'''if (!Object.hasOwn(state.reservations, id)) throw rejected''', r'''if (false) throw rejected''')
m('write.ts', r'''if (r.id !== id) throw rejected''', r'''if (false) throw rejected''')
m('write.ts', r'''if (old.amount !== r.amount || old.createdAtMs !== r.createdAtMs || old.expiresAtMs !== r.expiresAtMs) throw''', r'''if (old.amount !== r.amount || old.createdAtMs !== r.createdAtMs) throw''')
m('write.ts', r'''if (old.amount !== r.amount || old.createdAtMs !== r.createdAtMs || old.expiresAtMs !== r.expiresAtMs) throw''', r'''if (false) throw''')
m('write.ts', r'''} else if (reservationCanon(old) !== reservationCanon(r)) {''', r'''} else if (false) {''')
m('write.ts', r'''      await insertReservation(tx, schema, key, r);''', '')
m('write.ts', r'''if (processedCanon(baseProc[k] as (typeof state.processed)[string]) !== processedCanon(p)) throw''', r'''if (false) throw''')
m('write.ts', r'''if (!Object.hasOwn(state.processed, k)) throw rejected''', r'''if (false) throw rejected''')
m('write.ts', r'''  for (const e of entries) await insertEntry(tx, schema, key, e);''', '')
m('write.ts', r'''await writeAccount(tx, schema, state, before === null);''', r'''await writeAccount(tx, schema, state, before !== null);''')
m('write.ts', r'''if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw''', r'''if (typeof v !== "number" || v < 0) throw''')
m('write.ts', r'''if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw''', r'''if (typeof v !== "number" || !Number.isSafeInteger(v)) throw''')
# read.ts
m('read.ts', r'''|| !ID_RE.test(k.tenantId) ''', '')
m('read.ts', r'''|| !ID_RE.test(k.accountId)''', '')
m('read.ts', r'''typeof k.tenantId !== "string" ||''', '')
m('read.ts', r'''${lock ? sql.raw(" FOR UPDATE") : sql.raw("")}''', r'''${sql.raw("")}''')
m('read.ts', r'''WHERE tenant_id = ${key.tenantId} AND account_id = ${key.accountId}${lock''', r'''WHERE account_id = ${key.accountId}${lock''')
# rows.ts
m('rows.ts', r'''if (!Number.isSafeInteger(n) || n < 0) throw corrupt''', r'''if (!Number.isSafeInteger(n)) throw corrupt''')
m('rows.ts', r'''else if (typeof v === "string" && /^[0-9]{1,16}$/.test(v)) n = Number(v);''', r'''else if (typeof v === "string") n = Number(v);''')
m('rows.ts', r'''|| Object.keys(a).sort().join(",") !== ATTEMPT_KEYS''', '')
m('rows.ts', r'''if (Object.hasOwn(res, r.id)) throw corrupt''', r'''if (false) throw corrupt''')
m('rows.ts', r'''if (Object.hasOwn(proc, k)) throw corrupt''', r'''if (false) throw corrupt''')
m('rows.ts', r'''!RECEIPT_KINDS.has(v["kind"])''', r'''false''')
m('rows.ts', r'''if (typeof x !== "string" && typeof x !== "number") throw corrupt''', r'''if (false) throw corrupt''')
m('rows.ts', r'''r.createdAtMs, r.expiresAtMs, r.closedAtMs, attempts])''', r'''r.createdAtMs, r.expiresAtMs, attempts])''')
m('rows.ts', r'''    .sort()
    .map((id) => {''', r'''    .map((id) => {''')
# migrate.ts
m('migrate.ts', r'''if (stored !== migrationChecksum(m)) {''', r'''if (false) {''')
m('migrate.ts', r'''    if (pending.length > 0) {
      throw new LedgerStoreError({ code: "MIGRATION_TAMPERED"''', r'''    if (false) {
      throw new LedgerStoreError({ code: "MIGRATION_TAMPERED"''')
m('migrate.ts', r'''if (!known.has(row.name)) {''', r'''if (false) {''')
m('migrate.ts', r'''  if (status.pending.length > 0) {
    throw new LedgerStoreError({ code: "NOT_MIGRATED"''', r'''  if (false) {
    throw new LedgerStoreError({ code: "NOT_MIGRATED"''')
m('migrate.ts', r'''      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ledger:migrate:${schema}`}, 0))`);
''', '')
m('migrate.ts', r'''for (const m of MIGRATIONS.filter((x) => status.pending.includes(x.name))) {''', r'''for (const m of MIGRATIONS) {''')
# audit.ts
m('audit.ts', r'''if (f.available !== state.available)''', r'''if (false)''')
m('audit.ts', r'''if (f.held !== state.held)''', r'''if (false)''')
m('audit.ts', r'''if (f.totals[k] !== state.totals[k])''', r'''if (false)''')
m('audit.ts', r'''if (f.seq !== state.seq)''', r'''if (false)''')
m('audit.ts', r'''        problems.push(...checkInvariants(state));''', '')
# errors.ts
m('errors.ts', r'''pg.code.startsWith("23")''', r'''pg.code.startsWith("24")''')
m('errors.ts', r'''pg.code === "42P01" || pg.code === "3F000"''', r'''pg.code === "42P01"''')
m('errors.ts', r'''  if (e instanceof LedgerStoreError) return e.error;
''', '')
m('errors.ts', r'''typeof rec.code === "string" && /^[0-9A-Z]{5}$/.test(rec.code)''', r'''typeof rec.code === "string"''')
# naming.ts
m('naming.ts', r'''${key.tenantId.length}:''', '')
m('naming.ts', r'''ledger:${schema}:''', r'''ledger:''')
m('naming.ts', r'''{0,39}$/;''', r'''{0,40}$/;''')
m('naming.ts', r'''new Set(["public", "information_schema"])''', r'''new Set(["information_schema"])''')
m('naming.ts', r''' || value.startsWith("pg_")''', '')
m('naming.ts', r'''export const LEDGER_DEFAULT_SCHEMA = "ledger";''', r'''export const LEDGER_DEFAULT_SCHEMA = "ledgerx";''')
# migrations.ts (SQL) — فقط با تست‌های رفتار پایگاه
m('migrations.ts', r''',
       CONSTRAINT account_conservation_ck CHECK (granted + refunded = available + held + charged + forfeited)''', '')
m('migrations.ts', r'''CHECK (granted + refunded = available + held + charged + forfeited)''', r'''CHECK (granted = available + held + charged + forfeited)''')
m('migrations.ts', r'''BEFORE UPDATE OR DELETE ON ${S}.journal''', r'''BEFORE DELETE ON ${S}.journal''')
m('migrations.ts', r'''BEFORE UPDATE OR DELETE ON ${S}.journal''', r'''BEFORE UPDATE ON ${S}.journal''')
m('migrations.ts', r'''CREATE TRIGGER journal_no_truncate BEFORE TRUNCATE ON ${S}.journal''', r'''CREATE TRIGGER journal_no_truncate BEFORE TRUNCATE ON ${S}.processed''')
m('migrations.ts', r'''BEFORE UPDATE OR DELETE ON ${S}.processed''', r'''BEFORE DELETE ON ${S}.processed''')
m('migrations.ts', r'''BEFORE UPDATE OR DELETE ON ${S}.processed''', r'''BEFORE UPDATE ON ${S}.processed''')
m('migrations.ts', r'''CREATE TRIGGER processed_no_truncate BEFORE TRUNCATE ON ${S}.processed''', r'''CREATE TRIGGER processed_no_truncate BEFORE TRUNCATE ON ${S}.journal''')
m('migrations.ts', r'''IF NEW.seq <> last_seq + 1 THEN''', r'''IF NEW.seq <= last_seq THEN''')
m('migrations.ts', r'''IF NEW.seq <> last_seq + 1 THEN''', r'''IF NEW.seq > last_seq + 1 THEN''')
m('migrations.ts', r'''NEW.seq < OLD.seq OR NEW.last_at_ms < OLD.last_at_ms OR''', r'''NEW.last_at_ms < OLD.last_at_ms OR''')
m('migrations.ts', r'''OR NEW.last_at_ms < OLD.last_at_ms OR NEW.granted''', r'''OR NEW.granted''')
m('migrations.ts', r'''OR NEW.granted < OLD.granted OR NEW.charged < OLD.charged''', r'''OR NEW.charged < OLD.charged''')
m('migrations.ts', r'''NEW.charged < OLD.charged
          OR NEW.forfeited < OLD.forfeited''', r'''NEW.forfeited < OLD.forfeited''')
m('migrations.ts', r'''OR NEW.forfeited < OLD.forfeited OR NEW.refunded''', r'''OR NEW.refunded''')
m('migrations.ts', r'''OR NEW.refunded < OLD.refunded OR NEW.shortfall''', r'''OR NEW.shortfall''')
m('migrations.ts', r''' OR NEW.shortfall < OLD.shortfall THEN''', r''' THEN''')
m('migrations.ts', r'''OR NEW.unit <> OLD.unit OR NEW.created_at_ms <> OLD.created_at_ms THEN''', r'''OR NEW.created_at_ms <> OLD.created_at_ms THEN''')
m('migrations.ts', r'''OR NEW.unit <> OLD.unit OR NEW.created_at_ms <> OLD.created_at_ms THEN''', r'''OR NEW.unit <> OLD.unit THEN''')
m('migrations.ts', r'''IF TG_OP = 'DELETE' THEN
         RAISE EXCEPTION 'ledger: accounts are never deleted''', r'''IF false THEN
         RAISE EXCEPTION 'ledger: accounts are never deleted''')
m('migrations.ts', r'''OR NEW.amount <> OLD.amount OR NEW.created_at_ms''', r'''OR NEW.created_at_ms''')
m('migrations.ts', r'''OR NEW.created_at_ms <> OLD.created_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms THEN''', r'''OR NEW.created_at_ms <> OLD.created_at_ms THEN''')
m('migrations.ts', r'''IF NEW.status <> 'closed' OR NEW.remaining <> OLD.remaining''', r'''IF NEW.remaining <> OLD.remaining''')
m('migrations.ts', r'''OR NEW.charged <> OLD.charged OR NEW.closed_amount''', r'''OR NEW.closed_amount''')
m('migrations.ts', r'''OR NEW.closed_amount <> OLD.closed_amount
            OR NEW.closed_by IS DISTINCT FROM OLD.closed_by''', r'''OR NEW.closed_by IS DISTINCT FROM OLD.closed_by''')
m('migrations.ts', r'''OR NEW.closed_by IS DISTINCT FROM OLD.closed_by OR NEW.closed_at_ms IS DISTINCT FROM OLD.closed_at_ms''', r'''OR NEW.closed_at_ms IS DISTINCT FROM OLD.closed_at_ms''')
m('migrations.ts', r'''OR NEW.closed_at_ms IS DISTINCT FROM OLD.closed_at_ms
            OR NOT''', r'''OR NOT''')
m('migrations.ts', r'''
            OR NOT ${S}.attempts_only_refunds_grow(OLD.attempts, NEW.attempts) THEN''', r''' THEN''')
m('migrations.ts', r'''OR (n.value ->> 'refunded')::bigint < (o.value ->> 'refunded')::bigint''', r'''OR false''')
m('migrations.ts', r'''
               OR (n.value -> 'charged') IS DISTINCT FROM (o.value -> 'charged')''', '')
m('migrations.ts', r'''
               OR (n.value -> 'requested') IS DISTINCT FROM (o.value -> 'requested')''', '')
m('migrations.ts', r'''
               OR (n.value -> 'shortfall') IS DISTINCT FROM (o.value -> 'shortfall')''', '')
m('migrations.ts', r'''WHERE n.key IS NULL
               OR (n.value -> 'requested')''', r'''WHERE (n.value -> 'requested')''')
m('migrations.ts', r'''SELECT (SELECT count(*) FROM jsonb_object_keys(old_a)) = (SELECT count(*) FROM jsonb_object_keys(new_a))''', r'''SELECT true''')
m('migrations.ts', r'''IF NEW.charged < OLD.charged THEN
         RAISE EXCEPTION 'ledger: charged never decreases''', r'''IF false THEN
         RAISE EXCEPTION 'ledger: charged never decreases''')
m('migrations.ts', r'''{0,127}$')''', r'''{0,128}$')''')
m('migrations.ts', r'''[A-Za-z0-9][A-Za-z0-9._:-]''', r'''[A-Za-z0-9_][A-Za-z0-9._:-]''')
m('migrations.ts', r'''{1,15}$')''', r'''{1,16}$')''')
m('migrations.ts', r''''^[A-Z][A-Z0-9_]''', r''''^[A-Za-z][A-Z0-9_]''')
m('migrations.ts', r'''VALUE >= 0 AND VALUE <= 9007199254740991''', r'''VALUE <= 9007199254740991''')
m('migrations.ts', r'''VALUE <= 9007199254740991''', r'''VALUE <= 9007199254740992''')
m('migrations.ts', r'''CHECK (amount = charged + remaining + closed_amount)''', r'''CHECK (amount >= charged + remaining + closed_amount)''')
m('migrations.ts', r'''(status = 'open' AND closed_by IS NULL AND closed_at_ms IS NULL AND closed_amount = 0)''', r'''(status = 'open' AND closed_by IS NULL AND closed_at_ms IS NULL)''')
m('migrations.ts', r'''(status = 'open' AND closed_by IS NULL AND closed_at_ms IS NULL AND closed_amount = 0)''', r'''(status = 'open' AND closed_by IS NULL AND closed_amount = 0)''')
m('migrations.ts', r'''(status = 'open' AND closed_by IS NULL AND closed_at_ms IS NULL AND closed_amount = 0)''', r'''(status = 'open' AND closed_at_ms IS NULL AND closed_amount = 0)''')
m('migrations.ts', r'''closed_by IS NULL OR closed_by IN ('release', 'forfeit', 'expiry')''', r'''true''')
m('migrations.ts', r'''CHECK (jsonb_typeof(attempts) = 'object')''', r'''CHECK (true)''')
m('migrations.ts', r'''CHECK (char_length(fingerprint) BETWEEN 1 AND 2000)''', r'''CHECK (char_length(fingerprint) <= 2000)''')
m('migrations.ts', r'''CHECK (char_length(fingerprint) BETWEEN 1 AND 2000)''', r'''CHECK (char_length(fingerprint) >= 1)''')
m('migrations.ts', r'''char_length(op_key) <= 300 AND ''', '')
m('migrations.ts', r'''op_key ~ '^(grant|reserve|charge|close|refund):''', r'''op_key ~ '^(grant|reserve|charge|close):''')
m('migrations.ts', r'''coalesce((receipt ->> 'kind') IN (${KINDS}), false)''', r'''(receipt ->> 'kind') IN (${KINDS})''')
m('migrations.ts', r'''CONSTRAINT journal_shortfall_ck CHECK (type = 'charge' OR shortfall = 0)''', r'''CONSTRAINT journal_shortfall_ck CHECK (true)''')
m('migrations.ts', r'''CONSTRAINT journal_type_ck CHECK (type IN (${JOURNAL_TYPES}))''', r'''CONSTRAINT journal_type_ck CHECK (true)''')

lo = int(sys.argv[1]) if len(sys.argv) > 1 else 1
hi = int(sys.argv[2]) if len(sys.argv) > 2 else len(M)

# پیش‌بازرسی: متن اصلیِ هر جهش در فایل هست؟
bad = [(i, f, old[:70]) for i, (f, old, new, _t) in enumerate(M, 1) if old not in open(D + f, encoding='utf-8').read()]
if bad:
    for i, f, o in bad:
        print(f'#{i} {f}: متن اصلی پیدا نشد؛ فهرست جهش‌ها باید به‌روز شود: {o!r}')
    sys.exit(2)

survived, killed = [], 0
for i, (f, old, new, tests) in enumerate(M, 1):
    if i < lo or i > hi:
        continue
    path = D + f
    src = open(path, encoding='utf-8').read()
    try:
        open(path, 'w', encoding='utf-8').write(src.replace(old, new, 1))
        r = subprocess.run(['node_modules/.bin/vitest', 'run', *tests], cwd=ROOT, capture_output=True, text=True, timeout=300)
        red = r.returncode != 0
    except subprocess.TimeoutExpired:
        red = True  # گیرکردن هم «کشته شدن» است
    finally:
        open(path, 'w', encoding='utf-8').write(src)
    if red:
        killed += 1
        print(f'#{i} KILLED   {f}: {old[:60]!r}', flush=True)
    else:
        survived.append(i)
        print(f'#{i} SURVIVED {f}: {old[:60]!r} → {new[:60]!r}', flush=True)
print(f'\nکشته: {killed} · زنده: {len(survived)} {survived} · کل: {len(M)}')
sys.exit(1 if survived else 0)
