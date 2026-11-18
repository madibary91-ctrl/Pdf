"""
آزمون جهشی دستی برای ledger (برش ل۱؛ ADR-0018): هر جهش را اعمال می‌کند، تست‌های ماژول را اجرا می‌کند و فایل را برمی‌گرداند.
هر جهش باید «KILLED» شود. «SURVIVED» = تست ضعیف یا کد مرده/هم‌ارز. فقط Python 3 استاندارد؛ جزو CI نیست. نیاز: Node ≥ 22.
اجرا: python3 tooling/mutation/ledger.py          (همه)
      python3 tooling/mutation/ledger.py 3 9      (فقط جهش‌های ۳ تا ۹)
هر جهش یک بار (و فقط نخستین رخداد) اعمال می‌شود؛ اگر متن اصلی پیدا نشود اجرا متوقف می‌شود (کد عوض شده و فهرست باید به‌روز شود).
# (عمداً نیامده — هم‌ارز: حذف `v === null` در isPlainObject (validate.ts)؛ `Object.getPrototypeOf(null)` می‌پرتابد و try/catch مرزِ parseCommand/parseKey
#  آن را همان `INVALID_INPUT` می‌کند، پس خروجی قابل‌مشاهده یکی است؛ بررسی صریح برای خوانایی مانده است.)
"""
import subprocess, sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
D = os.path.join(ROOT, 'src/modules/ledger') + '/'
TESTS = ['src/modules/ledger']
M = []
def m(f, old, new):
    M.append((f, old, new))

# engine.ts — جمع، کلید یکتایی و اثر انگشت
m('engine.ts', r'''return Number.isSafeInteger(s) ? s : null;''', r'''return s;''')
m('engine.ts', r'''return `charge:${cmd.reservationId}/${cmd.attemptId}`;''', r'''return `charge:${cmd.reservationId}`;''')
m('engine.ts', r'''return `reserve:${cmd.reservationId}`;''', r'''return `grant:${cmd.reservationId}`;''')
m('engine.ts', r'''return `close:${cmd.reservationId}`;''', r'''return `reserve:${cmd.reservationId}`;''')
m('engine.ts', r'''JSON.stringify(["grant", cmd.unit, cmd.amount, cmd.source])''', r'''JSON.stringify(["grant", cmd.unit, cmd.amount])''')
m('engine.ts', r'''JSON.stringify(["reserve", cmd.unit, cmd.amount, cmd.ttlMs])''', r'''JSON.stringify(["reserve", cmd.unit, cmd.amount])''')
m('engine.ts', r'''JSON.stringify(["reserve", cmd.unit, cmd.amount, cmd.ttlMs])''', r'''JSON.stringify(["reserve", cmd.unit, cmd.ttlMs])''')
m('engine.ts', r'''JSON.stringify(["charge", cmd.unit, cmd.amount])''', r'''JSON.stringify(["charge", cmd.unit])''')
m('engine.ts', r'''JSON.stringify(["close", cmd.remainder])''', r'''JSON.stringify(["close"])''')
m('engine.ts', r'''JSON.stringify(["refund", cmd.reservationId, cmd.attemptId, cmd.unit, cmd.amount])''', r'''JSON.stringify(["refund", cmd.unit, cmd.amount])''')
m('engine.ts', r'''JSON.stringify(["refund", cmd.reservationId, cmd.attemptId, cmd.unit, cmd.amount])''', r'''JSON.stringify(["refund", cmd.reservationId, cmd.attemptId, cmd.unit])''')
# engine.ts — ژورنال و رد
m('engine.ts', r'''return { ok: false, error: error.error, state, entries, changed: entries.length > 0 };''', r'''return { ok: false, error: error.error, state, entries, changed: false };''')
m('engine.ts', r'''  s.seq += 1;''', r'''  s.seq += 0;''')
m('engine.ts', r'''availableAfter: s.available,''', r'''availableAfter: s.held,''')
m('engine.ts', r'''heldAfter: s.held,
    }),''', r'''heldAfter: s.available,
    }),''')
