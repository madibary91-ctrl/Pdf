/**
 * نگهبانِ راستیِ ارجاع‌های مستنداتِ **زنده** (م۳‑ه‑۳‑ز؛ ADR-0038).
 * ریشه: پس از چند برشِ پیاپی چند README همچنان می‌گفت «CLIِ رسمیِ مهاجرت نیست (smoke موقتی است)» و «به src/app وصل نیست»، در حالی که هر دو
 * مدت‌ها بود برقرار بودند؛ و یک اسکریپتِ منسوخ فقط چون مستندی به آن اشاره می‌کرد نگه داشته شده بود. مستندِ دروغ از نبودنِ مستند بدتر است.
 * این آزمون آن‌چه را **ماشین می‌تواند بسنجد** قفل می‌کند (نه معنای جمله‌ها را):
 *   ۱) هر مسیرِ فایل/پوشه‌ای که مستنداتِ زنده در بک‌تیک می‌آورند (یا مسیرِ ریشه‌دار در بلوکِ کد) هنوز در مخزن هست؛
 *   ۲) هر `npm run <نام>` در مستنداتِ زنده در `package.json` → `scripts` هست؛
 *   ۳) اسکریپتِ منسوخِ smoke حذف شده و CLIِ رسمیِ جایگزین (`settlement:migrate`) هست.
 * «مستنداتِ زنده»: `AGENTS.md`، سه سندِ `docs/` (known-pitfalls، high-risk-areas، glossary) و README هر ماژول. ADR، یادداشتِ تحویل و task
 * عمداً بیرون‌اند: آن‌ها **تاریخچه‌اند** و به فایل‌هایی اشاره می‌کنند که در زمانِ خودشان بوده‌اند (ویرایش‌ناپذیر).
 * پویشگر یک تابعِ خالص است و با نمونه‌های ساختگی آزموده می‌شود (نقضِ ساختگی را باید بگیرد، مثبتِ کاذبِ شناخته‌شده را نباید).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** پسوندهایی که یک span را «مسیرِ فایل» می‌کند؛ بقیه (نامِ تابع، فرمان، متن) ارجاعِ مسیر شمرده نمی‌شود. */
const FILE_EXTENSIONS = /[\w@-]\.(?:ts|tsx|mts|mjs|py|md|json|sql|yml|yaml|sh)$/; // نویسهٔ پیش از نقطه لازم است: خودِ `.ts` نامِ پسوند است، نه فایل

/** ریشه‌هایی که مسیرِ آن‌ها نسبت به ریشهٔ مخزن و **دقیق** سنجیده می‌شود (بی‌تطبیقِ پسوندی). */
const ROOTED = /^(?:src|tooling|docs|public|\.github)\//;

/** خروجی‌های تولیدی/نادیده‌گرفته‌شده در git؛ در مخزن نیستند و ارجاع به آن‌ها (مثلاً «ممنوع است») ایراد نیست. */
const GENERATED = /^(?:\.next|node_modules|dist|test-results|coverage)(?:\/|$)/;

/** در پویشِ پوشه‌ها نادیده گرفته می‌شوند. */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".next", "dist", "test-results", "coverage"]);

/** نویسه‌هایی که یعنی span الگو/فرمان/نمونه است، نه مسیرِ مشخص (glob، جایگزین، آرگومان، عبارت). */
const NOT_A_PATH = /[\s*<>{}$()|=,;:?[\]…"'\\]|NNNN/;

export type Ref = Readonly<{ doc: string; ref: string }>;

/** بلوک‌های کدِ حصاری (سه بک‌تیک) را جدا می‌کند: `{ prose, fenced }`. بلوکِ نبسته تا پایانِ متن بلوک است (شکست‌بسته: دیده می‌شود). */
export function splitFences(markdown: string): { prose: string; fenced: string } {
  const prose: string[] = [];
  const fenced: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    (inFence ? fenced : prose).push(line);
  }
  return { prose: prose.join("\n"), fenced: fenced.join("\n") };
}

