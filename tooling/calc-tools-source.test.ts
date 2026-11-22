import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * نگهبانِ منبعِ calc-tools (ADR-0053). در tooling است چون ماژولِ خالص حق ندارد `node:fs` را حتی در آزمونش import کند.
 * سه چیز را قفل می‌کند: خالص‌بودن، وابستگیِ فقط به رابطِ عمومیِ legal-calc و shared-types، و نبودنِ هر عددِ حقوقی در کد.
 */

/* ───────────── نگهبانِ منبع ───────────── */

const DIR = join(__dirname, "..", "src", "modules", "calc-tools");
const SOURCES = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => [f, readFileSync(join(DIR, f), "utf8")] as const);

/** ردّ کردنِ توضیح و رشته‌ها تا فقط «کد» بماند. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""');
}

describe("calc-tools: نگهبانِ منبع (خالص، بی‌عددِ حقوقی)", () => {
  it("فایل‌های منبع پیدا شدند", () => {
    expect(SOURCES.map(([f]) => f).sort()).toEqual(
      ["common.ts", "court-fee-tool.ts", "execute.ts", "index.ts", "json.ts", "late-payment-tool.ts", "schema.ts", "tool-def.ts", "types.ts"].sort(),
    );
  });

  it("خالص: بی‌ساعت، تصادف، شبکه، فایل، env، تایمر، require", () => {
    const banned = /\b(Date|Math\.random|process|fetch|require|setTimeout|setInterval|performance|XMLHttpRequest|globalThis|window|document)\b|node:/;
    for (const [f, src] of SOURCES) expect(banned.test(codeOnly(src)), `${f}: I/O یا ناخالصی`).toBe(false);
  });

  it("فقط به رابطِ عمومیِ legal-calc و shared-types وابسته است (نه internal، نه ماژولِ دیگر)", () => {
    for (const [f, src] of SOURCES) {
      for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1] as string;
        const ok = spec.startsWith("./") || spec === "@/modules/legal-calc" || spec === "@/modules/shared-types";
        expect(ok, `${f}: import «${spec}»`).toBe(true);
      }
    }
  });

  it("هیچ عددِ حقوقی در کد نیست: در فایل‌های ابزار فقط حدّهای ساختاری (۰،۱،۱۲،۳۱،۴۰،۱۰۰،۹۹۹۹)", () => {
    const allowed = new Set(["0", "1", "12", "31", "40", "100", "9999"]);
    for (const [f, src] of SOURCES) {
      if (!/tool\.ts$|common\.ts$/.test(f)) continue;
      for (const m of codeOnly(src).matchAll(/(?<![\w.])\d[\d_]*(?:\.\d+)?(?![\w])/g)) {
        expect(allowed.has(m[0]), `${f}: عددِ مجازنشده ${m[0]}`).toBe(true);
      }
    }
  });

  it("ابزارها هیچ‌چیزی را گرد/جمع/ضرب نمی‌کنند: بی‌Math و بی‌عملگرِ حسابی روی مبلغ", () => {
    for (const [f, src] of SOURCES) {
      if (!/tool\.ts$/.test(f)) continue;
      expect(/\bMath\./.test(codeOnly(src)), `${f}: Math`).toBe(false);
      expect(/[^/*\s]\s*[*%]\s*[^/*\s]/.test(codeOnly(src).replace(/=>/g, "")), `${f}: ضرب/باقیمانده`).toBe(false);
    }
  });
});
