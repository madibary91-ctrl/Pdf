/**
 * نگهبانِ کد منبعِ calc-answer-service (ADR-0061؛ در tooling چون ماژول نباید node:fs را import کند): بی‌I/O، بی‌process.env، بی‌ساعت،
 * فقط به شش ماژولِ اعلام‌شده وابسته، هیچ‌گاه پرتاب نمی‌کند، متنِ استثنا را نمی‌گیرد، و مدل/فهرستِ ابزار را فقط خودش می‌گذارد.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/registry";

const DIR = join(__dirname, "..", "src", "modules", "calc-answer-service");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const code = (name: string): string => sources.find((s) => s.name === name)!.code;
const DEPS = ["ai-gateway", "tool-loop", "calc-tools", "calc-tool-executor", "calc-answer-cards", "tool-runner"];

describe("calc-answer-service · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["index.ts", "messages.ts", "run.ts", "service.ts", "types.ts"]);
  });

  it("هیچ فایلی از process، Date، Math.random، fetch، فراخوانیِ تایمر، crypto، console، eval، require یا globalThis استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["process", /\bprocess\b/],
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["timers", /\bset(Timeout|Interval|Immediate)\s*\(/],
      ["performance", /\bperformance\b/],
      ["crypto", /\bcrypto\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
      ["globalThis", /\bglobalThis\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("importها فقط از شش ماژولِ اعلام‌شده و فایل‌های نسبی؛ بی‌import پویا و بی‌node:", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bimport\s*\(/);
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        const mod = /^@\/modules\/([a-z-]+)$/.exec(spec)?.[1];
        expect(mod !== undefined && DEPS.includes(mod), `${s.name}: ${spec}`).toBe(true);
      }
    }
  });

  it("ثبت در registry: لایهٔ ۴، humanReview، ناخالص (async)، و dependsOn دقیقاً همان شش ماژول", () => {
    const m = MODULES.find((x) => x.name === "calc-answer-service");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ layer: 4, humanReview: true, pure: false });
    expect([...m!.dependsOn].sort()).toEqual([...DEPS].sort());
  });

  it("شمارِ try در هر فایل قفل است و هیچ catch متنِ استثنا را نمی‌گیرد؛ throw هرگز", () => {
    const perFile = Object.fromEntries(sources.map((s) => [s.name, (s.code.match(/\btry\s*\{/g) ?? []).length]));
    expect(perFile).toEqual({ "index.ts": 0, "messages.ts": 0, "run.ts": 4, "service.ts": 2, "types.ts": 0 });
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/catch\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.message\b/);
      expect(s.code, s.name).not.toMatch(/\bthrow\b/);
    }
  });

  it("مدل، سقفِ توکن و فهرستِ ابزار فقط از پیکربندیِ سرویس و CALC_TOOLS می‌آید، نه از ورودیِ فراخواننده", () => {
    const c = code("run.ts");
    expect(c).toMatch(/tools: CALC_TOOLS,/);
    expect(c).toMatch(/model: ctx\.model,/);
    expect(c).toMatch(/maxOutputTokens: ctx\.maxOutputTokens,/);
    expect(c).not.toMatch(/input\["(tools|model|maxOutputTokens|continuation|toolChoice|allowParallel|temperature)"\]/);
    expect(c).toMatch(/k !== "messages" && k !== "requestId"/);
  });

  it("پاسخ در برابر ناهمخوانی نمایش داده نمی‌شود: compose ناموفق ⇒ NOT_DISPLAYABLE بی‌issues؛ هزینه حفظ می‌شود", () => {
    const c = code("run.ts");
    expect(c).toMatch(/if \(!composed\.ok\) return fail\("NOT_DISPLAYABLE", \[\], composed\.error\.code, spend\);/);
    expect(c).toMatch(/const spend = cloneSpend\(report\.outcome\.spend\);/);
    expect(c).toMatch(/cloneSpend\(run\.error\.partial\?\.spend\)/);
  });

  it("هر اجرا جمع‌آورنده/مجری/اجراگرِ تازه می‌سازد: هیچ حالتِ ماژول-سطحی (let/var/Map/Set/آرایهٔ سطحِ فایل) در run.ts نیست", () => {
    const c = code("run.ts");
    expect(c).not.toMatch(/^(let|var)\s/m);
    expect(c).not.toMatch(/^(export\s+)?const\s+\w+\s*=\s*(new\s+(Map|Set|WeakMap)|\[)/m);
    expect(c).toMatch(/cards = makeCollector\(ctx\.maxCards\)/);
    expect(c).toMatch(/createToolRunner\(/);
  });

  it("هیچ عددِ حقوقی/کلید/رشتهٔ اتصال و هیچ قالب‌بندیِ عددی در کد نیست", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/sk-[A-Za-z0-9]{10,}|postgres(ql)?:\/\/|api[_-]?key|authorization|bearer/i);
      expect(s.code, s.name).not.toMatch(/openai|anthropic|\btariff(s)?\s*=\s*\[/i);
      expect(s.code, s.name).not.toMatch(/(?<![\w.])\d{4,}(?![\w])/);
      expect(s.code, s.name).not.toMatch(/toLocaleString|Intl\.|toFixed|parseFloat|Number\(/);
    }
  });

  it("تأییدنشدگی را این ماژول نه می‌سازد و نه پایین می‌آورد (فقط از compose می‌آید)", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/reviewPending\s*[:=]\s*(false|true)/);
      expect(s.code, s.name).not.toMatch(/\.reviewPending\s*=/);
    }
  });
});
