/**
 * آزمونِ زندهٔ نگهبانِ یکپارچگیِ مصنوعات روی **خودِ مخزن** + آزمونِ پویشگر روی درختِ موقتِ ساختگی (ADR-0079).
 * ریشه: task 0074 (در 1b123ec) و task 0015 (در a697691) ۰ بایتی کامیت شدند و هیچ آزمونی نفهمید.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_FILE_ALLOWLIST, checkAllowlist, checkDocFiles, findEmptyFiles } from "./artifact-integrity";
import { collectDocFiles, collectSizedFiles, listFiles } from "./artifact-integrity-scan";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const render = (v: readonly { code: string; path: string; detail: string }[]): string[] => v.map((x) => `${x.code} ${x.path} — ${x.detail}`);

describe("مخزنِ واقعی", () => {
  const docs = collectDocFiles(ROOT);

  it("پویشگر واقعاً مستندات را می‌بیند (کفِ پایین؛ پویشِ تهی نباید سبز بشود)", () => {
    const count = (dir: string): number => docs.filter((d) => d.path.startsWith(`${dir}/`) && /\/\d{4}-/.test(d.path)).length;
    expect(count("docs/tasks")).toBeGreaterThanOrEqual(75);
    expect(count("docs/handoffs")).toBeGreaterThanOrEqual(77);
    expect(count("docs/adr")).toBeGreaterThanOrEqual(78);
    expect(docs.some((d) => d.path === "AGENTS.md")).toBe(true);
    expect(docs.some((d) => /^src\/modules\/tool-policy-preflight\/README\.md$/.test(d.path))).toBe(true);
  });

  it("هیچ مستندی خالی/خراب نیست و سه سریِ شماره‌دار سالم و بی‌شکاف‌اند", () => {
    expect(render(checkDocFiles(docs))).toEqual([]);
  });

  it("هیچ فایلِ کد/آزمون/پیکربندی/مستندِ ۰ بایتی نیست", () => {
    const sized = collectSizedFiles(ROOT);
    expect(sized.length).toBeGreaterThan(500);
    expect(sized.some((s) => s.path === "tooling/artifact-integrity.ts")).toBe(true);
    expect(sized.some((s) => s.path === "package.json")).toBe(true);
    expect(render(findEmptyFiles(sized))).toEqual([]);
  });

  it("allowlistِ ۰ بایتی خالی و بی‌مدخلِ بی‌دلیل است", () => {
    expect(Object.keys(EMPTY_FILE_ALLOWLIST)).toEqual([]);
    expect(checkAllowlist(EMPTY_FILE_ALLOWLIST)).toEqual([]);
  });

  it("task 0015 (نسخهٔ اصلیِ 015acdd) برگردانده شده: بخش‌های کلیدی را دارد", () => {
    const t = docs.find((d) => d.path === "docs/tasks/0015-ai-orchestrator-controlled-repair.md")?.text ?? "";
    for (const h of ["## هدف (یک جمله)", "## معیار پذیرش", "## تعریف «تمام شد»", "ADR-0017"]) expect(t).toContain(h);
  });
});

describe("پویشگر روی درختِ ساختگی", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "artifact-integrity-"));
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text, "utf8");
    }
    return root;
  }
  const PAD = "پرکننده برای رسیدن به حداقلِ اندازه. ".repeat(10);

  it("فایلِ ۰ بایتیِ سری از پویش تا نقض می‌رسد (بازسازیِ رویدادِ 0015)", () => {
    const root = tree({
      "docs/tasks/0001-a.md": `# a\n${PAD}\n`,
      "docs/tasks/0002-b.md": "",
      "docs/tasks/0003-c.md": `# c\n${PAD}\n`,
    });
    const v = checkDocFiles(collectDocFiles(root));
    expect(v.map((x) => [x.code, x.path])).toEqual([["EMPTY", "docs/tasks/0002-b.md"]]);
  });

  it("فایلِ ۰ بایتیِ کد/آزمون/پیکربندی پیدا می‌شود؛ پسوندِ غیرِ بررسی‌شده (.gitkeep، تصویر) نه", () => {
    const root = tree({
      "src/a.ts": "",
      "tooling/x.test.ts": "",
      "package.json": "",
      "docs/zero.md": "",
      "public/manifest.json": "",
      ".github/workflows/ci.yml": "",
      "public/.gitkeep": "",
      "public/logo.png": "",
      "src/ok.ts": "export {};\n",
      "deep/ignored.ts": "", // خارج از دامنهٔ پویش (فقط ریشه و پنج پوشه)
    });
    expect(findEmptyFiles(collectSizedFiles(root)).map((v) => v.path)).toEqual([".github/workflows/ci.yml", "docs/zero.md", "package.json", "public/manifest.json", "src/a.ts", "tooling/x.test.ts"]);
  });

  it("node_modules/.git/.next و … پویش نمی‌شوند", () => {
    const root = tree({
      "node_modules/pkg/README.md": "",
      "src/node_modules/x.ts": "",
      ".git/info.md": "",
      ".next/a.ts": "",
      "docs/glossary.md": "# واژه‌نامه\n",
    });
    expect(listFiles(root)).toEqual(["docs/glossary.md"]);
    expect(checkDocFiles(collectDocFiles(root))).toEqual([]);
  });

  it("بایتِ نامعتبرِ UTF-8 به U+FFFD می‌رسد و BAD_ENCODING می‌شود", () => {
    const root = tree({ "docs/glossary.md": "# x\n" });
    writeFileSync(join(root, "docs/glossary.md"), Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]));
    expect(checkDocFiles(collectDocFiles(root)).map((v) => v.code)).toEqual(["BAD_ENCODING"]);
  });

  it("README ماژول، AGENTS.md و مستنداتِ docs خوانده می‌شوند؛ README غیرِ ماژول/عمیق‌تر نه", () => {
    const root = tree({
      "AGENTS.md": "# a\n",
      "src/modules/m/README.md": "# m\n",
      "src/modules/m/sub/README.md": "# no\n",
      "src/other/README.md": "# no\n",
      "docs/adr/0001-x.md": `# ADR-0001\n${PAD}\n`,
      "README.md": "# root\n",
    });
    expect(collectDocFiles(root).map((d) => d.path)).toEqual(["AGENTS.md", "docs/adr/0001-x.md", "src/modules/m/README.md"]);
  });

  it("پیوندِ نمادین دنبال نمی‌شود (بی‌حلقه)", () => {
    const root = tree({ "docs/a.md": "# a\n" });
    try {
      symlinkSync(root, join(root, "docs", "loop"), "dir");
    } catch {
      return; // پلتفرمِ بی‌مجوزِ symlink (ویندوز): این شاخه قابل‌آزمون نیست
    }
    expect(listFiles(root)).toEqual(["docs/a.md"]);
  });

  it("ریشهٔ ناموجود = پویشِ تهی، بی‌پرتاب", () => {
    expect(listFiles(join(tmpdir(), "artifact-integrity-does-not-exist-xyz"))).toEqual([]);
  });
});
