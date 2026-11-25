/**
 * نگهبانِ کد منبعِ tool-policy-source (ADR-0071؛ در tooling چون ماژول نباید node:fs را import کند): ماژولِ خالص: بی‌I/O، بی‌process.env،
 * بی‌ساعتِ سیستم، بی‌تایمر، بی‌تصادف؛ فقط به tool-policy و tool-policy-admin (رابطِ عمومی) وابسته؛ هرگز نمی‌پرتابد و متنِ استثنا را نمی‌گیرد؛
 * هیچ عدد/نامِ فیلدِ سیاست، هیچ مقدارِ پول و هیچ پیش‌فرضِ بی‌صدا (فقط projectToolPolicy روی سیاستِ کاملِ خوانده‌شده).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/registry";
import { HIGH_RISK_MODULES } from "./git-discipline";

const DIR = join(__dirname, "..", "src", "modules", "tool-policy-source");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const byName = (n: string): string => sources.find((s) => s.name === n)!.code;

describe("tool-policy-source · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["config.ts", "evaluate.ts", "index.ts", "source.ts", "types.ts"]);
  });

  it("هیچ فایلی از process، Date، Math.random، fetch، تایمر، performance، crypto، require، eval، console یا globalThis استفاده نمی‌کند", () => {
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

  it("importها فقط از tool-policy و tool-policy-admin (رابطِ عمومی) و فایل‌های نسبی؛ بی‌import پویا و بی‌node:", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bimport\s*\(/);
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        expect(["@/modules/tool-policy", "@/modules/tool-policy-admin"], `${s.name}: ${spec}`).toContain(spec);
      }
    }
  });

  it("ثبت در registry: لایهٔ ۶، خالص، humanReview، dependsOn دقیقاً tool-policy و tool-policy-admin؛ و در HIGH_RISK_MODULES", () => {
    const m = MODULES.find((x) => x.name === "tool-policy-source");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ layer: 6, humanReview: true, pure: true });
    expect([...m!.dependsOn].sort()).toEqual(["tool-policy", "tool-policy-admin"]);
    expect(HIGH_RISK_MODULES).toContain("tool-policy-source");
  });

  it("هرگز throw؛ هر catch بی‌متغیر است (متنِ استثنا گرفته نمی‌شود)", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: throw`).not.toMatch(/\bthrow\b/);
      expect(s.code, `${s.name}: catch(e)`).not.toMatch(/\bcatch\s*\(/);
    }
  });

  it("ماژول هیچ مقدارِ پول (قیمت، ارز، حساب، کلید) و هیچ نامِ فیلدِ سیاست ندارد", () => {
    for (const s of sources) {
      const code = s.code.replace(/"[^"]*"/g, '""');
      for (const re of [/\bprice\b/i, /\bcurrency\b/i, /\btenantId\b/, /\baccountId\b/, /\bapiKey\b/i, /\bendpoint\b/i, /\bIRR\b/]) expect(code, `${s.name}: ${re}`).not.toMatch(re);
      for (const re of [/\bgraceMs\b/, /\bmaxCallMs\b/, /\breservationTtlMs\b/, /\bonUnknownCost\b/, /\bmaxSteps\b/, /\bmaxCards\b/, /\btimeoutMs\b/]) expect(code, `${s.name}: ${re}`).not.toMatch(re);
    }
  });

  it("پیش‌فرضِ بی‌صدا ممنوع: DEFAULT_TOOL_POLICY هرگز import نمی‌شود و projectToolPolicy بی‌آرگومان صدا زده نمی‌شود", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: DEFAULT_TOOL_POLICY`).not.toMatch(/DEFAULT_TOOL_POLICY/);
      expect(s.code, `${s.name}: projectToolPolicy()`).not.toMatch(/projectToolPolicy\s*\(\s*\)/);
    }
    const ev = byName("evaluate.ts");
    // پیش از نگاشت: سیاست باید شیءِ کامل و نقطهٔ ثابتِ resolve باشد (وگرنه `undefined`/ناقص با پیش‌فرض پر می‌شد)
    expect(ev).toMatch(/typeof policy !== "object" \|\| policy === null/);
    expect(ev).toMatch(/stable\(resolved\.value\) !== stable\(policy\)/);
  });

  it("کلیدهای config فقط از چهار گزینهٔ شناخته‌شده و کرانِ سقف‌ها یک‌جاست", () => {
    const cfg = byName("config.ts");
    expect(cfg).toMatch(/const KEYS = \["reader", "clock", "maxStaleMs", "refreshTimeoutMs"\] as const/);
    for (const s of sources.filter((x) => x.name !== "config.ts")) expect(s.code, s.name).not.toMatch(/\b86_400_000\b|\b300_000\b/);
  });
});