# engine.ts — انقضا
m('engine.ts', r'''r.status === "open" && r.expiresAtMs <= at''', r'''r.status === "open" && r.expiresAtMs < at''')
m('engine.ts', r'''    s.available += amount;
    s.held -= amount;
    r.status = "closed";''', r'''    s.held -= amount;
    r.status = "closed";''')
m('engine.ts', r'''r.closedBy = "expiry";''', r'''r.closedBy = "release";''')
m('engine.ts', r'''a.expiresAtMs - b.expiresAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)''', r'''a.expiresAtMs - b.expiresAtMs''')
m('engine.ts', r'''push(s, entries, at, { type: "expire", amount, reservationId: r.id });''', r'''push(s, entries, at, { type: "release", amount, reservationId: r.id });''')
# engine.ts — open
m('engine.ts', r'''if (current.unit !== cmd.unit) return reject(current, [], fail("IDEMPOTENCY_CONFLICT"''', r'''if (false) return reject(current, [], fail("IDEMPOTENCY_CONFLICT"''')
m('engine.ts', r'''    lastAtMs: at,''', r'''    lastAtMs: 0,''')
m('engine.ts', r'''return { ok: true, receipt, replayed: true, state: structuredClone(current), entries: [], changed: false };''', r'''return { ok: true, receipt, replayed: false, state: structuredClone(current), entries: [], changed: false };''')
# engine.ts — grant
m('engine.ts', r'''  s.totals.granted = granted;''', r'''''')
m('engine.ts', r'''if (available === null || granted === null) return stepErr("OVERFLOW", "جمع اعتبار''', r'''if (available === null) return stepErr("OVERFLOW", "جمع اعتبار''')
# engine.ts — reserve
m('engine.ts', r'''openCount(s) >= LIMITS.MAX_OPEN_RESERVATIONS''', r'''openCount(s) > LIMITS.MAX_OPEN_RESERVATIONS''')
m('engine.ts', r'''if (cmd.amount > s.available) return stepErr("INSUFFICIENT_CREDIT"''', r'''if (cmd.amount >= s.available) return stepErr("INSUFFICIENT_CREDIT"''')
m('engine.ts', r'''  s.available -= cmd.amount;
  s.held += cmd.amount;''', r'''  s.available -= cmd.amount;''')
m('engine.ts', r'''const expiresAtMs = add(at, cmd.ttlMs);''', r'''const expiresAtMs = add(0, cmd.ttlMs);''')
m('engine.ts', r'''if (get(s.reservations, cmd.reservationId) !== undefined) return stepErr("INTERNAL_ERROR"''', r'''if (false) return stepErr("INTERNAL_ERROR"''')
# engine.ts — charge
m('engine.ts', r'''  if (r.status !== "open") return closedError(r);
  if (get(r.attempts''', r'''  if (get(r.attempts''')
m('engine.ts', r'''return r.closedBy === "expiry" ? stepErr("RESERVATION_EXPIRED"''', r'''return false ? stepErr("RESERVATION_EXPIRED"''')
m('engine.ts', r'''Object.keys(r.attempts).length >= LIMITS.MAX_ATTEMPTS_PER_RESERVATION''', r'''Object.keys(r.attempts).length > LIMITS.MAX_ATTEMPTS_PER_RESERVATION''')
m('engine.ts', r'''const charged = Math.min(cmd.amount, r.remaining);''', r'''const charged = cmd.amount;''')
m('engine.ts', r'''const shortfall = cmd.amount - charged;''', r'''const shortfall = 0;''')
m('engine.ts', r'''  s.held -= charged;
  s.totals.charged = totalCharged;''', r'''  s.totals.charged = totalCharged;''')
