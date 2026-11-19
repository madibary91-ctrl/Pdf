#!/usr/bin/env python3
"""
آزمون جهشی «همسوییِ پرریسک با registry» (برش م۳‑ه؛ ADR-0027): هر جهش یک تغییر کوچکِ معنادار در `tooling/git-discipline.ts`، `docs/high-risk-areas.md`
یا خودِ بازرسیِ آزمون است؛ `tooling/high-risk-registry-sync.test.ts` باید قرمز شود.
اجرا:  python3 tooling/mutation/high-risk-registry-sync.py            (همه)
       python3 tooling/mutation/high-risk-registry-sync.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22؛ پایگاه لازم نیست؛ جزو CI نیست. فقط Python 3 استاندارد.
پیش از اجرا «پیش‌بازرسی» می‌کند که متن اصلیِ همهٔ جهش‌ها هست؛ فایل اصلی پس از هر جهش همیشه برمی‌گردد.
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GD = "tooling/git-discipline.ts"
DOC = "docs/high-risk-areas.md"
TST = "tooling/high-risk-registry-sync.test.ts"
TESTS = [TST]
M = []
RX = 'new RegExp(`^src/modules/(${HIGH_RISK_MODULES.join("|")})/`)'


def m(f, old, new, why):
    M.append((f, old, new, why))


# ── فهرست: حذفِ هر ماژولِ humanReview (۱۱ ماژولِ شکافِ ۰۰۲۶ + چند ماژولِ پیشین)
for name in ["metering", "settlement", "ai-orchestrator", "doc-templates-core", "legal-kb-ingest", "eval-set", "doc-editing-tools", "desktop-shell", "desktop-backup", "desktop-license", "desktop-updater", "ledger", "jalali-date", "api"]:
    m(GD, f'  "{name}",\n', "", f"«{name}» از HIGH_RISK_MODULES افتاده")
# ── فهرست: افزودنِ شبح / تکرار / نام نامعتبر
m(GD, '  "desktop-updater",\n];', '  "desktop-updater",\n  "desktop-updatre",\n];', "نامِ شبح (غلط املایی)")
m(GD, '  "desktop-updater",\n];', '  "desktop-updater",\n  "api",\n];', "نامِ تکراری")
m(GD, '  "desktop-updater",\n];', '  "desktop-updater",\n  "Desktop_Updater",\n];', "نامِ نامعتبر")
m(GD, '  "desktop-updater",\n];', '  "desktop-updater",\n  "persian-text",\n];', "ماژولِ بی‌بازبینی بی‌استثنا")
# ── استثناها
m(GD, '  "shared-types": "قرارداد', '  "shared-types-x": "قرارداد', "استثنا کهنه/ناشناس و shared-types بی‌استثنا")
m(GD, '  "legal-kb-store": "مهاجرتِ', '  "legal-kb-store-x": "مهاجرتِ', "استثنا کهنه/ناشناس و legal-kb-store بی‌استثنا")
m(GD, '"قرارداد مشترکِ همهٔ ماژول‌ها (AGENTS بند ۶)؛ تغییرش بی‌تأییدِ معماری ممنوع است."', '"کوتاه"', "دلیلِ استثنا کوتاه")
m(GD, '  "shared-types": "قرارداد مشترکِ همهٔ ماژول‌ها (AGENTS بند ۶)؛ تغییرش بی‌تأییدِ معماری ممنوع است.",\n', "", "استثنای shared-types حذف")
m(GD, '  "legal-kb-store",\n', "", "legal-kb-store از فهرست افتاده ولی استثنا مانده")
# ── regex و مسیر
m(GD, RX, RX.replace("`^src", "`src"), "لنگرِ ابتدای regex")
m(GD, RX, RX.replace(")/`)", ")`)"), "اسلشِ پایانی regex (هم‌پیشوندها)")
m(GD, RX, RX.replace("HIGH_RISK_MODULES.join", "HIGH_RISK_MODULES.slice(0, -1).join"), "آخرین نام در regex نیست")
m(GD, RX, RX.replace("HIGH_RISK_MODULES.join", "HIGH_RISK_MODULES.slice(1).join"), "نخستین نام در regex نیست")
m(GD, "if (isTestPath(path) || /\\.md$/.test(path)) return false;", "if (isTestPath(path)) return false;", "README پرریسک می‌شود")
m(GD, "if (isTestPath(path) || /\\.md$/.test(path)) return false;", "if (/\\.md$/.test(path)) return false;", "آزمون پرریسک می‌شود")
m(GD, "  /^src\\/modules\\/registry\\.ts$/,\n", "", "registry.ts پرریسک نیست")
# ── سند
m(DOC, "| `src/modules/settlement/` —", "| `src/modules/settlemen/` —", "ردیفِ settlement در سند")
m(DOC, "| `src/modules/metering/` |", "| `src/modules/meterin/` |", "ردیفِ metering در سند")
m(DOC, "| `src/modules/ai-orchestrator/` |", "| `src/modules/ai-orchestratr/` |", "ردیفِ ai-orchestrator در سند")
m(DOC, "| `src/modules/desktop-updater/` |", "| `src/modules/desktop-updatr/` |", "ردیفِ desktop-updater در سند")
m(DOC, "| `src/modules/eval-set/` |", "| `src/modules/evalset/` |", "ردیفِ eval-set در سند")
# ── خودِ بازرسی (آزمونِ آزمون)
m(TST, "if (!a.isRisk(`src/modules/${n}/index.ts`)) problems.push(", "if (false) problems.push(", "بازرسی: registry ⇒ regex خاموش")
m(TST, "if (info === undefined) problems.push(", "if (false) problems.push(", "بازرسی: شبح خاموش")
m(TST, "else if (!info.humanReview && !(n in a.beyond)) problems.push(", "else if (false) problems.push(", "بازرسی: بی‌استثنا خاموش")
m(TST, "if (why.trim().length < 10) problems.push(", "if (false) problems.push(", "بازرسی: دلیلِ استثنا خاموش")
m(TST, "if (!a.riskModules.includes(n)) problems.push(`استثنای", "if (false) problems.push(`استثنای", "بازرسی: استثنای بیرون از فهرست خاموش")
m(TST, "if (info !== undefined && info.humanReview) problems.push(", "if (false) problems.push(", "بازرسی: استثنای کهنه خاموش")
m(TST, "if (!documented.has(n)) problems.push(", "if (false) problems.push(", "بازرسی: سند خاموش")
m(TST, "if (!NAME_RE.test(n)) problems.push(", "if (false) problems.push(", "بازرسی: اعتبارِ نام خاموش")
m(TST, "    if (seen.has(n)) problems.push(", "    if (false) problems.push(", "بازرسی: تکرار خاموش")
m(TST, "s.startsWith(`src/modules/${name}/`)", "s.includes(name)", "بازرسی: ذکرِ سند با زیررشته")
m(TST, "s === name ||", "s.startsWith(name) ||", "بازرسی: نامِ باز با پیشوند")
m(TST, " || s === `${name}/`", "", "بازرسی: شکلِ نام با اسلش")
m(TST, "const reviewed = a.modules.filter((x) => x.humanReview)", "const reviewed = a.modules.filter((x) => !x.humanReview)", "بازرسی: معکوسِ humanReview")

EQUIVALENT: dict[int, str] = {}


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TESTS, "--reporter=dot", "--bail=1"], cwd=ROOT, capture_output=True, text=True, timeout=300)
    return r.returncode == 0


lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
for i, (f, old, new, why) in enumerate(M):  # پیش‌بازرسی
    src = open(os.path.join(ROOT, f), encoding="utf8").read()
    if src.count(old) < 1:
        print(f"[{i}] قطعه پیدا نشد: {f}: {old[:70]!r}"); sys.exit(2)
if not tests_pass():
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

killed, alive = 0, []
for i, (f, old, new, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    path = os.path.join(ROOT, f)
    src = open(path, encoding="utf8").read()
    open(path, "w", encoding="utf8").write(src.replace(old, new, 1))
    try:
        ok = tests_pass()
    finally:
        open(path, "w", encoding="utf8").write(src)
    if ok:
        if i in EQUIVALENT:
            print(f"[{i}] هم‌ارز ({EQUIVALENT[i]}): {why}")
        else:
            alive.append(i); print(f"[{i}] ✘ زنده: {why}")
    else:
        killed += 1; print(f"[{i}] ✔ کشته: {why}")

print(f"\nکشته: {killed} | زنده: {len(alive)} | هم‌ارز: {len([i for i in EQUIVALENT if lo <= i <= hi])} | کل: {hi - lo + 1}")
sys.exit(1 if alive else 0)
