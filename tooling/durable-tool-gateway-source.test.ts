/**
 * نگهبانِ کد منبعِ durable-tool-gateway (ADR-0063؛ در tooling چون ماژول نباید node:fs را import کند): بی‌ساعت/تصادف/محیط/شبکه، فقط به
 * دو ماژولِ اعلام‌شده وابسته، هرگز نمی‌پرتابد، متنِ استثنا را نمی‌گیرد، بی‌حالتِ سطحِ ماژول، منطقِ پول را بازنویسی نمی‌کند و هیچ عددِ پولی ندارد.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/registry";

const DIR = join(__dirname, "..", "src", "modules", "durable-tool-gateway");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const all = readdirSync(DIR).filter((n) => n.endsWith(".ts"));
const sources = all
  .filter((n) => !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const code = (name: string): string => sources.find((s) => s.name === name)!.code;
/** وابستگیِ کدِ منبع. */
const SRC_DEPS = ["metered-tool-gateway", "settlement"];
/** وابستگیِ اعلام‌شده در registry = کد منبع + ابزارِ آزمون (ledger و ai-gateway فقط در test-kit). */
const REG_DEPS = ["ai-gateway", "ledger", "metered-tool-gateway", "settlement"];

describe("durable-tool-gateway · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["gateway.ts", "index.ts"]);
  });

  it("هیچ فایلی از process، Date، Math.random، fetch، تایمر، crypto، console، eval، require یا globalThis استفاده نمی‌کند", () => {
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

  it("importها فقط از دو رابطِ عمومیِ منبع و فایل‌های نسبی؛ بی‌import پویا، بی‌node:، بی‌پایگاه", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bimport\s*\(/);
      expect(s.code, s.name).not.toMatch(/\b(pg|drizzle-orm|@\/db)\b/);
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        const mod = /^@\/modules\/([a-z-]+)$/.exec(spec)?.[1];
        expect(mod !== undefined && SRC_DEPS.includes(mod), `${s.name}: ${spec}`).toBe(true);
      }
    }
  });

  it("ثبت در registry: لایهٔ ۵، humanReview، ناخالص، و dependsOn دقیقاً همان چهار ماژول؛ کد منبع از ledger/ai-gateway مستقیم نمی‌خواند", () => {
    const m = MODULES.find((x) => x.name === "durable-tool-gateway");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ layer: 5, humanReview: true, pure: false });
    expect([...m!.dependsOn].sort()).toEqual([...REG_DEPS].sort());
    for (const s of sources) expect(s.code, s.name).not.toMatch(/@\/modules\/(ledger|ai-gateway|metering)\b/);
    const kit = strip(readFileSync(join(DIR, "test-kit.ts"), "utf8"));
    expect(kit).toMatch(/@\/modules\/ledger/);
  });

  it("منطقِ پول بازنویسی نمی‌شود: فقط ترکیب؛ بی‌reserve/charge/close/balance و بی‌رسیدِ ساختگی", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\.(reserve|charge|close|grant|refund|balance|journal)\s*\(/);
      expect(s.code, s.name).not.toMatch(/\b(outcome|charged|reserved|shortfall)\s*:/);
    }
  });

  it("شمارِ try قفل است و هیچ catch متنِ استثنا را نمی‌گیرد؛ throw هرگز", () => {
    const perFile = Object.fromEntries(sources.map((s) => [s.name, (s.code.match(/\btry\s*\{/g) ?? []).length]));
    expect(perFile).toEqual({ "gateway.ts": 1, "index.ts": 0 });
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/catch\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.message\b/);
      expect(s.code, s.name).not.toMatch(/\bthrow\b/);
    }
  });

  it("بی‌حالتِ سطحِ ماژول: هیچ let/var/Map/Set/آرایهٔ سطحِ فایل", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/^(let|var)\s/m);
      expect(s.code, s.name).not.toMatch(/^(export\s+)?const\s+\w+\s*=\s*(new\s+(Map|WeakMap|Set)|\[\s*\])/m);
    }
  });

  it("onUnknownCost تنها یک منبع دارد: همان مقدارِ دروازه به دفترِ ماندگار می‌رود (نه ثابتِ کدشده)", () => {
    const g = code("gateway.ts");
    expect(g).toMatch(/onUnknownCost:\s*metered\["onUnknownCost"\]/);
    expect(g).not.toMatch(/onUnknownCost:\s*"(forfeit|release)"/);
  });

  it("هر کلید فقط یک بار از ورودی خوانده می‌شود (یک destructuring) و ttl ≥ ۲×graceMs در ساخت سنجیده می‌شود", () => {
    const g = code("gateway.ts");
    expect(g.match(/=\s*raw;/g) ?? []).toHaveLength(1);
    expect(g).not.toMatch(/raw\[/);
    expect(g).toMatch(/ttl\s*<\s*2\s*\*\s*graceMs/);
  });

  it("هیچ عدد/قیمت/ارز/نام مدلِ ثابتی در کد نیست (جز ضریبِ ۲ ttl و مقایسهٔ با صفر)", () => {
    for (const s of sources) {
      const nums = [...s.code.matchAll(/(?<![\w.$])(\d[\d_]*(?:\.\d+)?)(?![\w])/g)].map((m) => m[1]);
      expect(nums.filter((n) => n !== "2" && n !== "0"), s.name).toEqual([]);
      expect(s.code, s.name).not.toMatch(/\b(IRR|USD|IRR_MICROS|gpt|claude)\b/i);
    }
  });

  it("هیچ آزمونی skip/only/todo نیست", () => {
    for (const n of all.filter((f) => f.endsWith(".test.ts"))) {
      const c = readFileSync(join(DIR, n), "utf8");
      expect(c, n).not.toMatch(/\b(it|test|describe)\.(skip|only|todo)\b|\bxit\b|\bxdescribe\b/);
    }
  });
});
