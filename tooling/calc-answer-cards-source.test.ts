/**
 * نگهبانِ کد منبعِ calc-answer-cards (ADR-0060؛ در tooling چون ماژول نباید node:fs را import کند): خالص و همگام است،
 * فقط به calc-tools، calc-tool-executor و tool-runner وابسته است، عدد/نرخِ حقوقی ندارد،
 * متنِ استثنا را هرگز نمی‌گیرد و «تأییدشده» را فقط شکست‌بسته می‌سازد.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "src", "modules", "calc-answer-cards");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const code = (name: string): string => sources.find((s) => s.name === name)!.code;

describe("calc-answer-cards · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["card.ts", "collector.ts", "compose.ts", "index.ts", "messages.ts", "types.ts"]);
  });

  it("هیچ فایلی از process، Date، Math.random، fetch، تایمر، crypto، console، eval، require یا async/Promise استفاده نمی‌کند", () => {
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

  it("importها فقط از calc-tools، calc-tool-executor، tool-runner و فایل‌های نسبی؛ بی‌import پویا و بی‌node:", () => {
    const allowed = ["@/modules/calc-tools", "@/modules/calc-tool-executor", "@/modules/tool-runner"];
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(spec.startsWith("./") || allowed.includes(spec), `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/import\s*\(/);
      expect(s.code, s.name).not.toMatch(/from\s+["']node:/);
    }
  });

  it("استثنا هرگز نام‌گذاری یا بازتاب نمی‌شود: بی‌catch(e)، بی‌.message/.stack؛ هر try با catchِ بی‌متغیر و فقط در جای مجاز", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\.stack\b/);
      expect(s.code, s.name).not.toMatch(/\.message\b/);
      expect(s.code, s.name).not.toMatch(/catch\s*\(/);
      const tries = (s.code.match(/\btry\s*\{/g) ?? []).length;
      const catches = (s.code.match(/\bcatch\s*\{/g) ?? []).length;
      expect(catches, s.name).toBe(tries);
    }
    const perFile = Object.fromEntries(sources.map((s) => [s.name, (s.code.match(/\btry\s*\{/g) ?? []).length]));
    expect(perFile).toEqual({ "card.ts": 1, "collector.ts": 1, "compose.ts": 1, "index.ts": 0, "messages.ts": 0, "types.ts": 0 });
  });

  it("throw فقط در card.ts و collector.ts و فقط با پیامِ ثابت (new Error(CONST))", () => {
    for (const s of sources) {
      const throws = s.code.match(/\bthrow\b[^;]*;/g) ?? [];
      if (s.name === "card.ts" || s.name === "collector.ts") for (const t of throws) expect(t, s.name).toMatch(/^throw new Error\([A-Z_]+\);$/);
      else expect(throws, s.name).toEqual([]);
    }
    expect((code("card.ts").match(/\bthrow\b/g) ?? []).length).toBeGreaterThan(5);
  });

  it("هیچ عددِ حقوقی/کلید/رشتهٔ اتصال و هیچ قالب‌بندیِ عددی در کد نیست", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/sk-[A-Za-z0-9]{10,}|postgres(ql)?:\/\/|api[_-]?key/i);
      expect(s.code, s.name).not.toMatch(/openai|anthropic|\btariff(s)?\s*=\s*\[/i);
      expect(s.code, s.name).not.toMatch(/(?<![\w.])\d{4,}(?![\w])/);
      expect(s.code, s.name).not.toMatch(/toLocaleString|Intl\.|toFixed|parseFloat|Number\(/);
    }
  });

  it("«تأییدشده» فقط شکست‌بسته: isPending یایِ پرچم، وضعیت، بازبین و تاریخ؛ و تأییدنشدگی در compose فقط با ‘||’ بالا می‌رود", () => {
    expect(code("card.ts")).toMatch(/return\s+reviewPendingFlag\s*\|\|\s*status\s*!==\s*"legally-verified"\s*\|\|\s*!nonEmpty\(reviewedBy\)\s*\|\|\s*!nonEmpty\(reviewedOn\)/);
    const c = code("compose.ts");
    expect(c).toMatch(/const reviewPending = p\.outcomePending \|\| anyRunPending \|\| cards\.some\(\(c\) => c\.reviewPending\)/);
    expect(c).toMatch(/r\.reviewPending && !c\.reviewPending \? \{ \.\.\.c, reviewPending: true/);
    for (const s of sources) expect(s.code, s.name).not.toMatch(/reviewPending\s*[:=]\s*false/);
  });

  it("متنِ مدل (outcome.text) دست‌نخورده می‌ماند: فقط خوانده و عیناً برگردانده می‌شود، بی‌تغییر با replace/trim/slice", () => {
    const c = code("compose.ts");
    expect(c).toMatch(/text = outcome\["text"\]/);
    expect(c).not.toMatch(/\btext\s*\.\s*(replace|trim|slice|substring|split|concat)\b/);
    expect(c).not.toMatch(/outcome\["text"\]\s*\./);
  });
});
