/**
 * نگهبانِ کد منبعِ tool-policy-refresher (ADR-0072؛ در tooling چون ماژول نباید node:fs را import کند): ماژولِ خالص: زمان‌سنج فقط پورتِ تزریقی است
 * (بی‌setTimeout/setInterval/Date/process)، فقط به رابطِ عمومیِ tool-policy-source وابسته، هرگز نمی‌پرتابد و متنِ استثنا را نمی‌گیرد،
 * و هیچ مقدارِ پول یا نامِ فیلدِ سیاست در آن نیست.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/registry";
import { HIGH_RISK_MODULES } from "./git-discipline";

const DIR = join(__dirname, "..", "src", "modules", "tool-policy-refresher");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const byName = (n: string): string => sources.find((s) => s.name === n)!.code;

describe("tool-policy-refresher · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["config.ts", "index.ts", "refresher.ts", "types.ts"]);
  });

  it("هیچ فایلی از process، Date، Math.random، fetch، تایمرِ مستقیم، performance، crypto، require، eval، console یا globalThis استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["process", /\bprocess\b/],
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["timers", /\b(set|clear)(Timeout|Interval|Immediate)\b/],
      ["performance", /\bperformance\b/],
      ["crypto", /\bcrypto\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
      ["globalThis", /\bglobalThis\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("importها فقط از tool-policy-source (رابطِ عمومی) و فایل‌های نسبی؛ بی‌import پویا و بی‌node:", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bimport\s*\(/);
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        expect(["@/modules/tool-policy-source"], `${s.name}: ${spec}`).toContain(spec);
      }
    }
  });

  it("ثبت در registry: لایهٔ ۶، خالص، humanReview، dependsOn دقیقاً tool-policy-source؛ و در HIGH_RISK_MODULES", () => {
    const m = MODULES.find((x) => x.name === "tool-policy-refresher");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ layer: 6, humanReview: true, pure: true });
    expect([...m!.dependsOn]).toEqual(["tool-policy-source"]);
    expect(HIGH_RISK_MODULES).toContain("tool-policy-refresher");
  });

  it("هرگز throw؛ هر catch بی‌متغیر است (متنِ استثنا گرفته نمی‌شود)", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: throw`).not.toMatch(/\bthrow\b/);
      expect(s.code, `${s.name}: catch(e)`).not.toMatch(/\bcatch\s*\(/);
    }
  });

  it("setInterval ممنوع و فقط زمان‌سنجِ تک‌شلیک: حلقه با after (نه تایمرِ تکرارشونده) ساخته شده و هر تلاش نگهبانِ مهلت دارد", () => {
    const r = byName("refresher.ts");
    expect(r).toMatch(/after\(\(\) => settle\(attempt, TIMED_OUT, true\), attemptDeadlineMs\)/);
    expect(r).toMatch(/nextHandle = after\(\(\) => onTick\(mine\), delayMs\)/);
    // نگهبان پیش از فراخوانیِ منبع ساخته می‌شود (تلاشِ بی‌نگهبان ممکن نیست)
    expect(r.indexOf("attempt.watchdog = after(")).toBeGreaterThan(-1);
    expect(r.indexOf("attempt.watchdog = after(")).toBeLessThan(r.indexOf("resolve(refresh())"));
  });

  it("نتیجهٔ منبع ورودیِ ناشناخته است: فقط ok === true موفقیت است", () => {
    const r = byName("refresher.ts");
    expect(r).toMatch(/if \(ok === true\) return OK;/);
    expect(r).not.toMatch(/\bresult\s*\.\s*value\b|\.value\s*\.\s*(outcome|version)/);
  });

  it("ماژول هیچ مقدارِ پول (قیمت، ارز، حساب، کلید) و هیچ نامِ فیلدِ سیاست ندارد", () => {
    for (const s of sources) {
      const code = s.code.replace(/"[^"]*"/g, '""');
      for (const re of [/\bprice\b/i, /\bcurrency\b/i, /\btenantId\b/, /\baccountId\b/, /\bapiKey\b/i, /\bendpoint\b/i, /\bIRR\b/]) expect(code, `${s.name}: ${re}`).not.toMatch(re);
      for (const re of [/\bgraceMs\b/, /\bmaxCallMs\b/, /\breservationTtlMs\b/, /\bonUnknownCost\b/, /\bmaxSteps\b/, /\bmaxCards\b/, /\btimeoutMs\b/, /\bprojection\b/i]) expect(code, `${s.name}: ${re}`).not.toMatch(re);
    }
  });

  it("کلیدهای config فقط از هفت گزینهٔ شناخته‌شده و سقفِ کران‌ها یک‌جاست", () => {
    const cfg = byName("config.ts");
    expect(cfg).toMatch(/const KEYS = \["source", "timer", "intervalMs", "retryMs", "attemptDeadlineMs", "refreshTimeoutMs", "maxStaleMs"\] as const/);
    for (const s of sources.filter((x) => x.name !== "config.ts")) expect(s.code, s.name).not.toMatch(/\b3_600_000\b|\b300_000\b|\b86_400_000\b/);
  });
});
