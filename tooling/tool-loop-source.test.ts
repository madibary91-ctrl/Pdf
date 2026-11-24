/**
 * آزمونِ نگهبانِ کد منبع (ADR-0056؛ در tooling چون ماژولِ خالص نباید node:fs را import کند): کنترل‌گر ماشینِ حالتِ خالص است؛ به I/O، ساعت، تصادف، محیط و شبکه دست نمی‌زند
 * و فقط به `ai-gateway` (نوع‌ها + `sumStepSpend`/`encodeToolResults`) وابسته است.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "modules", "tool-loop");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: readFileSync(join(DIR, n), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1") }));

describe("tool-loop · هستهٔ بی‌I/O", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["budget.ts", "canonical.ts", "config.ts", "errors.ts", "index.ts", "loop.ts", "types.ts"]);
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
      ["Promise/async", /\b(async|await|Promise)\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("importها فقط از ai-gateway، فایل‌های نسبی همین ماژول و نوع‌ها", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(spec.startsWith("./") || spec === "@/modules/ai-gateway", `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/import\s*\(/);
      expect(s.code, s.name).not.toMatch(/from\s+["']node:/);
    }
  });

  it("کلید ENV، رشتهٔ اتصال یا قیمت/نام ارائه‌دهندهٔ واقعی در کد نیست", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/sk-[A-Za-z0-9]{10,}|postgres(ql)?:\/\/|api[_-]?key/i);
      // «openai-chat» و «anthropic-messages» برچسبِ قالبِ سیمِ قراردادِ ai-gateway‌اند، نه پیکربندیِ ارائه‌دهنده.
      const code = s.code.replace(/"(openai-chat|anthropic-messages)"/g, '"<fmt>"');
      expect(code, s.name).not.toMatch(/\b(openai|anthropic|gpt-\d|claude)\b/i);
    }
  });
});
