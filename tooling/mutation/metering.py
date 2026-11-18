#!/usr/bin/env python3
"""
آزمون جهشی ماژول metering (ADR-0020): هر جهش یک تغییر کوچکِ معناداری در کد منبع است؛ مجموعهٔ آزمون باید قرمز شود (جهش «کشته شود»).
اجرا:  python3 tooling/mutation/metering.py        (بدون پایگاه؛ تست‌های حافظه‌ای کافی‌اند)
جهش زنده = ضعفِ آزمون، مگر با دلیل در فهرست EQUIVALENT مستند شود. فایل اصلی همیشه پس از هر جهش برمی‌گردد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = "src/modules/metering/"
M = [
    # (فایل، قطعهٔ اصلی، جایگزین، توضیح)
    ("metered-gateway.ts", 'if (reserved.value.replayed) return refused("SCOPE_REUSED");', "", "بی‌SCOPE_REUSED"),
    ("metered-gateway.ts", "const n = ++counter;", "const n = counter;", "شناسهٔ ثابت"),
    ("metered-gateway.ts", "export const SETTLE_ATTEMPTS = 3;", "export const SETTLE_ATTEMPTS = 1;", "بی‌تکرار تسویه"),
    ("metered-gateway.ts", "if (last.ok || !TRANSIENT.has(last.error.code)) return last;", "if (last.ok) return last;", "تکرار خطای غیرگذرا"),
    ("metered-gateway.ts", 'const remainder = observed.kind === "none" ? "release" : cfg.onUnknownCost;', "const remainder = cfg.onUnknownCost;", "بی‌تماس هم سیاست می‌گیرد"),
    ("metered-gateway.ts", 'const remainder = observed.kind === "none" ? "release" : cfg.onUnknownCost;', 'const remainder = "release";', "سیاست نادیده"),
    ("metered-gateway.ts", "if (observed.lowerBound > 0) {", "if (false) {", "کفِ معلوم مصرف نمی‌شود"),
    ("metered-gateway.ts", 'if (ch.value.shortfall > 0) alarms.push("SHORTFALL");\n      const cl', "const cl", "بی‌زنگ SHORTFALL (معلوم)"),
    ("metered-gateway.ts", 'if (!cl.ok) alarms.push("CLOSE_PENDING");', "", "بی‌زنگ CLOSE_PENDING"),
    ("metered-gateway.ts", 'if (ch.error.code === "RESERVATION_EXPIRED") return receipt({ ...base, outcome: "unbilled", charged: 0, shortfall: 0, alarms: ["UNBILLED"] });', "", "انقضا = تسویهٔ معلق"),
    ("metered-gateway.ts", "await cfg.gateway.complete(snap.request, options)", "await cfg.gateway.complete(input, options)", "ورودی اصلی (TOCTOU)"),
    ("metered-gateway.ts", "await cfg.gateway.complete(snap.request, options)", "await cfg.gateway.complete(snap.request)", "signal افتاد"),
    ("metered-gateway.ts", 'if (c === "INSUFFICIENT_CREDIT" || c === "ACCOUNT_NOT_FOUND" || c === "TOO_MANY_OPEN_RESERVATIONS") return refused(c, c);', 'if (c === "INSUFFICIENT_CREDIT" || c === "TOO_MANY_OPEN_RESERVATIONS") return refused(c, c);', "ACCOUNT_NOT_FOUND گم"),
    ("metered-gateway.ts", 'if (c === "IDEMPOTENCY_CONFLICT") return refused("SCOPE_REUSED", c);', "", "IDEMPOTENCY_CONFLICT گم"),
    ("metered-gateway.ts", 'message: REFUSAL_MESSAGES[code], retryable: false', "message: REFUSAL_MESSAGES[code], retryable: true", "ردِ اندازه‌گیری قابل‌تکرار"),
    ("estimate.ts", "bytes += enc.encode(c).length;", "bytes += c.length;", "نویسه به‌جای بایت"),
    ("estimate.ts", "perMessageOverheadTokens * contents.length", "perMessageOverheadTokens", "سربار یک‌بار"),
    ("estimate.ts", "if (cost > perCall) perCall = cost;", "if (cost < perCall || perCall === 0) perCall = cost;", "کمینه به‌جای بیشینه"),
    ("estimate.ts", "const total = perCall * i.maxProviderCalls;", "const total = perCall;", "بی‌ضرب تماس‌ها"),
    ("estimate.ts", "Math.max(1, total)", "total", "بی‌حداقل ۱"),
    ("estimate.ts", "if (i.maxOutputTokens > primary.maxOutputTokens)", "if (i.maxOutputTokens >= primary.maxOutputTokens)", "مرز سقف خروجی"),
    ("estimate.ts", "if (spec.price.currency !== i.currency) return", "if (false) return", "ارز نادیده"),
    ("estimate.ts", "i.contents.length > REQUEST_LIMITS.maxMessages", "i.contents.length >= REQUEST_LIMITS.maxMessages", "مرز ۶۴ پیام"),
    ("estimate.ts", "if (!Number.isSafeInteger(total)) return", "if (false) return", "سرریز ضرب"),
    ("cost.ts", 'if (r["costUnknownAttempts"] > 0) return unknown("report-unknown", lb);', "", "تلاش نامعلوم نادیده"),
    ("cost.ts", 'if (reached === 0 && (r["spend"] as unknown[]).length === 0) return { kind: "none" };', "", "بی‌تماس ≠ هیچ"),
    ("cost.ts", '["INVALID_REQUEST", "UNKNOWN_MODEL", "INVALID_CONFIG"]', '["INVALID_REQUEST", "INVALID_CONFIG"]', "UNKNOWN_MODEL گم"),
    ("cost.ts", 'if (cost["currency"] !== currency) return unknown("currency");', "", "ارز cost نادیده"),
    ("cost.ts", 's["currency"] !== currency || !isCount(s["micros"])) continue;', "!isCount(s[\"micros\"])) continue;", "کف: ارز نادیده"),
    ("cost.ts", '    total += s["micros"];\n    if (!Number.isSafeInteger(total)) return unknown("bad-amount", lb);', '    total = s["micros"];', "جمع نه، آخرین"),
    ("cost.ts", 'if ((r["spend"] as unknown[]).length === 0) return unknown("report-inconsistent", 0);', "", "ناسازگاری ⇒ صفر"),
    ("config.ts", "isIntIn(raw[\"maxProviderCalls\"], 1, CONFIG_LIMITS.maxProviderCalls)", "isIntIn(raw[\"maxProviderCalls\"], 0, CONFIG_LIMITS.maxProviderCalls)", "maxProviderCalls=۰"),
    ("config.ts", " || scopeId.length > CONFIG_LIMITS.maxScopeIdChars", "", "طول scopeId"),
    ("config.ts", 'raw["onUnknownCost"] !== "forfeit" && raw["onUnknownCost"] !== "release"', "false", "onUnknownCost اختیاری"),
    ("config.ts", "if (!hasFns(raw[\"ledger\"], [\"reserve\", \"charge\", \"close\"]))", "if (false)", "ledger بی‌اعتبارسنجی"),
]
# جهش‌های هم‌ارز مستند: ندارد. (دور نخست یک زنده داشت: شاخهٔ «release + منقضی» کدِ مرده بود چون close(release) روی رزروِ منقضی موفق است؛ شاخه حذف شد.) (هر جهشِ زنده باید تست بگیرد یا اینجا با دلیل ثبت شود).
EQUIVALENT: dict[int, str] = {}

env = {k: v for k, v in os.environ.items() if k not in ("KB_TEST_DATABASE_URL", "DATABASE_URL", "CI")}
env["KB_TEST_DATABASE_URL"] = ""
env["DATABASE_URL"] = ""

def tests_pass() -> bool:
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", D, "--reporter=dot"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=300)
    return r.returncode == 0

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    path = os.path.join(ROOT, D, f)
    src = open(path, encoding="utf8").read()
    if src.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {f}: {old[:60]}"); sys.exit(2)
    open(path, "w", encoding="utf8").write(src.replace(old, new, 1))
    try:
        ok = tests_pass()
    finally:
        open(path, "w", encoding="utf8").write(src)
    if ok and i not in EQUIVALENT:
        alive.append((i, f, why)); print(f"[{i:02d}] ✗ زنده: {f} — {why}")
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {f} — {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}")
print(f"\nجهش‌ها: {len(M)} | کشته: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
