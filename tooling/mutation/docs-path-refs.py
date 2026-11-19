#!/usr/bin/env python3
"""
آزمون جهشی «نگهبانِ راستیِ ارجاع‌های مستنداتِ زنده» (برش م۳‑ه‑۳‑ز، ADR-0038) روی `tooling/docs-path-refs.test.ts`. دو خانواده جهش:
  الف) جهشِ پویشگر (توابعِ خالص درونِ همان فایل): هر جهش یک تغییرِ کوچکِ معنادار است و باید دست‌کم یک آزمونِ فایل را قرمز کند؛
  ب) تزریقِ رانش در مستندات/مخزنِ واقعی (ارجاعِ معلق، اسکریپتِ حذف‌شده، npm run ناموجود، ماژولِ آیندهٔ بی‌registry، بازگرداندنِ اسکریپتِ منسوخ…):
     نگهبان باید روی **درختِ واقعی** قرمز شود (نه فقط روی نمونهٔ ساختگی). جهشِ زنده یعنی آزمونی کم است.
اجرا:  python3 tooling/mutation/docs-path-refs.py            (همه)
       python3 tooling/mutation/docs-path-refs.py 3 9        (فقط جهش‌های ۳ تا ۹)
نیاز: Node ≥ 22؛ پایگاه لازم نیست؛ جزو CI نیست. پیش از هر اجرا پیش‌بازرسی می‌کند که متنِ اصلیِ جهش‌های «الف» هست؛ همهٔ فایل‌ها پس از هر جهش دقیقاً برمی‌گردند
(فایلِ ناموجودِ اولیه دوباره حذف می‌شود).
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
T = "tooling/docs-path-refs.test.ts"
TEST = [T]
# (شماره، نوع، فایل، آرگومان‌ها، دلیل) — نوع: replace | append | create | delete
M = []


def rep(old, new, why):
    M.append(("replace", T, (old, new), why))


def app(f, text, why):
    M.append(("append", f, (text,), why))


def create(f, text, why):
    M.append(("create", f, (text,), why))


def delete(f, why):
    M.append(("delete", f, (), why))


# ── الف) جهش‌های پویشگر ─────────────────────────────────────────────────────────────────────────────────
rep('const ROOTED = /^(?:src|tooling|docs|public|\\.github)\\//;', 'const ROOTED = /^(?:src|docs|public|\\.github)\\//;', "tooling از ریشه‌ها حذف می‌شود (نامِ کوتاه می‌تواند حذفِ فایلِ tooling را بپوشاند)")
rep('  if (ROOTED.test(ref)) return false;\n', '', "سخت‌گیریِ مسیرِ ریشه‌دار حذف می‌شود (نسخهٔ تودرتوی هم‌نام نجاتش می‌دهد)")
rep('const FILE_EXTENSIONS = /[\\w@-]\\.(?:', 'const FILE_EXTENSIONS = /\\.(?:', "خودِ `.ts` فایل شمرده می‌شود")
rep('const NOT_A_PATH = /[\\s*<>{}$()|=,;:?[\\]…"\'\\\\]|NNNN/;', 'const NOT_A_PATH = /[\\s<>{}$()|=,;:?[\\]…"\'\\\\]|NNNN/;', "glob (`*`) مسیر شمرده می‌شود")
rep('const NOT_A_PATH = /[\\s*<>{}$()|=,;:?[\\]…"\'\\\\]|NNNN/;', 'const NOT_A_PATH = /[\\s*<>{}$()|=,;:?[\\]…"\'\\\\]/;', "جایگزینِ NNNN مسیر شمرده می‌شود")
rep('const NOT_A_PATH = /[\\s*<>{}$()|=,;:?[\\]…"\'\\\\]|NNNN/;', 'const NOT_A_PATH = /[*<>{}$()|=,;:?[\\]…"\'\\\\]|NNNN/;', "span با فاصله (فرمان) مسیر شمرده می‌شود")
rep('const NOT_A_PATH = /[\\s*<>{}$()|=,;:?[\\]…"\'\\\\]|NNNN/;', 'const NOT_A_PATH = /[\\s*<>{}$()|=,;?[\\]…"\'\\\\]|NNNN/;', "آدرسِ اینترنتی (`https://…`) مسیر شمرده می‌شود")
rep('  if (s.startsWith("@/")) s = `src/${s.slice(2)}`;\n', '', "نامِ مستعارِ `@/` به src تبدیل نمی‌شود")
rep('  if (GENERATED.test(s)) return null;\n', '', "خروجی‌های تولیدی (`.next/`، `node_modules/`) مسیر شمرده می‌شوند")
rep('  if (s.startsWith("/") || s.includes("..")) return null;\n', '  if (s.startsWith("/")) return null;\n', "مسیرِ با `..` پذیرفته می‌شود")
rep('  if (s.startsWith("/") || s.includes("..")) return null;\n', '  if (s.includes("..")) return null;\n', "مسیرِ مطلق پذیرفته می‌شود")
rep('    if (line.trimStart().startsWith("```")) {\n      inFence = !inFence;\n      continue;\n    }', '    if (line.trimStart().startsWith("```")) continue;', "بلوکِ کد جدا نمی‌شود")
rep('  for (const m of fenced.matchAll(', '  for (const m of "".matchAll(', "مسیرهای بلوکِ کد پویش نمی‌شوند")
rep('  for (const m of prose.matchAll(/`([^`\\n]+)`/g)) {', '  for (const m of "".matchAll(/`([^`\\n]+)`/g)) {', "spanهای متنِ عادی پویش نمی‌شوند")
rep('\\bnpm run (?:-s |--silent )?([A-Za-z]', '\\bnpm run ([A-Za-z]', "گزینهٔ `-s` در `npm run -s x` شناخته نمی‌شود")
rep('([A-Za-z][\\w:.-]*)/g)) out.push(m[1] ?? "");', '([A-Za-z][\\w.-]*)/g)) out.push(m[1] ?? "");', "نامِ اسکریپتِ دونقطه‌ای (`settlement:migrate`) بریده می‌شود")
rep('    for (const ref of new Set(extractRefs(text))) if (!exists(ref, tree)) out.push({ doc, ref });', '    for (const ref of extractRefs(text)) if (!exists(ref, tree)) out.push({ doc, ref });', "ارجاعِ تکراری چندبار گزارش می‌شود")
rep('    for (const ref of new Set(extractRefs(text))) if (!exists(ref, tree)) out.push({ doc, ref });', '    for (const ref of new Set(extractRefs(text))) if (exists(ref, tree)) out.push({ doc, ref });', "شرطِ معلق‌بودن وارونه می‌شود")
rep('if (!scripts.has(name)) out.push', 'if (scripts.has(name)) out.push', "شرطِ اسکریپتِ ناموجود وارونه می‌شود")
rep('  const set = isDir ? tree.dirs : tree.files;', '  const set = tree.files;', "پوشه با فایل سنجیده می‌شود (پوشهٔ موجود معلق می‌شود)")
rep('  const set = isDir ? tree.dirs : tree.files;', '  const set = tree.dirs.size > 0 ? new Set([...tree.dirs, ...tree.files]) : tree.files;', "فایل و پوشه یکی شمرده می‌شود (`index.ts/` معتبر می‌شود)")
rep('p.endsWith(`/${bare}`)', 'p.endsWith(bare)', "تطبیقِ پسوند بی‌مرزِ «/» می‌شود (`gist.ts` با `list.ts` درست می‌شود)")
rep('  if (planned !== undefined && tree.planned?.has(planned) === true) return true;\n', '', "ماژولِ برنامه‌ریزی‌شده از registry پذیرفته نمی‌شود")
rep('const planned = /^src\\/modules\\/([^/]+)\\/$/.exec(ref)?.[1];', 'const planned = /^src\\/modules\\/([^/]+)\\//.exec(ref)?.[1];', "فایلِ زیرِ ماژولِ برنامه‌ریزی‌شده هم معتبر می‌شود")
rep('  if (planned !== undefined && tree.planned?.has(planned) === true) return true;', '  if (planned !== undefined) return true;', "هر نامی (بیرونِ registry) به‌عنوانِ ماژولِ آینده معتبر می‌شود")
rep('/\\bm\\(\\s*"([a-z][a-z0-9-]*)"/g', '/"([a-z][a-z0-9-]*)"/g', "registry: هر رشته‌ای ماژول شمرده می‌شود")
rep('const planned = registryModules(readFileSync(join(ROOT, "src/modules/registry.ts"), "utf8"));', 'const planned = new Set<string>();', "registry خوانده نمی‌شود")
rep('  for (const d of LIVE_STATIC_DOCS) add(d);\n', '', "سندهای ثابتِ زنده (AGENTS.md…) بارگذاری نمی‌شوند")
rep('  for (const m of readdirSync(join(ROOT, "src/modules"))) add(`src/modules/${m}/README.md`);\n', '', "READMEِ ماژول‌ها بارگذاری نمی‌شوند")
rep('const LIVE_STATIC_DOCS: readonly string[] = ["AGENTS.md", "docs/known-pitfalls.md", "docs/high-risk-areas.md", "docs/glossary.md"];', 'const LIVE_STATIC_DOCS: readonly string[] = ["AGENTS.md", "docs/known-pitfalls.md", "docs/high-risk-areas.md", "docs/glossary.md", "docs/adr/0034-settlement-migrate.md"];', "ADRِ تاریخی به مستنداتِ زنده اضافه می‌شود")
rep('      if (SKIP_DIRS.has(name)) continue;\n', '', "node_modules/.git در پویشِ درخت نادیده گرفته نمی‌شوند")

# ── ب) تزریقِ رانش در مخزنِ واقعی ───────────────────────────────────────────────────────────────────────
app("src/modules/settlement-bootstrap/README.md", "\nرانش: `tooling/smoke/settlement-migrate.ts`\n", "README به اسکریپتِ حذف‌شدهٔ smoke اشاره می‌کند")
app("src/modules/settlement/README.md", "\nرانش: `src/modules/settlement/ghost.ts`\n", "README ماژول به فایلِ ناموجودِ هم‌ماژول اشاره می‌کند")
app("src/modules/ledger/README.md", "\nرانش: `pg/ghost-migrations.ts`\n", "README به نامِ کوتاهِ بی‌مصداق اشاره می‌کند")
app("AGENTS.md", "\nرانش: `npm run ghost-script`\n", "AGENTS.md به اسکریپتِ npm ناموجود اشاره می‌کند")
app("AGENTS.md", "\n```\nnode tooling/ghost-tool.ts\n```\n", "بلوکِ کدِ AGENTS.md به ابزارِ ناموجود اشاره می‌کند")
app("docs/high-risk-areas.md", "\nرانش: `src/modules/ghost-planned/`\n", "ماژولِ آینده‌ای که در registry نیست")
app("docs/known-pitfalls.md", "\nرانش: `src/modules/finance-calc/index.ts`\n", "فایلِ زیرِ ماژولِ برنامه‌ریزی‌شدهٔ ساخته‌نشده")
app("docs/glossary.md", "\nرانش: `docs/adr/9999-ghost.md`\n", "مستندِ زنده به ADRِ ناموجود اشاره می‌کند")
create("tooling/smoke/settlement-migrate.ts", "// بازگردانیِ اسکریپتِ منسوخ\n", "اسکریپتِ منسوخِ smoke دوباره پدیدار می‌شود")
delete("tooling/cli/settlement-migrate.ts", "CLIِ رسمیِ مهاجرت حذف می‌شود")
delete("tooling/smoke/settlement-next.mjs", "دودیِ فرایندِ واقعی حذف می‌شود")

env = dict(os.environ)


def tests_pass():
    r = subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", *TEST, "--reporter=dot", "--bail=1"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=300)
    return r.returncode == 0


def read(f):
    p = os.path.join(ROOT, f)
    return open(p, encoding="utf8").read() if os.path.exists(p) else None


def write(f, content):
    p = os.path.join(ROOT, f)
    if content is None:
        if os.path.exists(p):
            os.remove(p)
    else:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w", encoding="utf8").write(content)


def apply(kind, f, args, orig):
    if kind == "replace":
        old, new = args
        write(f, orig.replace(old, new, 1))
    elif kind == "append":
        write(f, orig + args[0])
    elif kind == "create":
        write(f, args[0])
    elif kind == "delete":
        write(f, None)


# پیش‌بازرسی: متنِ اصلیِ جهش‌های «الف» هست و بی‌اثر نیستند؛ فایل‌های «ب» پیش‌شرط دارند.
for i, (kind, f, args, why) in enumerate(M):
    orig = read(f)
    if kind == "replace":
        if orig is None or orig.count(args[0]) < 1:
            print(f"[{i}] قطعه پیدا نشد: {args[0][:80]!r}"); sys.exit(2)
        if args[0] == args[1]:
            print(f"[{i}] جهش بی‌اثر است: {why}"); sys.exit(2)
    elif kind == "append" and orig is None:
        print(f"[{i}] فایل نیست: {f}"); sys.exit(2)
    elif kind == "create" and orig is not None:
        print(f"[{i}] فایل از پیش هست: {f}"); sys.exit(2)
    elif kind == "delete" and orig is None:
        print(f"[{i}] فایل نیست: {f}"); sys.exit(2)
if not tests_pass():
    print("آزمون‌ها بدونِ جهش قرمزند؛ نخست آن‌ها را سبز کنید."); sys.exit(2)

# هم‌ارزهای توضیح‌داده‌شده (شمارهٔ جهش ← دلیلِ رفتاری)
EQUIVALENT: dict = {}
lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) >= 3 else (0, len(M) - 1)
killed, alive = 0, []
for i, (kind, f, args, why) in enumerate(M):
    if i < lo or i > hi:
        continue
    orig = read(f)
    apply(kind, f, args, orig)
    try:
        ok = tests_pass()
    finally:
        write(f, orig)
    if ok and i not in EQUIVALENT:
        alive.append((i, why)); print(f"[{i:02d}] ✗ زنده: {why}", flush=True)
    else:
        killed += 1; print(f"[{i:02d}] ✓ کشته: {why}" if not ok else f"[{i:02d}] ≡ هم‌ارز: {EQUIVALENT[i]}", flush=True)
print(f"\nجهش‌ها: {hi - lo + 1} | کشته/هم‌ارز: {killed} | زنده‌ٔ توضیح‌نشده: {len(alive)}")
sys.exit(1 if alive else 0)