/** span → مسیرِ نامزد یا `null` (الگو، فرمان، نام، دایرکتوریِ تولیدی). `@/x` به `src/x` تبدیل می‌شود. */
export function toCandidate(span: string): string | null {
  let s = span.trim();
  if (s.length === 0 || NOT_A_PATH.test(s)) return null;
  if (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("@/")) s = `src/${s.slice(2)}`;
  if (!FILE_EXTENSIONS.test(s) && !s.endsWith("/")) return null;
  if (GENERATED.test(s)) return null;
  if (s.startsWith("/") || s.includes("..")) return null;
  return s;
}

/** همهٔ مسیرهای نامزد: spanهای بک‌تیکی در متنِ عادی + مسیرهای ریشه‌دار (`src/…`، `tooling/…`، `docs/…`) در بلوک‌های کد. */
export function extractRefs(markdown: string): string[] {
  const { prose, fenced } = splitFences(markdown);
  const out: string[] = [];
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    const c = toCandidate(m[1] ?? "");
    if (c !== null) out.push(c);
  }
  for (const m of fenced.matchAll(/(?:^|[\s"'=(])((?:src|tooling|docs|public|\.github)\/[\w@./-]+)/gm)) {
    const c = toCandidate((m[1] ?? "").replace(/[.,]+$/, ""));
    if (c !== null) out.push(c);
  }
  return out;
}

/** نام‌های اسکریپت در `npm run [-s|--silent] <نام>` (در متنِ عادی و بلوکِ کد). */
export function extractNpmScripts(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/\bnpm run (?:-s |--silent )?([A-Za-z][\w:.-]*)/g)) out.push(m[1] ?? "");
  return out;
}

/** `planned`: نامِ ماژول‌هایی که در `registry.ts` (منبعِ حقیقتِ لایه‌ها) اعلام شده‌اند؛ پوشهٔ آن‌ها ممکن است هنوز ساخته نشده باشد (نقشهٔ راه). */
export type Tree = Readonly<{ files: ReadonlySet<string>; dirs: ReadonlySet<string>; planned?: ReadonlySet<string> }>;

/** نامِ ماژول‌های اعلام‌شده در متنِ `registry.ts` (`m("<نام>", …`). */
export function registryModules(registrySource: string): Set<string> {
  const out = new Set<string>();
  for (const m of registrySource.matchAll(/\bm\(\s*"([a-z][a-z0-9-]*)"/g)) out.add(m[1] ?? "");
  return out;
}

/** پویشِ پوشه (مسیرهای POSIX نسبت به ریشه)؛ `dirs` همهٔ پوشه‌هاست. */
export function walk(root: string): Tree {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const visit = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(abs, name);
      const rel = relative(root, p).split(sep).join("/");
      if (statSync(p).isDirectory()) {
        dirs.add(rel);
        visit(p);
      } else files.add(rel);
    }
  };
  visit(root);
  return { files, dirs };
}

/**
 * آیا ارجاعِ `ref` در مستندِ `doc` به چیزِ موجود اشاره می‌کند؟
 *  - مسیرِ ریشه‌دار (`src/`، `tooling/`، `docs/`…): فقط **دقیق** (نسبت به ریشه)؛ حذفِ فایل را گم نمی‌کند.
 *  - استثنا: `src/modules/<نام>/` (فقط خودِ پوشه) وقتی `<نام>` در `registry.ts` اعلام شده باشد؛ ماژولِ برنامه‌ریزی‌شده هنوز ساخته نشده است.
 *  - غیر این: نسبت به ریشه، یا **پسوندِ مسیرِ کامل‌بندِ «/»** (نامِ کوتاهِ `registry.ts`، `pg/migrations.ts`، `adr/`؛ مسیرِ نسبی به پوشهٔ مستند هم زیرمجموعهٔ همین است).
 *    این بخش عمداً سهل‌گیرتر است (نامِ کوتاه در README رایج است)؛ فقط وقتی رد می‌شود که هیچ فایلی/پوشه‌ای با آن پایان نیابد.
 */
