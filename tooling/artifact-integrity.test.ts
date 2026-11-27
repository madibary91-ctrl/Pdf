/**
 * آزمونِ منطقِ خالصِ نگهبانِ یکپارچگیِ مصنوعات (ADR-0079). ریشه: دو فایلِ ۰ بایتیِ کامیت‌شده (task 0074 و task 0015).
 * شامل: هر کدِ نقض با مرزهای خودش، سه ناوردای مدل‌محور (۲۰۰ بذر) و نگهبانِ بی‌I/Oِ منبع.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FILE_ALLOWLIST,
  MIN_SERIES_BYTES,
  SERIES_DIRS,
  checkAllowlist,
  checkDocFiles,
  findEmptyFiles,
  hasConflictMarker,
  seriesOf,
  toPersianDigits,
  type ArtifactFile,
  type ViolationCode,
} from "./artifact-integrity";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAD = "این یک متنِ پرکننده برای رسیدن به حداقلِ اندازهٔ یک سندِ واقعی است. ".repeat(6);

const n4 = (n: number): string => String(n).padStart(4, "0");
const file = (path: string, text: string): ArtifactFile => ({ path, text });
const task = (n: number, slug = "x"): ArtifactFile => file(`docs/tasks/${n4(n)}-${slug}.md`, `# کار ${n}\n\n${PAD}\n`);
const handoff = (n: number, slug = "x"): ArtifactFile => file(`docs/handoffs/${n4(n)}-${slug}.md`, `# یادداشت تحویل ${toPersianDigits(n4(n))} — عنوان\n\n${PAD}\n`);
const adr = (n: number, slug = "x"): ArtifactFile => file(`docs/adr/${n4(n)}-${slug}.md`, `# ADR-${n4(n)} — عنوان\n\n${PAD}\n`);
const corpus = (k: number): ArtifactFile[] => Array.from({ length: k }, (_, i) => [task(i + 1), handoff(i + 1), adr(i + 1)]).flat();
const codes = (files: readonly ArtifactFile[]): ViolationCode[] => checkDocFiles(files).map((v) => v.code);

/** متنی با دقیقاً `bytes` بایت (ASCII)، با سرتیتر و خطِ پایانی. */
function exactBytes(bytes: number): string {
  const head = "# t\n";
  return `${head}${"a".repeat(bytes - head.length - 1)}\n`;
}

