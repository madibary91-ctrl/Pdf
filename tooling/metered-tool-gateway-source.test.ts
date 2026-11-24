/**
 * نگهبانِ کد منبعِ metered-tool-gateway (ADR-0062؛ در tooling چون ماژول نباید node:fs را import کند): بی‌ساعت/تصادف/محیط/شبکه، فقط به
 * سه ماژولِ اعلام‌شده وابسته، هرگز پرتاب نمی‌کند، متنِ استثنا را نمی‌گیرد، بی‌حالتِ سطحِ ماژول، و هیچ عددِ پولی/کلید در کد نیست.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/registry";

const DIR = join(__dirname, "..", "src", "modules", "metered-tool-gateway");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const code = (name: string): string => sources.find((s) => s.name === name)!.code;
const DEPS = ["ai-gateway", "ledger", "metering"];

describe("metered-tool-gateway · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["config.ts", "estimate.ts", "gateway.ts", "index.ts", "observe.ts", "settle.ts", "types.ts"]);
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

  it("importها فقط از سه رابطِ عمومیِ اعلام‌شده و فایل‌های نسبی؛ بی‌import پویا، بی‌node:، بی‌پایگاه", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bimport\s*\(/);
      expect(s.code, s.name).not.toMatch(/\b(pg|drizzle-orm|@\/db)\b/);
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        const mod = /^@\/modules\/([a-z-]+)$/.exec(spec)?.[1];
        expect(mod !== undefined && DEPS.includes(mod), `${s.name}: ${spec}`).toBe(true);
      }
    }
  });

  it("ثبت در registry: لایهٔ ۴، humanReview، ناخالص (async + دفتر)، و dependsOn دقیقاً همان سه ماژول", () => {
    const m = MODULES.find((x) => x.name === "metered-tool-gateway");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ layer: 4, humanReview: true, pure: false });
    expect([...m!.dependsOn].sort()).toEqual([...DEPS].sort());
  });

  it("شمارِ try در هر فایل قفل است و هیچ catch متنِ استثنا را نمی‌گیرد؛ throw هرگز", () => {
    const perFile = Object.fromEntries(sources.map((s) => [s.name, (s.code.match(/\btry\s*\{/g) ?? []).length]));
    expect(perFile).toEqual({ "config.ts": 2, "estimate.ts": 0, "gateway.ts": 6, "index.ts": 0, "observe.ts": 0, "settle.ts": 1, "types.ts": 0 });
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/catch\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.message\b/);
      expect(s.code, s.name).not.toMatch(/\bthrow\b/);
    }
  });

  it("بی‌حالتِ سطحِ ماژول: هیچ let/var/Map/Set/آرایهٔ سطحِ فایل؛ شمارنده و رسیدها فقط درون createMeteredToolGateway", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/^(let|var)\s/m);
      expect(s.code, s.name).not.toMatch(/^(export\s+)?const\s+\w+\s*=\s*(new\s+(Map|WeakMap)|\[\s*\])/m);
    }
    const g = code("gateway.ts");
    expect(g.indexOf("let counter")).toBeGreaterThan(g.indexOf("export function createMeteredToolGateway"));
    expect(g.indexOf("const receipts")).toBeGreaterThan(g.indexOf("export function createMeteredToolGateway"));
  });

  it("شمارنده پیش از هر await و همگام افزایش می‌یابد (شناسهٔ رزروِ گام‌های هم‌زمان)", () => {
    expect(code("gateway.ts")).toMatch(/const n = \+\+counter;[^\n]*\n\s*try \{\s*return await run\(n, input, options\);/);
  });

  it("درخواست یک‌بار عکس گرفته می‌شود و همان عکس هم برآورد و هم به دروازهٔ درونی می‌رسد", () => {
    const g = code("gateway.ts");
    expect(g).toMatch(/const snap = snapshot\(input,/);
    expect(g).toMatch(/cfg\.gateway\.completeStep\(snap\.request, options\)/);
    expect(g).not.toMatch(/\.completeStep\(input/);
  });

  it("دروازهٔ درونی فقط پس از رزروِ موفق و تازه (بی‌replayed) صدا زده می‌شود", () => {
    const g = code("gateway.ts");
    const reserve = g.indexOf("cfg.ledger.reserve(");
    const replay = g.indexOf("reserved.value.replayed");
    const call = g.indexOf("cfg.gateway.completeStep(");
    expect(reserve).toBeGreaterThan(0);
    expect(replay).toBeGreaterThan(reserve);
    expect(call).toBeGreaterThan(replay);
    expect(g.match(/cfg\.gateway\.completeStep\(/g)).toHaveLength(1);
  });

  it("منطقِ برآورد/هزینه/قیمت را بازنویسی نمی‌کند: computeCost و inputTokenBound و ثابت‌های metering/ai-gateway بازاستفاده می‌شوند", () => {
    expect(code("estimate.ts")).toMatch(/computeCost\(/);
    expect(code("estimate.ts")).toMatch(/inputTokenBound\(/);
    expect(code("observe.ts")).toMatch(/NEVER_REACHED_CODES/);
    expect(code("settle.ts")).toMatch(/SETTLE_ATTEMPTS/);
    expect(code("settle.ts")).toMatch(/ATTEMPT_ID/);
    expect(code("config.ts")).toMatch(/resolveMeteringConfig\(/);
  });

  it("هیچ عددِ پولی/کلید/رشتهٔ اتصال و هیچ قالب‌بندیِ عددی در کد نیست", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/sk-[A-Za-z0-9]{10,}|postgres(ql)?:\/\/|api[_-]?key|authorization|bearer|password/i);
      expect(s.code, s.name).not.toMatch(/(?<![\w.])\d{4,}(?![\w])/);
      expect(s.code, s.name).not.toMatch(/toLocaleString|Intl\.|toFixed|parseFloat|Number\(/);
    }
  });
});
