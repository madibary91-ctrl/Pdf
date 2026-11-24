/**
 * آزمونِ نگهبانِ کد منبع (ADR-0058؛ در tooling چون ماژول نباید node:fs را import کند): مجری فقط به `ai-gateway` و `tool-loop` وابسته است،
 * به محیط/شبکه/ساعت/تصادف دست نمی‌زند، و تنها تایمرِ جهانیِ `config.ts` پیش‌فرضِ تزریق‌پذیرِ آن است.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "modules", "tool-runner");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("tool-runner · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["config.ts", "errors.ts", "index.ts", "race.ts", "runner.ts", "tools.ts", "types.ts"]);
  });

  it("هیچ فایلی از process، Date، Math.random، fetch، crypto، console، eval یا require استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["process", /\bprocess\b/],
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["performance", /\bperformance\b/],
      ["crypto", /\bcrypto\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
      ["setInterval/Immediate", /\bset(Interval|Immediate)\b/],
      ["queueMicrotask", /\bqueueMicrotask\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("تایمرِ جهانی فقط در config.ts و فقط به‌صورتِ globalThis.setTimeout/clearTimeout (پیش‌فرضِ تزریق‌پذیر)", () => {
    for (const s of sources) {
      const bare = s.code.replace(/globalThis\s*\.\s*(setTimeout|clearTimeout)/g, "");
      expect(bare, s.name).not.toMatch(/(?<![.\w])(setTimeout|clearTimeout)\s*\(/);
      if (s.name !== "config.ts") expect(s.code, s.name).not.toMatch(/globalThis/);
    }
  });

  it("importها فقط از ai-gateway، tool-loop و فایل‌های نسبیِ همین ماژول؛ بی‌import پویا و بی‌node:", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(spec.startsWith("./") || spec === "@/modules/ai-gateway" || spec === "@/modules/tool-loop", `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/import\s*\(/);
      expect(s.code, s.name).not.toMatch(/from\s+["']node:/);
    }
  });

  it("کلید، رشتهٔ اتصال یا نام ارائه‌دهندهٔ واقعی در کد نیست و هیچ ابزارِ مشخصی (calc-tools) به مجری گره نخورده", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/sk-[A-Za-z0-9]{10,}|postgres(ql)?:\/\/|api[_-]?key/i);
      expect(s.code, s.name).not.toMatch(/openai|anthropic|calc-tools|court_fee|late_payment/i);
    }
  });

  it("پیامِ استثنا هرگز خوانده نمی‌شود: هیچ `catch (e)` که e را به کار ببرد، و هیچ `.message` روی خطاهای ابزار/دروازه", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/catch\s*\(\s*\w+/);
      expect(s.code, s.name).not.toMatch(/\.message\b/);
      expect(s.code, s.name).not.toMatch(/\.stack\b/);
    }
  });
});