/** همان سرتیتر (و شمارهٔ آن) را نگه می‌دارد و فایل را دقیقاً به ۲۵۵ بایت می‌رساند. */
function shrinkKeepingHeading(text: string): string {
  const first = text.split("\n")[0] ?? "";
  const used = new TextEncoder().encode(first).length + 2; // خطِ اول + «\n» + «\n» پایانی
  return `${first}\n${"a".repeat(MIN_SERIES_BYTES - 1 - used)}\n`;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

describe("artifact-integrity: مبنای سالم", () => {
  it("مجموعهٔ سالم و بی‌شکاف هیچ نقضی ندارد", () => {
    expect(checkDocFiles(corpus(5))).toEqual([]);
  });
  it("ورودیِ خالی/بدونِ سری: بی‌نقض", () => {
    expect(checkDocFiles([])).toEqual([]);
    expect(checkDocFiles([file("AGENTS.md", "# راهنما\n")])).toEqual([]);
  });
  it("قالبِ «_TEMPLATE.md» مجاز است و در شماره‌گذاری نمی‌آید", () => {
    expect(checkDocFiles([...corpus(2), file("docs/tasks/_TEMPLATE.md", `# قالب\n\n${PAD}\n`)])).toEqual([]);
  });
  it("مسیرِ ویندوزی (بک‌اسلش) و پایانِ خطِ CRLF پذیرفته می‌شود", () => {
    const crlf = (f: ArtifactFile): ArtifactFile => file(f.path.replace(/\//g, "\\"), f.text.replace(/\n/g, "\r\n"));
    expect(checkDocFiles(corpus(3).map(crlf))).toEqual([]);
  });
  it("تکرارِ همان شمارهٔ سری در سری‌های دیگر ایراد نیست", () => {
    expect(checkDocFiles([task(1), handoff(1), adr(1)])).toEqual([]);
  });
});

describe("EMPTY — ریشهٔ برش", () => {
  it("فایلِ ۰ بایتی در سری: فقط EMPTY (نه شکافِ دروغین، نه نقضِ دیگر)", () => {
    const files = [task(1), file("docs/tasks/0002-x.md", ""), task(3)];
    expect(checkDocFiles(files).map((v) => [v.code, v.path])).toEqual([["EMPTY", "docs/tasks/0002-x.md"]]);
  });
  it("فقط‌فاصله/خطِ خالی هم خالی است", () => {
    for (const t of [" ", "\n", "\r\n\r\n", " \t\n  \n"]) expect(codes([file("docs/known-pitfalls.md", t)])).toEqual(["EMPTY"]);
  });
  it("مستندِ خارج از سری هم خالی نمی‌شود (AGENTS.md، README ماژول)", () => {
    expect(codes([file("AGENTS.md", "")])).toEqual(["EMPTY"]);
    expect(codes([file("src/modules/a/README.md", "")])).toEqual(["EMPTY"]);
  });
  it("جزئیاتِ ۰ بایتی با فقط‌فاصله فرق دارد", () => {
    expect(checkDocFiles([file("a.md", "")])[0]?.detail).toContain("۰ بایت");
    expect(checkDocFiles([file("a.md", "  \n")])[0]?.detail).toContain("فاصله");
  });
  it("بازسازیِ دقیقِ دو رویدادِ واقعی: 0015 و 0074 خالی ⇒ دو EMPTY", () => {
    const files = corpus(80).filter((f) => !/tasks\/00(15|74)-/.test(f.path));
    files.push(file("docs/tasks/0015-ai-orchestrator-controlled-repair.md", ""), file("docs/tasks/0074-tool-policy-binding.md", ""));
    expect(checkDocFiles(files).map((v) => v.path)).toEqual(["docs/tasks/0015-ai-orchestrator-controlled-repair.md", "docs/tasks/0074-tool-policy-binding.md"]);
  });
});

describe("BAD_ENCODING و CONFLICT_MARKER", () => {
  it("BOM، U+FFFD و NUL شناسایی می‌شوند (در سری و بیرون از آن)", () => {
    for (const bad of ["\ufeff# x\n", "# x\ufffd\n", "# x\u0000\n"]) {
      expect(codes([file("docs/glossary.md", bad)])).toContain("BAD_ENCODING");
      expect(codes([file("docs/tasks/0001-x.md", bad + PAD + "\n")])).toContain("BAD_ENCODING");
    }
  });
  it("متنِ فارسیِ سالم و ZWNJ خراب حساب نمی‌شود", () => {
    expect(codes([file("docs/glossary.md", "# می‌خواهم\u200c ۱۲۳\n")])).toEqual([]);
  });
  it("نشانگرِ تعارض در متنِ عادی", () => {
    for (const m of ["<<<<<<< HEAD", ">>>>>>> feature/x", "<<<<<<<", ">>>>>>>"]) {
      expect(codes([file("docs/glossary.md", `# x\n${m}\n`)])).toEqual(["CONFLICT_MARKER"]);
    }
    expect(hasConflictMarker("a\r\n<<<<<<< HEAD\r\nb")).toBe(true);
    expect(hasConflictMarker("a\r\n<<<<<<<\r\nb")).toBe(true); // نشانگرِ تنها با CRLF
    expect(hasConflictMarker("a\r\n>>>>>>>\r\n")).toBe(true);
  });
  it("نبودِ نشانگر: هشت‌تایی، تورفته، میانهٔ خط، «=======» تنها (زیرخطِ setext)", () => {
    for (const t of ["<<<<<<<< x", "  <<<<<<< x", "a <<<<<<< b", "=======", "Title\n=======", "<<<<<< x", "<<<<<<<x"]) {
      expect(hasConflictMarker(t)).toBe(false);
    }
  });
  it("داخلِ حصارِ کد نادیده است؛ حصارِ نبسته بقیهٔ فایل را پنهان نمی‌کند (شکست‌بسته)", () => {
    expect(hasConflictMarker("```\n<<<<<<< HEAD\n```\n")).toBe(false);
    expect(hasConflictMarker("```\n<<<<<<< HEAD\n```\n<<<<<<< HEAD\n")).toBe(true);
    expect(hasConflictMarker("  ```\n<<<<<<< HEAD\n  ```\n")).toBe(false); // حصارِ تورفته (مثلاً درون فهرست)
    expect(hasConflictMarker("```\ncode\n<<<<<<< HEAD\n")).toBe(true); // حصارِ نبسته
    expect(hasConflictMarker("```\ncode\n```\n```\n<<<<<<< x\n")).toBe(true); // حصارِ دوم نبسته
  });
});

describe("TOO_SHORT / NO_H1 / NO_FINAL_NEWLINE", () => {
  it("مرزِ اندازه: ۲۵۵ بایت رد، ۲۵۶ بایت قبول (بایت، نه نویسه)", () => {
    expect(codes([file("docs/tasks/0001-x.md", exactBytes(MIN_SERIES_BYTES - 1))])).toEqual(["TOO_SHORT"]);
    expect(codes([file("docs/tasks/0001-x.md", exactBytes(MIN_SERIES_BYTES))])).toEqual([]);
    const fa = `# ${"ا".repeat(60)}\n${"ب".repeat(40)}\n`; // ۱۰۰ نویسه ولی > ۲۰۰ بایت و < ۲۵۶
    expect(new TextEncoder().encode(fa).length).toBeLessThan(MIN_SERIES_BYTES);
    expect(codes([file("docs/tasks/0001-x.md", fa)])).toEqual(["TOO_SHORT"]);
    const fa2 = `# ${"ا".repeat(70)}\n${"ب".repeat(40)}\n`; // ۱۱۰ نویسه ⇒ ۲۲۴+ بایت… با ۲۰ نویسه‌ی دیگر از حد می‌گذرد
    expect(codes([file("docs/tasks/0001-x.md", fa2 + "ج".repeat(30) + "\n")])).toEqual([]);
  });
  it("حداقلِ اندازه فقط برای سری‌هاست (README کوتاه ایراد نیست)", () => {
    expect(codes([file("src/modules/a/README.md", "# a\n")])).toEqual([]);
  });
  it("سرتیتر: خطِ اولِ دقیقاً «# متن»", () => {
    const bad = ["\n# x", "## x", "#x", "# ", "#", "متن\n# x", " # x", "#\tx"];
    for (const first of bad) expect(codes([file("docs/tasks/0001-x.md", `${first}\n${PAD}\n`)])).toContain("NO_H1");
    expect(codes([file("docs/tasks/0001-x.md", `# x\n${PAD}\n`)])).toEqual([]);
    expect(codes([file("docs/tasks/0001-x.md", `# x\r\n${PAD}\r\n`)])).toEqual([]);
  });
  it("خطِ پایانی", () => {
    expect(codes([file("docs/tasks/0001-x.md", `# x\n${PAD}`)])).toEqual(["NO_FINAL_NEWLINE"]);
  });
});

describe("BAD_NAME و سری‌بندی", () => {
  it("نام‌های نامعتبر", () => {
    const names = ["0000-x.md", "1-x.md", "0001-X.md", "0001-a--b.md", "0001.md", "note.md", "0001-x.txt", "0001-x.markdown", "_template.md", "00012-x.md", "0001-x-.md"];
    for (const name of names) {
      expect(codes([file(`docs/tasks/${name}`, `# x\n${PAD}\n`)]), name).toEqual(["BAD_NAME"]);
    }
  });
  it("نامِ نامعتبر شمارهٔ سری را اشغال نمی‌کند و نقضِ دیگری هم نمی‌سازد", () => {
    expect(codes([task(1), file("docs/tasks/0002-X.md", "# x\n" + PAD)])).toEqual(["BAD_NAME"]);
  });
  it("زیرپوشه‌ها و پوشه‌های دیگر سری نیستند", () => {
    expect(seriesOf("docs/tasks/sub/x.md")).toBeNull();
    expect(seriesOf("docs/other/0001-x.md")).toBeNull();
    expect(seriesOf("docs/taskset/0001-x.md")).toBeNull();
    expect(seriesOf("docs/tasks-notes.md")).toBeNull(); // پیشوندِ نام بدونِ «/» سری نیست
    expect(seriesOf("docs/adr0001-x.md")).toBeNull();
    expect(codes([file("docs/tasks-notes.md", "# یادداشت\n")])).toEqual([]);
    expect(seriesOf("docs/tasks/0001-x.md")).toEqual({ dir: "docs/tasks", name: "0001-x.md" });
    expect(seriesOf("docs\\adr\\0001-x.md")).toEqual({ dir: "docs/adr", name: "0001-x.md" });
    expect(codes([file("docs/tasks/sub/not-numbered.md", "# x\n")])).toEqual([]);
  });
  it("دو فایلِ «0000-…» فقط BAD_NAME می‌گیرند (۰ شماره‌ای نیست که تکرار شود)", () => {
    const z = (slug: string): ArtifactFile => file(`docs/tasks/0000-${slug}.md`, `# x\n${PAD}\n`);
    expect(codes([z("a"), z("b")])).toEqual(["BAD_NAME", "BAD_NAME"]);
  });
  it("DUPLICATE_NUMBER: دو فایل با یک شماره (مسیرها در جزئیات)", () => {
    const v = checkDocFiles([task(1), task(2, "a"), task(2, "b")]);
    expect(v.map((x) => x.code)).toEqual(["DUPLICATE_NUMBER"]);
    expect(v[0]?.path).toBe("docs/tasks");
    expect(v[0]?.detail).toContain("0002-a.md");
    expect(v[0]?.detail).toContain("0002-b.md");
  });
  it("مسیرهای DUPLICATE_NUMBER مرتب‌اند (مستقل از ترتیبِ ورودی)", () => {
    const v = checkDocFiles([task(1), task(2, "b"), task(2, "a")]);
    expect(v[0]?.detail.indexOf("0002-a.md")).toBeLessThan(v[0]?.detail.indexOf("0002-b.md") ?? -1);
  });
  it("NUMBER_GAP: شکافِ میانه، نبودنِ ۰۰۰۱ و چند شکاف", () => {
    expect(checkDocFiles([task(1), task(2), task(4)]).map((v) => v.detail)).toEqual([expect.stringContaining("0003")]);
    expect(checkDocFiles([task(2), task(3)])[0]?.detail).toContain("0001");
    const multi = checkDocFiles([task(1), task(3), task(6)])[0]?.detail ?? "";
    for (const m of ["0002", "0004", "0005"]) expect(multi).toContain(m);
    expect(multi).not.toContain("0003");
    expect(multi).not.toContain("0006،");
  });
  it("شکاف برای هر سری جدا سنجیده می‌شود؛ سریِ نبوده بی‌نقض است", () => {
    const v = checkDocFiles([task(1), task(2), handoff(1), handoff(3)]);
    expect(v.map((x) => [x.code, x.path])).toEqual([["NUMBER_GAP", "docs/handoffs"]]);
  });
  it("قالب در شمارش نمی‌آید؛ تنها قالب شکاف/تکرار نمی‌سازد", () => {
    expect(codes([file("docs/tasks/_TEMPLATE.md", `# قالب\n\n${PAD}\n`)])).toEqual([]);
  });
});

describe("HEADING_NUMBER_MISMATCH", () => {
  it("یادداشتِ تحویل: شمارهٔ فارسیِ نام در سرتیتر", () => {
    const wrong = file("docs/handoffs/0002-x.md", `# یادداشت تحویل ۰۰۰۱ — x\n${PAD}\n`);
    expect(codes([handoff(1), wrong])).toEqual(["HEADING_NUMBER_MISMATCH"]);
    const western = file("docs/handoffs/0001-x.md", `# یادداشت تحویل 0001\n${PAD}\n`);
    expect(codes([western])).toEqual(["HEADING_NUMBER_MISMATCH"]);
    const body = file("docs/handoffs/0001-x.md", `# یادداشت تحویل\n\n۰۰۰۱ فقط در بدنه\n${PAD}\n`);
    expect(codes([body])).toEqual(["HEADING_NUMBER_MISMATCH"]);
  });
  it("ADR: «# ADR-NNNN» دقیق؛ خط‌تیرهٔ ناشکن (U+2011) هم پذیرفته", () => {
    expect(codes([adr(1), file("docs/adr/0002-x.md", `# ADR-0001 — x\n${PAD}\n`)])).toEqual(["HEADING_NUMBER_MISMATCH"]);
    expect(codes([file("docs/adr/0001-x.md", `# ADR-00011 — x\n${PAD}\n`)])).toEqual(["HEADING_NUMBER_MISMATCH"]);
    expect(codes([file("docs/adr/0001-x.md", `# ADR 0001\n${PAD}\n`)])).toEqual(["HEADING_NUMBER_MISMATCH"]);
    expect(codes([file("docs/adr/0001-x.md", `# ADR\u20110001 — x\n${PAD}\n`)])).toEqual([]);
  });
  it("task شمارهٔ سرتیتر نمی‌خواهد", () => {
    expect(codes([file("docs/tasks/0001-x.md", `# عنوان بی‌شماره\n${PAD}\n`)])).toEqual([]);
  });
  it("toPersianDigits", () => {
    expect(toPersianDigits("0123456789")).toBe("۰۱۲۳۴۵۶۷۸۹");
    expect(toPersianDigits("ab-0077")).toBe("ab-۰۰۷۷");
  });
});

describe("خروجی: قطعی، بی‌اثر روی ورودی، مرتب", () => {
  it("ترتیبِ ورودی در خروجی بی‌اثر است و ورودی تغییر نمی‌کند (۱۰۰ بذر)", () => {
    const base = [task(1), task(3), file("docs/tasks/0005-x.md", ""), handoff(2), file("docs/adr/0001-x.md", "# ADR-0009\n"), file("a.md", "")];
    const snapshot = JSON.stringify(base);
    const want = JSON.stringify(checkDocFiles(base));
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed);
      const shuffled = [...base].sort(() => r() - 0.5);
      expect(JSON.stringify(checkDocFiles(shuffled))).toBe(want);
    }
    expect(JSON.stringify(base)).toBe(snapshot);
  });
  it("خروجی بر پایهٔ (مسیر، کد) مرتب است", () => {
    const v = checkDocFiles([file("z.md", ""), file("a.md", ""), file("docs/tasks/0003-x.md", "x")]);
    const keys = v.map((x) => [x.path, x.code] as const);
    const sorted = [...keys].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(keys).toEqual(sorted);
    expect(keys.map((k) => k[0])).toEqual(["a.md", "docs/tasks", "docs/tasks/0003-x.md", "docs/tasks/0003-x.md", "docs/tasks/0003-x.md", "z.md"]);
  });
});

describe("مدل‌محور: درج یک عیبِ شناخته در مجموعهٔ سالمِ تصادفی (۲۰۰ بذر)", () => {
  type Defect = { code: ViolationCode; apply: (files: ArtifactFile[], i: number) => ArtifactFile[] };
  const defects: Defect[] = [
    { code: "EMPTY", apply: (f, i) => f.map((x, j) => (j === i ? { ...x, text: j % 2 ? "" : " \n" } : x)) },
    { code: "TOO_SHORT", apply: (f, i) => f.map((x, j) => (j === i ? { ...x, text: shrinkKeepingHeading(x.text) } : x)) },
    { code: "BAD_ENCODING", apply: (f, i) => f.map((x, j) => (j === i ? { ...x, text: x.text + "\ufffd\n" } : x)) },
    { code: "CONFLICT_MARKER", apply: (f, i) => f.map((x, j) => (j === i ? { ...x, text: x.text + "<<<<<<< HEAD\n" } : x)) },
    { code: "NO_H1", apply: (f, i) => f.map((x, j) => (j === i ? { ...x, text: "\n" + x.text } : x)) },
    { code: "NO_FINAL_NEWLINE", apply: (f, i) => f.map((x, j) => (j === i ? { ...x, text: x.text.trimEnd() } : x)) },
  ];
  it("هر عیب دقیقاً یک بار و فقط روی همان فایل گزارش می‌شود", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 7919);
      const base = corpus(2 + Math.floor(r() * 6));
      const i = Math.floor(r() * base.length);
      const d = defects[Math.floor(r() * defects.length)] as Defect;
      const v = checkDocFiles(d.apply(base, i));
      const target = (base[i] as ArtifactFile).path;
      // سرتیترِ ADR/یادداشتِ تحویل همان خطِ اول است؛ شکستنِ «# » برای آن‌ها ناگزیر همخوانیِ شماره را هم می‌شکند.
      const want = d.code === "NO_H1" && !target.startsWith("docs/tasks/") ? [["HEADING_NUMBER_MISMATCH", target], ["NO_H1", target]] : [[d.code, target]];
      expect(v.map((x) => [x.code, x.path]), `seed ${seed}`).toEqual(want);
    }
  });
  it("حذفِ یک فایلِ میانی ⇒ دقیقاً یک NUMBER_GAP؛ حذفِ آخر ⇒ بی‌نقض", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 104729);
      const k = 3 + Math.floor(r() * 6);
      const drop = 1 + Math.floor(r() * k); // شمارهٔ حذف‌شده
      const files = corpus(k).filter((f) => !f.path.startsWith("docs/tasks/") || !f.path.includes(`/${n4(drop)}-`));
      const v = checkDocFiles(files);
      if (drop === k) expect(v, `seed ${seed}`).toEqual([]);
      else expect(v.map((x) => [x.code, x.path]), `seed ${seed}`).toEqual([["NUMBER_GAP", "docs/tasks"]]);
    }
  });
  it("کپیِ یک فایل با slugِ دیگر ⇒ دقیقاً یک DUPLICATE_NUMBER", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 15485863);
      const k = 2 + Math.floor(r() * 6);
      const base = corpus(k);
      const i = Math.floor(r() * base.length);
      const src = base[i] as ArtifactFile;
      const copy = { ...src, path: src.path.replace(/\.md$/, "-copy.md") };
      expect(checkDocFiles([...base, copy]).map((x) => x.code), `seed ${seed}`).toEqual(["DUPLICATE_NUMBER"]);
    }
  });
});