export function exists(ref: string, tree: Tree): boolean {
  const isDir = ref.endsWith("/");
  const bare = isDir ? ref.slice(0, -1) : ref;
  const set = isDir ? tree.dirs : tree.files;
  if (set.has(bare)) return true;
  const planned = /^src\/modules\/([^/]+)\/$/.exec(ref)?.[1];
  if (planned !== undefined && tree.planned?.has(planned) === true) return true;
  if (ROOTED.test(ref)) return false;
  for (const p of set) if (p === bare || p.endsWith(`/${bare}`)) return true;
  return false;
}

/** ارجاع‌های معلق در `{مسیرِ مستند ← متن}` (تابعِ خالص؛ درخت تزریقی است). */
export function findDangling(docs: Readonly<Record<string, string>>, tree: Tree): Ref[] {
  const out: Ref[] = [];
  for (const [doc, text] of Object.entries(docs)) {
    for (const ref of new Set(extractRefs(text))) if (!exists(ref, tree)) out.push({ doc, ref });
  }
  return out;
}

/** `npm run` به اسکریپتی که نیست، در `{مسیرِ مستند ← متن}`. */
export function findMissingScripts(docs: Readonly<Record<string, string>>, scripts: ReadonlySet<string>): Ref[] {
  const out: Ref[] = [];
  for (const [doc, text] of Object.entries(docs)) {
    for (const name of new Set(extractNpmScripts(text))) if (!scripts.has(name)) out.push({ doc, ref: `npm run ${name}` });
  }
  return out;
}

const LIVE_STATIC_DOCS: readonly string[] = ["AGENTS.md", "docs/known-pitfalls.md", "docs/high-risk-areas.md", "docs/glossary.md"];

