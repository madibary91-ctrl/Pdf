/**
 * نگهبانِ کد منبعِ calc-tool-executor (ADR-0059؛ در tooling چون ماژول نباید node:fs را import کند): پلِ باریک است،
 * فقط به calc-tools و tool-runner وابسته است، به محیط/شبکه/ساعت/تصادف دست نمی‌زند،
 * هیچ عددِ حقوقی/نامِ ابزارِ مشخص ندارد و پیامِ استثنا را هرگز نمی‌گیرد (باگ‌ها باید به مجری برسند).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "modules", "calc-tool-executor");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("calc-tool-executor · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["executor.ts", "index.ts", "types.ts"]);
  });

  it("هیچ فایلی از process، Date، Math.random، fetch، تایمر، crypto، console، eval یا require استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["process", /\bprocess\b/],
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["timers", /\bset(Timeout|Interval|Immediate)\b/],
      ["performance", /\bperformance\b/],
      ["crypto", /\bcrypto\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
      ["globalThis", /\bglobalThis\b/],
      ["async/Promise", /\b(async|await|Promise)\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("importها فقط از calc-tools، tool-runner و فایل‌های نسبی؛ بی‌import پویا و بی‌node:", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(spec.startsWith("./") || ["@/modules/calc-tools", "@/modules/tool-runner"].includes(spec), `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/import\s*\(/);
      expect(s.code, s.name).not.toMatch(/from\s+["']node:/);
    }
  });

  it("خطای محاسبه/ناظر گرفته نمی‌شود: فقط یک try/catchِ مجازِ اعتبارسنجیِ گزینه‌ها در executor.ts و هرگز .message/stack از استثنا", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\.stack\b/);
      expect(s.code, s.name).not.toMatch(/catch\s*\(\s*\w+\s*\)/);
    }
    const ex = sources.find((s) => s.name === "executor.ts")!.code;
    expect((ex.match(/\btry\s*\{/g) ?? []).length).toBe(1);
    // آن یک try باید پیش از تعریفِ executor بسته شود (اجراکننده try ندارد).
    const tryAt = ex.indexOf("try {");
    expect(tryAt).toBeGreaterThan(-1);
    expect(tryAt).toBeLessThan(ex.indexOf("const executor"));
  });

  it("هیچ عددِ حقوقی/نامِ ابزارِ مشخص، کلید یا رشتهٔ اتصال در کد نیست", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/sk-[A-Za-z0-9]{10,}|postgres(ql)?:\/\/|api[_-]?key/i);
      expect(s.code, s.name).not.toMatch(/court_fee|late_payment|openai|anthropic|\btariff(s)?\s*=\s*\[/i);
      // هیچ عددِ ≥ ۴ رقمی (نرخ/آستانه/سال) در کد منبع نیست
      expect(s.code, s.name).not.toMatch(/(?<![\w.])\d{4,}(?![\w])/);
    }
  });

  it("reviewPending فقط شکست‌بسته محاسبه می‌شود (دو نشانه)، نه با ‘||’ حذف‌شونده یا مقدارِ ثابتِ false", () => {
    const ex = sources.find((s) => s.name === "executor.ts")!.code;
    expect(ex).toMatch(/v\.reviewPending\s*\|\|\s*v\.review\.status\s*!==\s*"legally-verified"/);
    expect(ex).not.toMatch(/reviewPending\s*[:=]\s*false/);
  });
});