describe("findEmptyFiles / allowlist", () => {
  it("فقط ۰ بایت ایراد است", () => {
    const v = findEmptyFiles([{ path: "src/a.ts", bytes: 0 }, { path: "src/b.ts", bytes: 1 }, { path: "tooling\\c.test.ts", bytes: 0 }]);
    expect(v.map((x) => x.path)).toEqual(["src/a.ts", "tooling/c.test.ts"]);
    expect(v.every((x) => x.code === "EMPTY")).toBe(true);
  });
  it("allowlist مسیرِ دقیق را معاف می‌کند، نه پیشوند را؛ کلیدهای prototype معاف نیستند", () => {
    const allow = { "src/a.ts": "دلیل" };
    expect(findEmptyFiles([{ path: "src/a.ts", bytes: 0 }], allow)).toEqual([]);
    expect(findEmptyFiles([{ path: "src/a.tsx", bytes: 0 }], allow)).toHaveLength(1);
    expect(findEmptyFiles([{ path: "constructor", bytes: 0 }, { path: "__proto__", bytes: 0 }, { path: "toString", bytes: 0 }], allow)).toHaveLength(3);
  });
  it("allowlistِ پیش‌فرض عمداً خالی، منجمد و معتبر است", () => {
    expect(Object.keys(EMPTY_FILE_ALLOWLIST)).toEqual([]);
    expect(Object.isFrozen(EMPTY_FILE_ALLOWLIST)).toBe(true);
    expect(checkAllowlist(EMPTY_FILE_ALLOWLIST)).toEqual([]);
  });
  it("مدخلِ بی‌دلیل نقض است", () => {
    expect(checkAllowlist({ "a.ts": "", "b.ts": "  ", "c.ts": "دلیل" }).map((v) => v.path)).toEqual(["a.ts", "b.ts"]);
    expect(checkAllowlist({ "a.ts": "" })[0]?.code).toBe("ALLOWLIST_NO_REASON");
  });
});

describe("منبع: بی‌I/O و ثابت‌ها", () => {
  const src = readFileSync(join(ROOT, "tooling/artifact-integrity.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("منطقِ خالص: بی‌import، بی‌ساعت، بی‌تصادف، بی‌شبکه، بی‌process", () => {
    for (const bad of [/\bimport\b/, /\brequire\(/, /node:/, /\bDate\b/, /Math\.random/, /\bfetch\(/, /process\./, /readFileSync|statSync|readdirSync/]) {
      expect(code, String(bad)).not.toMatch(bad);
    }
  });
  it("سه سریِ شماره‌دار و حداقلِ اندازه قفل‌اند", () => {
    expect(SERIES_DIRS).toEqual(["docs/tasks", "docs/handoffs", "docs/adr"]);
    expect(MIN_SERIES_BYTES).toBe(256);
  });
});