function loadLiveDocs(): Record<string, string> {
  const docs: Record<string, string> = {};
  const add = (rel: string): void => {
    if (existsSync(join(ROOT, rel))) docs[rel] = readFileSync(join(ROOT, rel), "utf8");
  };
  for (const d of LIVE_STATIC_DOCS) add(d);
  for (const m of readdirSync(join(ROOT, "src/modules"))) add(`src/modules/${m}/README.md`);
  return docs;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const SCRIPTS: ReadonlySet<string> = new Set(Object.keys(pkg.scripts ?? {}));

describe("tooling · ارجاع‌های مستنداتِ زنده به فایل‌ها و اسکریپت‌ها راست‌اند (ADR-0038)", () => {
  const planned = registryModules(readFileSync(join(ROOT, "src/modules/registry.ts"), "utf8"));
  const tree: Tree = { ...walk(ROOT), planned };
  const docs = loadLiveDocs();

  it("مستنداتِ زنده: هیچ مسیرِ معلقی نیست (حذف/جابه‌جاییِ فایل ⇒ مستند هم در همان کامیت درست شود)", () => {
    expect(findDangling(docs, tree).map((d) => `${d.doc} → ${d.ref}`)).toEqual([]);
  });

  it("مستنداتِ زنده: هر `npm run` به اسکریپتِ موجود اشاره می‌کند", () => {
    expect(findMissingScripts(docs, SCRIPTS).map((d) => `${d.doc} → ${d.ref}`)).toEqual([]);
  });

  it("پویشگر تهی نیست: مستندات و ارجاع‌های کافی را می‌بیند (پویشگرِ خراب‌شده سبزِ بی‌معنا نمی‌دهد)", () => {
    expect(Object.keys(docs).length).toBeGreaterThanOrEqual(15);
    for (const d of LIVE_STATIC_DOCS) expect(docs[d], `${d} بارگذاری نشد`).toBeTypeOf("string");
    const readmes = readdirSync(join(ROOT, "src/modules")).filter((m) => existsSync(join(ROOT, `src/modules/${m}/README.md`)));
    expect(readmes.length).toBeGreaterThanOrEqual(15);
    for (const m of readmes) expect(docs[`src/modules/${m}/README.md`], `README ${m} بارگذاری نشد`).toBeTypeOf("string");
    expect(Object.values(docs).flatMap((t) => extractRefs(t)).length).toBeGreaterThanOrEqual(100);
    expect(Object.values(docs).flatMap((t) => extractNpmScripts(t)).length).toBeGreaterThanOrEqual(1);
    expect(tree.files.has("AGENTS.md") && tree.dirs.has("src/modules") && tree.dirs.has("docs/adr")).toBe(true);
  });

  it("registry خوانده می‌شود: ماژول‌های ساخته‌شده و برنامه‌ریزی‌شده هر دو در آن‌اند", () => {
    expect(planned.size).toBeGreaterThanOrEqual(20);
    for (const built of ["settlement", "ledger", "legal-kb-store"]) expect(planned.has(built)).toBe(true);
    for (const future of ["finance-calc", "desktop-shell"]) expect(planned.has(future) && !tree.dirs.has(`src/modules/${future}`)).toBe(true);
  });

  it("ADR/یادداشت/taskِ تاریخی بیرونِ دامنه‌اند (تاریخچه ویرایش‌ناپذیر است)", () => {
    expect(Object.keys(docs).filter((d) => /^docs\/(?:adr|handoffs|tasks)\//.test(d))).toEqual([]);
  });

  it("اسکریپتِ منسوخِ smoke حذف شده و CLIِ رسمیِ مهاجرت جایگزینش است (ADR-0034/0038)", () => {
    expect(existsSync(join(ROOT, "tooling/smoke/settlement-migrate.ts"))).toBe(false);
    expect(SCRIPTS.has("settlement:migrate")).toBe(true);
    expect(existsSync(join(ROOT, "tooling/cli/settlement-migrate.ts"))).toBe(true);
    // دودیِ فرایندِ واقعی از CLIِ رسمی استفاده می‌کند، نه اسکریپتِ حذف‌شده.
    expect(readFileSync(join(ROOT, "tooling/smoke/settlement-next.mjs"), "utf8")).toContain("settlement:migrate");
  });
});

describe("tooling · پویشگرِ ارجاع‌ها با نمونه‌های ساختگی", () => {
  const files = new Set(["src/modules/a/index.ts", "src/modules/a/pg/migrations.ts", "src/modules/registry.ts", "tooling/cli/x.ts", "AGENTS.md", "docs/adr/0001-x.md"]);
  const dirs = new Set(["src", "src/modules", "src/modules/a", "src/modules/a/pg", "tooling", "tooling/cli", "docs", "docs/adr"]);
  const tree: Tree = { files, dirs };
  const readme = "src/modules/a/README.md";

  it("مسیرِ ریشه‌دارِ حذف‌شده معلق است؛ مسیرِ موجود نه", () => {
    expect(findDangling({ [readme]: "`tooling/cli/x.ts` و `tooling/smoke/old.ts`" }, tree)).toEqual([{ doc: readme, ref: "tooling/smoke/old.ts" }]);
  });

  it("مسیرِ ریشه‌دار را نسخهٔ تودرتوی هم‌نام نجات نمی‌دهد (دقیق است)؛ همان مسیرِ بی‌ریشه با پسوند درست می‌شود", () => {
    // فایلِ ریشه حذف شده ولی زیرِ یک پوشهٔ تودرتو هنوز هست؛ پسوندِ مسیر آن را می‌یابد، پس فقط سخت‌گیریِ ریشه‌دار جلویش را می‌گیرد.
    const nested: Tree = { files: new Set(["src/modules/a/tooling/cli/x.ts", "src/modules/a/docs/adr/0001-x.md", "src/modules/a/src/y.ts"]), dirs: new Set(["src/modules/a/docs/adr"]) };
    expect(findDangling({ [readme]: "`tooling/cli/x.ts`" }, nested)).toHaveLength(1);
    expect(findDangling({ [readme]: "`docs/adr/0001-x.md`" }, nested)).toHaveLength(1);
    expect(findDangling({ [readme]: "`src/y.ts`" }, nested)).toHaveLength(1);
    expect(findDangling({ [readme]: "`cli/x.ts` `adr/`" }, nested)).toEqual([]);
  });

  it("نامِ کوتاه و مسیرِ نسبی: پسوندِ مسیر یا نسبت به پوشهٔ مستند قبول است؛ بی‌مصداق معلق", () => {
    const d = findDangling({ [readme]: "`registry.ts` `pg/migrations.ts` `index.ts` `adr/` `ghost.ts` `pg/ghost.sql`" }, tree);
    expect(d.map((x) => x.ref)).toEqual(["ghost.ts", "pg/ghost.sql"]);
  });

  it("تطبیقِ پسوند فقط در مرزِ «/» است (`st.ts` با `list.ts` درست نمی‌شود)", () => {
    const t: Tree = { files: new Set(["src/modules/a/list.ts"]), dirs: new Set(["src/modules/a"]) };
    expect(findDangling({ [readme]: "`list.ts` `a/list.ts`" }, t)).toEqual([]);
    expect(findDangling({ [readme]: "`st.ts`" }, t)).toHaveLength(1);
  });

  it("پوشه با «/» پایانی: پوشهٔ موجود قبول، فایلِ هم‌نامِ پوشه قبول نیست، پوشهٔ ناموجود معلق", () => {
    expect(findDangling({ [readme]: "`src/modules/a/` `docs/adr/`" }, tree)).toEqual([]);
    expect(findDangling({ [readme]: "`src/modules/ghost/`" }, tree)).toHaveLength(1);
    expect(findDangling({ [readme]: "`src/modules/a/index.ts/`" }, tree)).toHaveLength(1);
  });

  it("نام‌های مستعار (`@/modules/…`) به src تبدیل می‌شوند؛ بی‌پسوند ارجاعِ مسیر نیست", () => {
    expect(findDangling({ [readme]: "`@/modules/a/index.ts` `@/modules/a/gone.ts` `@/modules/a/internal`" }, tree)).toEqual([{ doc: readme, ref: "src/modules/a/gone.ts" }]);
  });

  it("الگو، جایگزین، فرمان، آدرس و نام‌های تولیدی ارجاعِ مسیر شمرده نمی‌شوند (مثبتِ کاذب نیست)", () => {
    const text = "`src/modules/<name>/index.ts` `docs/adr/NNNN-x.md` `src/**/*.test.ts` `a.ts, b.ts` `node x.ts` `https://x.io/a.md` `.next/` `node_modules/x.json` `…/a.ts` `src/{a,b}.ts` `$HOME/a.ts`";
    expect(extractRefs(text)).toEqual([]);
    expect(findDangling({ [readme]: text }, tree)).toEqual([]);
  });

  it("مسیرِ مطلق یا با «..» رد می‌شود (از مخزن بیرون می‌زند؛ ارجاعِ درون‌مخزنی نیست)", () => {
    expect(toCandidate("/etc/a.md")).toBeNull();
    expect(toCandidate("../x/a.md")).toBeNull();
    expect(toCandidate("src/../a.md")).toBeNull();
  });

  it("بلوکِ کد: فقط مسیرهای ریشه‌دار پویش می‌شوند؛ مسیرِ حذف‌شده در بلوک هم معلق است", () => {
    const text = "```\nnode tooling/cli/x.ts up\nnode tooling/smoke/old.ts\nsome-tool a.ts\n```\nپایان";
    expect(extractRefs(text)).toEqual(["tooling/cli/x.ts", "tooling/smoke/old.ts"]);
    expect(findDangling({ [readme]: text }, tree)).toEqual([{ doc: readme, ref: "tooling/smoke/old.ts" }]);
  });

  it("بلوکِ کدِ نبسته تا پایانِ متن بلوک است (شکست‌بسته) و span بیرونِ بلوک جدا می‌ماند", () => {
    const { prose, fenced } = splitFences("`a.md`\n```\nsrc/x.ts\n");
    expect(prose).toBe("`a.md`");
    expect(fenced).toContain("src/x.ts");
  });

  it("`npm run`: اسکریپتِ ناموجود گرفته می‌شود؛ -s و نام‌های دونقطه‌ای شناخته‌اند", () => {
    const scripts = new Set(["build", "settlement:migrate"]);
    const text = "`npm run build` و `npm run -s settlement:migrate -- up` و `npm run ghost` و npm install";
    expect(extractNpmScripts(text)).toEqual(["build", "settlement:migrate", "ghost"]);
    expect(findMissingScripts({ [readme]: text }, scripts)).toEqual([{ doc: readme, ref: "npm run ghost" }]);
  });

  it("مستندِ تهی یا بی‌ارجاع ⇒ هیچ", () => {
    expect(findDangling({}, tree)).toEqual([]);
    expect(findDangling({ [readme]: "" }, tree)).toEqual([]);
    expect(findDangling({ [readme]: "فقط متنِ فارسی بدون مسیر" }, tree)).toEqual([]);
    expect(findMissingScripts({ [readme]: "" }, new Set())).toEqual([]);
  });

  it("ماژولِ برنامه‌ریزی‌شده در registry: فقط خودِ پوشه معتبر است؛ نامِ بیرونِ registry و مسیرِ عمیق‌تر معلق است", () => {
    const t: Tree = { ...tree, planned: new Set(["future-mod"]) };
    expect(findDangling({ [readme]: "`src/modules/future-mod/`" }, t)).toEqual([]);
    expect(findDangling({ [readme]: "`src/modules/ghost-mod/`" }, t)).toHaveLength(1);
    expect(findDangling({ [readme]: "`src/modules/future-mod/index.ts`" }, t)).toHaveLength(1);
    expect(findDangling({ [readme]: "`src/modules/future-mod/`" }, tree)).toHaveLength(1); // بی‌registry: معلق
  });

  it("registryModules: فقط `m(\"نام\", …` را می‌خواند، نه رشته‌های دیگر", () => {
    const src = 'm("a-b", 1, 2)\n  m( "c", 1)\nconst x = "not-a-module";\n// m("commented"? no';
    expect([...registryModules(src)].sort()).toEqual(["a-b", "c", "commented"]);
    expect(registryModules("").size).toBe(0);
  });

  it("پسوندِ تنها (`.ts`، `.md`) نامِ فایل نیست", () => {
    expect(toCandidate(".ts")).toBeNull();
    expect(toCandidate(".md")).toBeNull();
    expect(toCandidate("a.ts")).toBe("a.ts");
    expect(toCandidate("x-1.mjs")).toBe("x-1.mjs");
  });

  it("مسیرهای تکراری یک بار گزارش می‌شوند", () => {
    expect(findDangling({ [readme]: "`src/gone.ts` `src/gone.ts`" }, tree)).toHaveLength(1);
  });

  it("walk: فایل‌ها را درمی‌آورد و node_modules/.git را نادیده می‌گیرد", () => {
    const t = walk(join(ROOT, "src/modules/persian-text"));
    expect([...t.files].some((f) => f.endsWith("index.ts"))).toBe(true);
    expect([...walk(ROOT).files].some((f) => f.startsWith("node_modules/") || f.startsWith(".git/"))).toBe(false);
  });
});
