/**
 * آزمونِ نگهبانِ کد منبع (ADR-0016 §۲): هستهٔ ارکستراتور به I/O، ساعت، تصادف و محیط دست نمی‌زند، و فقط به سه ماژولِ
 * اعلام‌شده وابسته است. (مرزهای بین‌ماژولی را `tooling/boundaries.test.ts` هم می‌سنجد.)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: readFileSync(join(DIR, n), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1") }));

describe("ai-orchestrator · هستهٔ بی‌I/O", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(
      ["accounting.ts", "checker.ts", "config.ts", "errors.ts", "ground.ts", "index.ts", "markers.ts", "model-output.ts", "numbers.ts", "orchestrator.ts", "prompt.ts", "request.ts", "types.ts"].sort(),
    );
  });

  it("هیچ فایل منبعی از Date، Math.random، fetch، process، تایمر یا محیط استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["process", /\bprocess\b/],
      ["setTimeout/Interval", /\bset(Timeout|Interval|Immediate)\b/],
      ["performance", /\bperformance\b/],
      ["crypto", /\bcrypto\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("importها فقط از سه ماژول اعلام‌شده، فایل‌های نسبی همین ماژول، و نوع‌ها", () => {
    const allowed = new Set(["@/modules/ai-gateway", "@/modules/retrieval", "@/modules/citation-verifier"]);
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(spec.startsWith("./") || allowed.has(spec), `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/import\s*\(/);
      expect(s.code, s.name).not.toMatch(/from\s+["']node:/);
    }
  });

  it("کلید ENV، رشتهٔ اتصال یا قیمت/نام ارائه‌دهندهٔ واقعی در کد نیست", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/sk-[A-Za-z0-9]{10,}|postgres(ql)?:\/\/|api[_-]?key/i);
      expect(s.code, s.name).not.toMatch(/\b(openai|anthropic|gpt-\d|claude)\b/i);
    }
  });
});