m('engine.ts', r'''  s.totals.shortfall = totalShortfall;''', r'''''')
m('engine.ts', r'''  s.totals.charged = totalCharged;''', r'''''')
# engine.ts — close
m('engine.ts', r'''if (cmd.remainder === "forfeit") return stepErr("RESERVATION_EXPIRED"''', r'''if (false) return stepErr("RESERVATION_EXPIRED"''')
m('engine.ts', r'''replayed: !expiredNow,''', r'''replayed: true,''')
m('engine.ts', r'''const expiredNow = entries.some((e) => e.type === "expire" && e.reservationId === r.id);''', r'''const expiredNow = false;''')
m('engine.ts', r'''const expiredNow = entries.some((e) => e.type === "expire" && e.reservationId === r.id);''', r'''const expiredNow = entries.length > 0;''')
m('engine.ts', r'''    s.available += amount;
    s.held -= amount;
  } else {''', r'''    s.held -= amount;
  } else {''')
m('engine.ts', r'''    s.totals.forfeited = forfeited;''', r'''''')
m('engine.ts', r'''  r.closedAmount = amount;
  r.remaining = 0;
  r.closedAtMs = at;
  push(s, entries, at, { type: cmd.remainder''', r'''  r.closedAmount = 0;
  r.remaining = 0;
  r.closedAtMs = at;
  push(s, entries, at, { type: cmd.remainder''')
m('engine.ts', r'''push(s, entries, at, { type: cmd.remainder, amount, reservationId: r.id });''', r'''push(s, entries, at, { type: "release", amount, reservationId: r.id });''')
m('engine.ts', r'''if (r.closedBy !== "expiry") return stepErr("INTERNAL_ERROR"''', r'''if (false) return stepErr("INTERNAL_ERROR"''')
# engine.ts — refund
m('engine.ts', r'''if (cmd.amount > a.charged - a.refunded) return''', r'''if (cmd.amount >= a.charged - a.refunded) return''')
m('engine.ts', r'''if (cmd.amount > a.charged - a.refunded) return''', r'''if (cmd.amount > a.charged) return''')
m('engine.ts', r'''  a.refunded += cmd.amount;''', r'''''')
m('engine.ts', r'''  s.totals.refunded = refunded;''', r'''''')
m('engine.ts', r'''if (a === undefined) return stepErr("CHARGE_NOT_FOUND"''', r'''if (false) return stepErr("CHARGE_NOT_FOUND"''')
# engine.ts — run
m('engine.ts', r'''if (!Number.isSafeInteger(atMs) || atMs < 0) return reject''', r'''if (!Number.isSafeInteger(atMs)) return reject''')
m('engine.ts', r'''current.tenantId !== cmd.tenantId || current.accountId !== cmd.accountId''', r'''current.accountId !== cmd.accountId''')
m('engine.ts', r'''current.tenantId !== cmd.tenantId || current.accountId !== cmd.accountId''', r'''current.tenantId !== cmd.tenantId''')
m('engine.ts', r'''if (prior.fingerprint !== fp) return reject''', r'''if (false) return reject''')
m('engine.ts', r'''if ("unit" in cmd && cmd.unit !== current.unit)''', r'''if (false)''')
m('engine.ts', r'''  const at = Math.max(atMs, s.lastAtMs);
  const entries: JournalEntry[] = [];''', r'''  const at = atMs;
  const entries: JournalEntry[] = [];''')
m('engine.ts', r'''  const at = Math.max(atMs, s.lastAtMs);
  expireDue(s, at, []);''', r'''  const at = atMs;
  expireDue(s, at, []);''')
m('engine.ts', r'''    if (entries.length > 0) s.lastAtMs = at;
''', r'''''')
m('engine.ts', r'''return reject(entries.length > 0 ? s : current, entries, step.err);''', r'''return reject(current, entries, step.err);''')
m('engine.ts', r'''  s.lastAtMs = at;
  // بازتکرار''', r'''  // بازتکرار''')
