#!/usr/bin/env python3
"""
آزمون جهشی «اجارهٔ رفتگر» در ماژول settlement (برش م۳‑د‑۳ب؛ ADR-0029): هر جهش یک تغییر کوچکِ معنادار در کد منبع است؛ آزمون‌های تازهٔ این برش باید قرمز شوند.
اجرا:  python3 tooling/mutation/settlement-sweeper-lease.py            (همه)
       python3 tooling/mutation/settlement-sweeper-lease.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22 و پایگاه (DATABASE_URL یا KB_TEST_DATABASE_URL)؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از هر اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها در فایل‌ها هست؛ فایل اصلی پس از هر جهش همیشه برمی‌گردد.
هر جهش فقط با آزمون‌های مربوط به فایلِ خودش سنجیده می‌شود (سرعت)؛ پیش از شروع، همهٔ آزمون‌های تازه بدونِ جهش باید سبز باشند.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/settlement/"
MEM = [B + "memory-claim.test.ts"]
PGT = [B + "pg/claim.unit.test.ts", B + "pg/claim.pg.test.ts"]
SWP = [B + "sweeper.lease.test.ts", B + "sweeper.lease.pg.test.ts"]
NEW_TESTS = MEM + PGT + SWP
M = []


def m(f, old, new, why, tests=None):
    default = {"memory-outbox.ts": MEM, "pg/store.ts": PGT, "sweeper.ts": SWP, "config.ts": SWP, "validate.ts": MEM + PGT + SWP}[f]
    M.append((f, old, new, why, tests or default))


# ── memory-outbox.ts
MC = "const picked = [...rows.values()].filter((e) => isActive(e) && e.dueAtMs <= q.value.nowMs).sort(byDue).slice(0, q.value.limit);"
MS = "for (const e of picked) e.dueAtMs = q.value.nowMs + q.value.leaseMs;\n        return ok(Object.freeze(picked.map(view)));"
m("memory-outbox.ts", MC, MC.replace("<=", "<"), "مرزِ سررسید انحصاری می‌شود (رکوردِ همین لحظه گرفته نمی‌شود)")
m("memory-outbox.ts", MC, MC.replace("e.dueAtMs <= q.value.nowMs", "e.dueAtMs <= q.value.nowMs + 1"), "مرزِ سررسید یک میلی‌ثانیه گشاد می‌شود")
m("memory-outbox.ts", MC, MC.replace("isActive(e) && ", ""), "done/dead هم گرفته می‌شوند")
m("memory-outbox.ts", MC, MC.replace(".sort(byDue)", ""), "ترتیب (سررسید، شناسه) رعایت نمی‌شود")
m("memory-outbox.ts", MC, MC.replace("q.value.limit", "q.value.limit + 1"), "یک رکورد بیش از limit گرفته می‌شود")
m("memory-outbox.ts", MS, MS.replace("q.value.nowMs + q.value.leaseMs", "q.value.nowMs"), "اجاره صفر است (سررسید به now می‌رود)")
m("memory-outbox.ts", MS, MS.replace("q.value.nowMs + q.value.leaseMs", "q.value.nowMs + q.value.leaseMs - 1"), "اجاره یک میلی‌ثانیه کوتاه می‌شود")
m("memory-outbox.ts", MS, "return ok(Object.freeze(picked.map(view)));", "سررسید هرگز نوشته نمی‌شود (اجاره‌ای در کار نیست)")
m("memory-outbox.ts", MS, "const snap = picked.map(view);\n        " + MS.split("\n")[0] + "\n        return ok(Object.freeze(snap));", "عکسِ پیش از به‌روزرسانی برمی‌گردد")
m("memory-outbox.ts", MS, MS.replace("return ok(Object.freeze(picked.map(view)));", "return ok(picked.map(view));"), "پاسخ منجمد نیست")
m("memory-outbox.ts", MS, MS.replace("e.dueAtMs = q.value.nowMs + q.value.leaseMs", "{ e.dueAtMs = q.value.nowMs + q.value.leaseMs; e.attempts += 1; }"), "گرفتن شمارندهٔ تلاش را زیاد می‌کند (تأخیرِ محض نیست)")
m("memory-outbox.ts", MS, MS.replace("e.dueAtMs = q.value.nowMs + q.value.leaseMs", "{ e.dueAtMs = q.value.nowMs + q.value.leaseMs; e.lastErrorCode = null; }"), "گرفتن کدِ خطا را پاک می‌کند")
m("memory-outbox.ts", MS, MS.replace("e.dueAtMs = q.value.nowMs + q.value.leaseMs", "e.dueAtMs = Math.max(e.dueAtMs, q.value.nowMs) + q.value.leaseMs"), "اجاره از سررسیدِ قدیم می‌شمارد نه از now")
m("memory-outbox.ts", "const q = parseClaim(query);\n        if (!q.ok) return q;", "const q = parseDue(query) as ReturnType<typeof parseClaim>;\n        if (!q.ok) return q;", "اعتبارسنجیِ leaseMs حذف می‌شود (parseDue به‌جای parseClaim)")
# ── validate.ts
VC = "if (!isCount(nowMs) || !l.ok || !isLeaseMs(leaseMs) || !Number.isSafeInteger(nowMs + leaseMs)) return invalid();"
m("validate.ts", VC, VC.replace(" || !Number.isSafeInteger(nowMs + leaseMs)", ""), "سرریزِ now+lease بی‌خطا می‌ماند")
m("validate.ts", VC, VC.replace(" || !isLeaseMs(leaseMs)", ""), "leaseMs اعتبارسنجی نمی‌شود")
m("validate.ts", VC, VC.replace("!isCount(nowMs) || ", ""), "nowMs اعتبارسنجی نمی‌شود")
m("validate.ts", VC, VC.replace("!l.ok || ", ""), "limit اعتبارسنجی نمی‌شود")
m("validate.ts", "typeof v === \"number\" && Number.isSafeInteger(v) && v >= 1 && v <= LEASE_MS_MAX", "typeof v === \"number\" && Number.isSafeInteger(v) && v >= 0 && v <= LEASE_MS_MAX", "leaseMs=۰ پذیرفته می‌شود")
m("validate.ts", "typeof v === \"number\" && Number.isSafeInteger(v) && v >= 1 && v <= LEASE_MS_MAX", "typeof v === \"number\" && Number.isSafeInteger(v) && v >= 1 && v < LEASE_MS_MAX", "سقفِ اجاره انحصاری می‌شود")
m("validate.ts", "typeof v === \"number\" && Number.isSafeInteger(v) && v >= 1 && v <= LEASE_MS_MAX", "typeof v === \"number\" && v >= 1 && v <= LEASE_MS_MAX", "leaseMs اعشاری پذیرفته می‌شود")
m("validate.ts", "export const LEASE_MS_MAX = 86_400_000;", "export const LEASE_MS_MAX = 90_000_000;", "سقفِ اجاره بالا می‌رود")
m("validate.ts", "return { ok: true, value: Object.freeze({ nowMs, limit: l.value, leaseMs }) };", "return { ok: true, value: Object.freeze({ nowMs, limit: l.value, leaseMs: leaseMs + 1 }) };", "leaseMs خروجیِ اعتبارسنجی دست‌کاری می‌شود")
# ── pg/store.ts
SQL_PICK = "ORDER BY due_at_ms, tenant_id, account_id, reservation_id\n            LIMIT ${limit}\n            FOR UPDATE SKIP LOCKED"
m("pg/store.ts", SQL_PICK, SQL_PICK.replace(" SKIP LOCKED", ""), "SKIP LOCKED برداشته می‌شود (رفتگرها منتظرِ هم می‌مانند)")
m("pg/store.ts", SQL_PICK, SQL_PICK.replace("\n            FOR UPDATE SKIP LOCKED", ""), "قفلِ ردیف برداشته می‌شود (دو رفتگر یک رکورد را می‌گیرند)")
m("pg/store.ts", SQL_PICK, SQL_PICK.replace("ORDER BY due_at_ms, tenant_id, account_id, reservation_id\n            ", ""), "ترتیبِ انتخاب برداشته می‌شود")
m("pg/store.ts", SQL_PICK, SQL_PICK.replace("LIMIT ${limit}\n            ", ""), "limit برداشته می‌شود")
m("pg/store.ts", "WITH picked AS MATERIALIZED (", "WITH picked AS (", "MATERIALIZED برداشته می‌شود")
m("pg/store.ts", "WHERE state IN ('open', 'settling') AND due_at_ms <= ${nowMs}\n            ORDER BY due_at_ms", "WHERE due_at_ms <= ${nowMs}\n            ORDER BY due_at_ms", "رکوردهای نهایی هم گرفته می‌شوند")
m("pg/store.ts", "WHERE state IN ('open', 'settling') AND due_at_ms <= ${nowMs}\n            ORDER BY due_at_ms", "WHERE state IN ('open', 'settling') AND due_at_ms < ${nowMs}\n            ORDER BY due_at_ms", "مرزِ سررسید انحصاری می‌شود")
m("pg/store.ts", "WHERE state IN ('open', 'settling') AND due_at_ms <= ${nowMs}\n            ORDER BY due_at_ms", "WHERE state IN ('open') AND due_at_ms <= ${nowMs}\n            ORDER BY due_at_ms", "settling گرفته نمی‌شود")
m("pg/store.ts", "UPDATE ${T} AS o SET due_at_ms = ${leaseUntilMs}", "UPDATE ${T} AS o SET due_at_ms = ${nowMs}", "اجاره صفر است")
m("pg/store.ts", "UPDATE ${T} AS o SET due_at_ms = ${leaseUntilMs}", "UPDATE ${T} AS o SET due_at_ms = ${leaseUntilMs}, attempts = attempts + 1", "گرفتن شمارنده را زیاد می‌کند")
m("pg/store.ts", "const leaseUntilMs = nowMs + leaseMs;", "const leaseUntilMs = nowMs + leaseMs - 1;", "اجاره یک میلی‌ثانیه کوتاه می‌شود")
m("pg/store.ts", "const leaseUntilMs = nowMs + leaseMs;", "const leaseUntilMs = nowMs + leaseMs + 1;", "اجاره یک میلی‌ثانیه بلند می‌شود")
m("pg/store.ts", "WHERE o.tenant_id = p.k_tenant AND o.account_id = p.k_account AND o.reservation_id = p.k_reservation", "WHERE o.tenant_id = p.k_tenant AND o.reservation_id = p.k_reservation", "به‌روزرسانی روی شناسهٔ ناقص (حساب حذف)")
m("pg/store.ts", "WHERE o.tenant_id = p.k_tenant AND o.account_id = p.k_account AND o.reservation_id = p.k_reservation", "WHERE o.account_id = p.k_account AND o.reservation_id = p.k_reservation", "به‌روزرسانی روی شناسهٔ ناقص (مستأجر حذف)")
m("pg/store.ts", "WHERE o.tenant_id = p.k_tenant AND o.account_id = p.k_account AND o.reservation_id = p.k_reservation", "WHERE o.tenant_id = p.k_tenant AND o.account_id = p.k_account", "به‌روزرسانی روی شناسهٔ ناقص (رزرو حذف)")
m("pg/store.ts", "ORDER BY k_due, tenant_id, account_id, reservation_id`);", "ORDER BY tenant_id, account_id, reservation_id`);", "ترتیبِ خروجی بر پایهٔ سررسیدِ پیشین نیست")
m("pg/store.ts", "ORDER BY k_due, tenant_id, account_id, reservation_id`);", "ORDER BY k_due DESC, tenant_id, account_id, reservation_id`);", "ترتیبِ خروجی وارونه")
m("pg/store.ts", "      });\n    },\n\n    listDead: (query) => {", "      }, true);\n    },\n\n    listDead: (query) => {", "تراکنشِ گرفتن فقط‌خواندنی می‌شود")
m("pg/store.ts", "const { nowMs, limit, leaseMs } = q.value;", "const { nowMs, limit } = q.value; const leaseMs = 1;", "leaseMs ورودی نادیده گرفته می‌شود")
m("pg/store.ts", "const q = parseClaim(query);\n      if (!q.ok) return Promise.resolve(q);", "const q = parseDue(query) as ReturnType<typeof parseClaim>;\n      if (!q.ok) return Promise.resolve(q);", "اعتبارسنجیِ leaseMs حذف می‌شود")
# ── sweeper.ts
m("sweeper.ts", "if (cfg.leaseMs === null) {\n        const listed", "if (cfg.leaseMs !== null) {\n        const listed", "منبعِ فهرست وارونه")
m("sweeper.ts", "claimDue({ nowMs: now, limit: cfg.limit, leaseMs })", "claimDue({ nowMs: now, limit: cfg.limit, leaseMs: leaseMs * 2 })", "اجارهٔ درخواستی دو برابر")
m("sweeper.ts", "claimDue({ nowMs: now, limit: cfg.limit, leaseMs })", "claimDue({ nowMs: now, limit: 1, leaseMs })", "limit نادیده گرفته می‌شود")
m("sweeper.ts", "claimDue({ nowMs: now, limit: cfg.limit, leaseMs })", "claimDue({ nowMs: now + 1, limit: cfg.limit, leaseMs })", "now دست‌کاری می‌شود")
m("sweeper.ts", "if (!claimed.ok || !Array.isArray(claimed.value)) return", "if (!claimed.ok) return", "ارزشِ غیرِ آرایه بررسی نمی‌شود")
m("sweeper.ts", "if (!claimed.ok || !Array.isArray(claimed.value)) return", "if (!Array.isArray(claimed.value)) return", "شکستِ claimDue نادیده گرفته می‌شود")
m("sweeper.ts", "const leaseEndMs = cfg.leaseMs === null ? null : now + cfg.leaseMs;", "const leaseEndMs = cfg.leaseMs === null ? null : now + cfg.leaseMs + 1;", "پایانِ اجاره یک میلی‌ثانیه دیرتر")
m("sweeper.ts", "const leaseEndMs = cfg.leaseMs === null ? null : now + cfg.leaseMs;", "const leaseEndMs = cfg.leaseMs === null ? null : now;", "پایانِ اجاره = لحظهٔ گرفتن")
m("sweeper.ts", "const leaseEndMs = cfg.leaseMs === null ? null : now + cfg.leaseMs;", "const leaseEndMs = null;", "بررسیِ اجاره هرگز اجرا نمی‌شود")
m("sweeper.ts", "return t !== null && t < leaseEndMs;", "return t !== null && t <= leaseEndMs;", "در لحظهٔ پایانِ اجاره هنوز اجاره برقرار است")
m("sweeper.ts", "return t !== null && t < leaseEndMs;", "return t === null || t < leaseEndMs;", "ساعتِ خراب ⇒ اجاره برقرار")
m("sweeper.ts", "return t !== null && t < leaseEndMs;", "return true;", "اجاره همیشه برقرار")
m("sweeper.ts", "return t !== null && t < leaseEndMs;", "return false;", "اجاره هرگز برقرار نیست")
m("sweeper.ts", "          step = { kind: \"raced\" };\n        } else {", "          step = { kind: \"retry\" };\n        } else {", "رکوردِ رهاشده retry حساب می‌شود نه raced")
m("sweeper.ts", "          step = { kind: \"raced\" };\n        } else {", "          step = { kind: \"outbox-failure\" };\n        } else {", "رکوردِ رهاشده outboxFailure حساب می‌شود")
m("sweeper.ts", "examined: entries.length,", "examined: entries.length + 1,", "شمارِ examined غلط")
# ── config.ts
m("config.ts", "if (!isLeaseMs(leaseMs)) issues.push(", "if (false) issues.push(", "leaseMs نامعتبر پذیرفته می‌شود")
m("config.ts", "if (!hasFns(raw[\"outbox\"], [\"claimDue\"])) issues.push(", "if (false) issues.push(", "outboxِ بی‌claimDue با leaseMs پذیرفته می‌شود")
m("config.ts", "\"retryDelayMs\", \"leaseMs\"]);", "\"retryDelayMs\"]);", "leaseMs از فهرستِ کلیدهای مجاز حذف می‌شود")
m("config.ts", "leaseMs: leaseMs === undefined ? null : (leaseMs as number),", "leaseMs: null,", "leaseMs هرگز به رفتگر نمی‌رسد")
m("config.ts", "leaseMs: leaseMs === undefined ? null : (leaseMs as number),", "leaseMs: leaseMs === undefined ? 1_000 : (leaseMs as number),", "پیش‌فرضِ ناخواستهٔ اجاره")
m("config.ts", "  maxLeaseMs: LEASE_MS_MAX,\n", "  maxLeaseMs: 1,\n", "سقفِ اجارهٔ صادرشده ناهمخوان")

EQUIVALENT: dict[int, str] = {
    12: "رکوردِ گرفته‌شده همیشه `dueAtMs ≤ nowMs` دارد (شرطِ فیلتر)، پس `Math.max(dueAtMs, nowMs)` همیشه `nowMs` است؛ جهش رفتارِ قابل‌مشاهده‌ای ندارد.",
    48: "نتیجهٔ ناموفقِ outbox کلیدِ `value` ندارد، پس `Array.isArray(undefined)` ناراست است و همان `listFailed` برمی‌گردد؛ بررسیِ `!claimed.ok` خطِ دفاعِ صریح است (مثلِ جهشِ ۳۵ در ADR-0028).",
}

env = dict(os.environ)
if not (env.get("KB_TEST_DATABASE_URL") or env.get("DATABASE_URL")):
    print("پایگاه تنظیم نشده است (DATABASE_URL)."); sys.exit(2)


def tests_pass(tests):
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *tests, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
for i, (f, old, new, why, _t) in enumerate(M):  # پیش‌بازرسی
    src = open(os.path.join(ROOT, B, f), encoding="utf8").read()
    if src.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {f}: {old[:70]!r}"); sys.exit(2)
    if new == old:
        print(f"[{i}] جهش بی‌اثر است: {f}: {why}"); sys.exit(2)
if not tests_pass(NEW_TESTS):
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why, tests) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, B, f)
    src = open(path, encoding="utf8").read()
    open(path, "w", encoding="utf8").write(src.replace(old, new, 1))
    try:
        ok = tests_pass(tests)
    finally:
        open(path, "w", encoding="utf8").write(src)
    if ok and i not in EQUIVALENT:
        alive.append((i, f, why)); print(f"[{i:02d}] ✗ زنده: {f} — {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {f} — {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
