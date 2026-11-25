#!/usr/bin/env python3
"""
آزمون جهشی «منبع تازه‌شوندهٔ سیاستِ ابزار» (ماژول tool-policy-source؛ برش CT-5c-2c-1، ADR-0071): هر جهش یک تغییر کوچکِ معنادار در منبعِ ماژول است
و باید دست‌کم یک آزمون را قرمز کند؛ جهشِ زنده یعنی آزمونی کم است (یا کدِ زائد).
اجرا:  python3 tooling/mutation/tool-policy-source.py            (همه)
       python3 tooling/mutation/tool-policy-source.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22؛ بی‌پایگاه (آزمونِ PG جزوِ مجموعه نیست؛ همهٔ رفتارها بی‌پایگاه قابل‌سنجش‌اند). جزو CI نیست. فایل‌ها پس از هر جهش همیشه برمی‌گردند؛
پیش‌بازرسی: متنِ اصلیِ هر جهش دقیقاً یک بار (یا بیشتر؛ فقط اولین جایگزین می‌شود).
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B = "src/modules/tool-policy-source/"
TESTS = [B, "tooling/tool-policy-source-source.test.ts", "tooling/tool-policy-source-admin.test.ts"]
M = []


def m(f, old, new, why):
    M.append((f, old, new, why))


SR, EV, CF = "source.ts", "evaluate.ts", "config.ts"
# ── source.ts
m(SR, "age > maxStaleMs ? \"STALE\"", "age >= maxStaleMs ? \"STALE\"", "سقفِ سن یک واحد زودتر بسته می‌شود")
m(SR, "age > maxStaleMs ? \"STALE\"", "age > maxStaleMs + 1 ? \"STALE\"", "سقفِ سن یک واحد دیرتر")
m(SR, "age > maxStaleMs ? \"STALE\" : \"FRESH\"", "\"FRESH\"", "هرگز STALE نمی‌شود")
m(SR, "t === null || t < held.confirmedAtMs", "t === null", "ساعتِ رو به عقب پذیرفته می‌شود")
m(SR, "t - cur.startedAtMs <= refreshTimeoutMs", "t - cur.startedAtMs < refreshTimeoutMs", "مرزِ رهاکردنِ تلاش یک واحد زودتر")
m(SR, "t - cur.startedAtMs <= refreshTimeoutMs", "true", "تلاشِ بی‌پاسخ هرگز رها نمی‌شود")
m(SR, "t >= cur.startedAtMs && ", "", "ساعتِ رو به عقب تلاشِ در جریان را شریک می‌کند")
m(SR, "if (cur !== null && ", "if (false && cur !== null && ", "هم‌زمان‌ها شریک نیستند")
m(SR, "if (inflight === null || inflight.id !== attempt.id) return rfail(\"SUPERSEDED\");", "", "نتیجهٔ تلاشِ رهاشده حالت را می‌گیرد")
m(SR, "inflight = attempt; // پیش از run", "// پیش از run", "تلاشِ تازه ثبت نمی‌شود")
m(SR, "if (readFailed) return noteFailure(\"READ_FAILED\", attempt.startedAtMs);", "", "شکستِ خواندن نادیده گرفته می‌شود")
m(SR, "confirmedAtMs: attempt.startedAtMs };", "confirmedAtMs: attempt.startedAtMs + 1 };", "تأیید از پایان/بعد از شروع")
m(SR, "d.outcome === \"unchanged\" && held !== null ? held.loadedAtMs : attempt.startedAtMs", "attempt.startedAtMs", "loadedAt با هر تأیید جلو می‌رود")
m(SR, "    failures = 0;\n    lastFailure = null;\n    lastAttemptAtMs = attempt.startedAtMs;", "    lastFailure = null;\n    lastAttemptAtMs = attempt.startedAtMs;", "شمارندهٔ شکست پس از موفقیت پاک نمی‌شود")
m(SR, "    failures += 1;\n    lastFailure = code;", "    lastFailure = code;", "شمارندهٔ شکست نمی‌شمارد")
m(SR, "if (d.kind === \"reject\") return noteFailure(d.code, attempt.startedAtMs);", "", "ردِ داور نادیده گرفته می‌شود")
m(SR, "if (t === null) return Promise.resolve(noteFailure(\"INVALID_CLOCK\", null));", "", "ساعتِ نامعتبر در refresh نادیده گرفته می‌شود")
m(SR, "return validNow(v) ? v : null;", "return typeof v === \"number\" ? v : null;", "ساعتِ NaN/منفی/اعشاری پذیرفته می‌شود")
m(SR, "if (c.state !== \"FRESH\" || held === null || c.ageMs === null) return", "if (held === null) return", "snapshot کهنه/ساعتِ خراب هم داده می‌دهد")
m(SR, "const snap: PolicySnapshot = Object.freeze({", "const snap: PolicySnapshot = ({", "snapshot یخ‌زده نیست")
m(SR, "return { ok: true, value: Object.freeze({ outcome: d.outcome, version: c.version }) };", "return { ok: true, value: { outcome: d.outcome, version: c.version } };", "نتیجهٔ refresh یخ‌زده نیست")
# ── evaluate.ts
m(EV, "if (cand.version < held.version) return reject(\"VERSION_REGRESSED\");", "", "عقب‌گرد نسخه پذیرفته می‌شود")
m(EV, "if (cand.version < held.version)", "if (cand.version <= held.version - 0 && cand.version < held.version - 1)", "عقب‌گردِ یک نسخه‌ای پذیرفته می‌شود")
m(EV, "    if (cand.fingerprint !== held.fingerprint) return reject(\"VERSION_CONTENT_MISMATCH\");\n", "", "همان نسخه با محتوای دیگر پذیرفته می‌شود")
m(EV, "if (cand.fingerprint !== held.fingerprint) return", "if (false) return", "اثرانگشتِ محتوا مقایسه نمی‌شود")
m(EV, "if ((version === 0) !== (source === \"defaults\")) return bad(\"INVALID_RESPONSE\");", "", "نسخه/منبعِ ناسازگار پذیرفته می‌شود")
m(EV, "if (typeof drift !== \"boolean\") return bad(\"INVALID_RESPONSE\");", "", "drift غیرِ بولی پذیرفته می‌شود")
m(EV, "|| !Number.isSafeInteger(version) || version < 0) return bad", "|| version < 0) return bad", "نسخهٔ اعشاری/بی‌کران پذیرفته می‌شود")
m(EV, "|| version < 0) return bad(\"INVALID_RESPONSE\");", ") return bad(\"INVALID_RESPONSE\");", "نسخهٔ منفی پذیرفته می‌شود")
m(EV, "if (typeof policy !== \"object\" || policy === null || Array.isArray(policy)) return bad(\"PROJECTION_INVALID\");", "", "سیاستِ غایب با پیش‌فرض پر می‌شود")
m(EV, "|| stable(resolved.value) !== stable(policy)) return", ") return", "سیاستِ ناقص (نقطهٔ غیرِ ثابت) بی‌صدا با پیش‌فرض پر می‌شود")
m(EV, "code === \"STORED_POLICY_INVALID\" ? \"STORED_POLICY_INVALID\" : \"READ_FAILED\"", "\"READ_FAILED\"", "کدِ STORED_POLICY_INVALID گم می‌شود")
m(EV, "if (typeof code !== \"string\") return bad(\"INVALID_RESPONSE\");", "", "خطای بی‌کد پذیرفته می‌شود")
m(EV, "if (flag !== true) return bad(\"INVALID_RESPONSE\");", "", "پاسخِ بی‌ok پذیرفته می‌شود")
m(EV, "if (held === null) return { kind: \"accept\", outcome: \"loaded\"", "if (held === null) return { kind: \"accept\", outcome: \"updated\"", "نتیجهٔ بارِ نخست loaded نیست")
m(EV, "const resolved = resolveToolPolicy(policy);", "const resolved = { ok: true as const, value: policy as never };", "سیاست بی‌اعتبارسنجیِ resolve نگاشت می‌شود")
m(EV, "} catch {\n    read = bad(\"INVALID_RESPONSE\");", "} catch {\n    read = bad(\"READ_FAILED\");", "پرتابِ هنگامِ خواندنِ پاسخ ⇒ کدِ اشتباه")
m(EV, "if (Array.isArray(v)) return `[${v.map(stable).join(\",\")}]`;", "if (Array.isArray(v)) return \"[]\";", "stable آرایه‌ها را نادیده می‌گیرد")
m(EV, ".sort()\n", "\n", "stable به ترتیبِ کلید حساس می‌شود")
# ── config.ts
m(CF, "refreshTimeoutMs > maxStaleMs", "refreshTimeoutMs >= maxStaleMs", "رابطهٔ مرزی یک واحد سخت‌تر")
m(CF, "refreshTimeoutMs > maxStaleMs", "false", "رابطهٔ refreshTimeoutMs ≤ maxStaleMs حذف می‌شود")
m(CF, "min: 1_000, max: 86_400_000", "min: 0, max: 86_400_000", "کفِ maxStaleMs صفر")
m(CF, "min: 1_000, max: 86_400_000", "min: 1_000, max: 86_400_001", "سقفِ maxStaleMs یک واحد بیشتر")
m(CF, "min: 100, max: 300_000", "min: 99, max: 300_000", "کفِ refreshTimeoutMs یک واحد کمتر")
m(CF, "min: 100, max: 300_000", "min: 100, max: 300_001", "سقفِ refreshTimeoutMs یک واحد بیشتر")
m(CF, "for (const k of own) if (!(KEYS as readonly string[]).includes(k)) issues.push", "for (const k of own) if (false) issues.push", "کلیدِ ناشناخته پذیرفته می‌شود")
m(CF, "issues.push(`unknown:${k.length <= 40 ? k : \"?\"}`)", "issues.push(`unknown:${k}`)", "نامِ کلیدِ بلند بازتاب می‌شود")
m(CF, "if (typeof current !== \"function\") issues.push(\"reader.current\");", "", "reader بی‌current پذیرفته می‌شود")
m(CF, "if (typeof nowMs !== \"function\") issues.push(\"clock.nowMs\");", "", "clock بی‌nowMs پذیرفته می‌شود")
m(CF, "const fnCurrent = current as () => Promise<unknown>;\n  const fnNow = nowMs as () => unknown;", "const fnCurrent = () => (reader as { current: () => Promise<unknown> }).current();\n  const fnNow = () => (clock as { nowMs: () => unknown }).nowMs();", "توابع دوباره از شیء خوانده می‌شوند (نه یک‌بار)")
m(CF, "read: () => fnCurrent.call(reader) as Promise<unknown>,", "read: () => fnCurrent.call(undefined) as Promise<unknown>,", "this خواننده گم می‌شود")
m(CF, "Array.isArray(options)", "false", "آرایه به‌عنوان گزینه پذیرفته می‌شود")


def run_tests():
    return subprocess.run(["npx", "vitest", "run", *TESTS], cwd=ROOT, env=dict(os.environ), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode


def main():
    lo, hi = 1, len(M)
    if len(sys.argv) >= 3:
        lo, hi = int(sys.argv[1]), int(sys.argv[2])
    for i, (f, old, new, why) in enumerate(M, 1):
        src = open(os.path.join(ROOT, B + f), encoding="utf-8").read()
        if src.count(old) < 1:
            print(f"پیش‌بازرسی: جهش {i} ({f}) متنِ اصلی را پیدا نکرد: {old[:60]!r}")
            sys.exit(2)
    if run_tests() != 0:
        print("آزمون‌ها بدونِ جهش قرمزند؛ ابتدا درست کنید.")
        sys.exit(2)
    live = []
    for i, (f, old, new, why) in enumerate(M, 1):
        if not (lo <= i <= hi):
            continue
        path = os.path.join(ROOT, B + f)
        src = open(path, encoding="utf-8").read()
        try:
            open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
            killed = run_tests() != 0
        finally:
            open(path, "w", encoding="utf-8").write(src)
        print(f"{'کشته  ' if killed else 'زنده! '} {i:3d}  {f:12s} {why}", flush=True)
        if not killed:
            live.append((i, f, why))
    print(f"\nجهش‌ها: {hi - lo + 1}  زنده: {len(live)}")
    for i, f, why in live:
        print(f"  زنده: {i} {f} — {why}")
    sys.exit(1 if live else 0)


if __name__ == "__main__":
    main()