m('engine.ts', r'''  s.processed[key] = { fingerprint: fp, receipt: structuredClone(step.receipt) };''', r'''''')
m('engine.ts', r'''receipt: structuredClone(prior.receipt), replayed: true,''', r'''receipt: structuredClone(prior.receipt), replayed: false,''')
m('engine.ts', r'''state: structuredClone(current), entries: [], changed: false };
  }
  if ("unit"''', r'''state: current, entries: [], changed: false };
  }
  if ("unit"''')
m('engine.ts', r'''  r.charged += charged;''', r'''  r.charged += 0;''')
# validate.ts
m('validate.ts', r'''/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/''', r'''/^[A-Za-z0-9][A-Za-z0-9._:-]{0,128}$/''')
m('validate.ts', r'''/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/''', r'''/^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/''')
m('validate.ts', r'''/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/''', r'''/^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$/''')
m('validate.ts', r'''/^[A-Z][A-Z0-9_]{1,15}$/''', r'''/^[A-Z][A-Z0-9_]{0,15}$/''')
m('validate.ts', r'''/^[A-Z][A-Z0-9_]{1,15}$/''', r'''/^[A-Z][A-Z0-9_]{1,16}$/''')
m('validate.ts', r'''/^[A-Z][A-Z0-9_]{1,15}$/''', r'''/^[A-Za-z][A-Z0-9_]{1,15}$/''')
m('validate.ts', r'''Number.isSafeInteger(v) && v >= 1;''', r'''Number.isSafeInteger(v) && v >= 0;''')
m('validate.ts', r'''Number.isSafeInteger(v) && v >= 1;''', r'''Number.isFinite(v) && v >= 1;''')
m('validate.ts', r'''case "amount0":
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;''', r'''case "amount0":
      return typeof v === "number" && Number.isFinite(v) && v >= 0;''')
m('validate.ts', r'''case "amount0":
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;''', r'''case "amount0":
      return typeof v === "number" && Number.isSafeInteger(v) && v >= -1;''')
m('validate.ts', r'''v >= LIMITS.MIN_TTL_MS && v <= LIMITS.MAX_TTL_MS''', r'''v > LIMITS.MIN_TTL_MS && v <= LIMITS.MAX_TTL_MS''')
m('validate.ts', r'''v >= LIMITS.MIN_TTL_MS && v <= LIMITS.MAX_TTL_MS''', r'''v >= LIMITS.MIN_TTL_MS && v < LIMITS.MAX_TTL_MS''')
m('validate.ts', r'''if (!Object.hasOwn(shape, k)) return fail''', r'''if (false) return fail''')
m('validate.ts', r'''out[name] = typeof v === "number" && v === 0 ? 0 : v;''', r'''out[name] = v;''')
m('validate.ts', r'''proto === Object.prototype || proto === null''', r'''proto === Object.prototype''')
m('validate.ts', r'''if (k !== "tenantId" && k !== "accountId")''', r'''if (false)''')
m('validate.ts', r'''/^[A-Za-z0-9_]{1,32}$/.test(k) ? k : "؟"''', r'''k''')
m('validate.ts', r'''return { ok: true, value: Object.freeze(out) as unknown as Command };''', r'''return { ok: true, value: out as unknown as Command };''')
m('validate.ts', r'''(GRANT_SOURCES as readonly string[]).includes(v)''', r'''true''')
m('validate.ts', r'''v === "release" || v === "forfeit"''', r'''typeof v === "string"''')
# ledger.ts
m('ledger.ts', r'''if (!Number.isSafeInteger(t) || t < 0) return fail''', r'''if (!Number.isSafeInteger(t)) return fail''')
m('ledger.ts', r'''if (!Number.isSafeInteger(t) || t < 0) return fail''', r'''if (t < 0) return fail''')
m('ledger.ts', r'''replayed: out.replayed })''', r'''replayed: false })''')
m('ledger.ts', r'''return fail("STORE_FAILURE", "ذخیره‌سازی ناموفق بود''', r'''return fail("INTERNAL_ERROR", "ذخیره‌سازی ناموفق بود''')
m('ledger.ts', r'''viewAt(await st.read(key), now)''', r'''viewAt(await st.read(key), 0)''')
m('ledger.ts', r'''if ((await st.read(key)) === null) return fail("ACCOUNT_NOT_FOUND"''', r'''if (false) return fail("ACCOUNT_NOT_FOUND"''')
m('ledger.ts', r'''Object.freeze(await st.journal(key))''', r'''await st.journal(key)''')
m('ledger.ts', r'''Object.freeze({ ...out.receipt, replayed: out.replayed })''', r'''{ ...out.receipt, replayed: out.replayed }''')
m('ledger.ts', r''' || !isFn(store.read)''', r'''''')
m('ledger.ts', r''' || !isFn(clock.nowMs)''', r'''''')
m('ledger.ts', r'''value: Object.freeze(ledger)''', r'''value: ledger''')
m('ledger.ts', r'''const commit = out.changed && out.state !== null ? { state: out.state, entries: out.entries } : null;''', r'''const commit = out.state !== null ? { state: out.state, entries: out.entries } : null;''')
m('ledger.ts', r'''const commit = out.changed && out.state !== null ? { state: out.state, entries: out.entries } : null;''', r'''const commit = out.changed && out.state !== null ? { state: out.state, entries: [] } : null;''')
# memory-store.ts
m('memory-store.ts', r'''fn(cur === undefined ? null : structuredClone(cur))''', r'''fn(cur === undefined ? null : cur)''')
m('memory-store.ts', r'''const state = structuredClone(out.commit.state);''', r'''const state = out.commit.state;''')
m('memory-store.ts', r'''const entries = structuredClone([...out.commit.entries]);''', r'''const entries = [...out.commit.entries];''')
m('memory-store.ts', r'''journals.set(k, [...log, ...entries]);''', r'''journals.set(k, entries);''')
m('memory-store.ts', r'''const SEP = "\u0000";''', r'''const SEP = "";''')
m('memory-store.ts', r'''return cur === undefined ? null : structuredClone(cur);''', r'''return cur === undefined ? null : cur;''')
m('memory-store.ts', r'''return structuredClone(journals.get(keyOf(key)) ?? []);''', r'''return journals.get(keyOf(key)) ?? [];''')
m('memory-store.ts', r'''if (out.commit !== null) {''', r'''if (false) {''')
# invariants.ts
m('invariants.ts', r'''if (a.charged + a.shortfall !== a.requested)''', r'''if (false)''')
m('invariants.ts', r'''if (a.refunded > a.charged)''', r'''if (false)''')
m('invariants.ts', r'''if (heldSum !== s.held)''', r'''if (false)''')
m('invariants.ts', r'''s.available + s.held + s.totals.charged + s.totals.forfeited) {''', r'''s.available + s.held + s.totals.charged) {''')
m('invariants.ts', r'''if (e.seq !== seq)''', r'''if (false)''')
m('invariants.ts', r'''if (available < 0 || held < 0)''', r'''if (false)''')
m('invariants.ts', r'''if (e.availableAfter !== available || e.heldAfter !== held)''', r'''if (e.availableAfter !== available)''')
m('invariants.ts', r'''        held -= e.amount;
        totals.forfeited += e.amount;''', r'''        held -= e.amount;''')
m('invariants.ts', r'''        totals.shortfall += e.shortfall;''', r'''''')

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
        print(f'#{i} KILLED   {f}: {old[:60]!r}', flush=True)
    else:
        survived.append(i)
        print(f'#{i} SURVIVED {f}: {old[:60]!r} → {new[:60]!r}', flush=True)
print(f'\nکشته: {killed} · زنده: {len(survived)} {survived} · کل: {len(M)}')
sys.exit(1 if survived else 0)
