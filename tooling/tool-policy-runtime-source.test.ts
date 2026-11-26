/**
 * نگهبانِ کد منبعِ tool-policy-runtime (ADR-0073؛ در tooling چون ماژول نباید node:fs را import کند): ریشهٔ I/O است ولی خودش
 * هیچ اتصال/مهاجرت/تایمرِ مستقیم/ساعتِ دیواری/محیط ندارد؛ فقط به رابطِ عمومیِ پنج ماژولِ اعلام‌شده وابسته است؛ `performance` فقط در clock.ts؛
 * هرگز throw؛ و ترتیب‌های حیاتی (نگهبانِ مهلت پیش از پیش‌بازرسی؛ بازبینیِ نسل پیش از آغازِ حلقه) در متن ثابت می‌شود.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/registry";
import { HIGH_RISK_MODULES } from "./git-discipline";

const DIR = join(__dirname, "..", "src", "modules", "tool-policy-runtime");
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "test-kit.ts")
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const byName = (n: string): string => sources.find((s) => s.name === n)!.code;

const ALLOWED = ["@/modules/tool-policy-refresher", "@/modules/tool-policy-source", "@/modules/tool-policy-admin", "@/modules/tool-policy-store-pg", "@/modules/settlement-runtime"];

describe("tool-policy-runtime · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["clock.ts", "index.ts", "pg-runtime.ts", "runtime.ts", "types.ts"]);
  });

  it("هیچ فایلی از process، Date، Math.random، fetch، تایمرِ مستقیم، crypto، require، eval، console یا globalThis استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["process", /\bprocess\b/],
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["timers", /\b(set|clear)(Timeout|Interval|Immediate)\b/],
      ["crypto", /\bcrypto\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
      ["globalThis", /\bglobalThis\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("performance فقط در clock.ts (و آنجا هست)", () => {
    for (const s of sources) if (s.name !== "clock.ts") expect(s.code, `${s.name}: performance`).not.toMatch(/\bperformance\b/);
    expect(byName("clock.ts")).toMatch(/performance\.now\(\)/);
  });

  it("importها فقط از رابطِ عمومیِ پنج ماژولِ اعلام‌شده و فایل‌های نسبی؛ بی‌import پویا، بی‌node:، بی‌drizzle/pg/@/db", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bimport\s*\(/);
      expect(s.code, s.name).not.toMatch(/\b(node:|drizzle-orm|@\/db)/);
      expect(s.code, s.name).not.toMatch(/from\s+["']pg["']/);
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        expect(ALLOWED, `${s.name}: ${spec}`).toContain(spec);
      }
    }
  });

  it("هرگز اتصال نمی‌سازد، استخر را نمی‌بندد، مهاجرت نمی‌کند و DDL/DML نمی‌نویسد", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: Pool`).not.toMatch(/\bnew\s+Pool\b/);
      expect(s.code, `${s.name}: drizzle()`).not.toMatch(/\bdrizzle\s*\(/);
      expect(s.code, `${s.name}: end()`).not.toMatch(/\.end\s*\(/);
      expect(s.code, `${s.name}: migrate`).not.toMatch(/\.\s*migrate\s*\(/);
      expect(s.code, `${s.name}: SQL`).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/);
      expect(s.code, `${s.name}: admin writes`).not.toMatch(/\.\s*(set|rollbackTo|append)\s*\(/);
    }
  });

  it("ثبت در registry: لایهٔ ۷، ناخالص، humanReview، dependsOn دقیقاً پنج ماژول؛ و در HIGH_RISK_MODULES", () => {
    const m = MODULES.find((x) => x.name === "tool-policy-runtime");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ layer: 7, humanReview: true, pure: false });
    expect([...m!.dependsOn].sort()).toEqual(ALLOWED.map((a) => a.replace("@/modules/", "")).sort());
    expect(HIGH_RISK_MODULES).toContain("tool-policy-runtime");
  });

  it("هرگز throw؛ هر catch بی‌متغیر است (متنِ استثنا گرفته نمی‌شود)", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: throw`).not.toMatch(/\bthrow\b/);
      expect(s.code, `${s.name}: catch(e)`).not.toMatch(/\bcatch\s*\(/);
    }
  });

  it("نگهبانِ مهلتِ پیش‌بازرسی پیش از فراخوانیِ آن ساخته می‌شود (تلاشِ بی‌نگهبان ممنوع)", () => {
    const r = byName("runtime.ts");
    expect(r).toMatch(/handle = after\(\(\) => settle\(UNAVAILABLE\), deadlineMs\)/);
    expect(r.indexOf("handle = after(")).toBeGreaterThan(-1);
    expect(r.indexOf("handle = after(")).toBeLessThan(r.indexOf("runPreflight()"));
  });

  it("پس از پیش‌بازرسی، نسلِ start پیش از آغازِ حلقه سنجیده می‌شود (stop در میانهٔ start)", () => {
    const r = byName("runtime.ts");
    const check = r.indexOf("if (mine !== generation)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(r.indexOf("(startFn as Fn).call(refresher)"));
    expect(r.indexOf("const pre = await guardedPreflight()")).toBeLessThan(check);
  });

  it("ساعتِ منبع یکنواست و ساعتِ دیواری فقط به مدیر می‌رسد؛ tuning یک بار خوانده و همان به منبع و حلقه می‌رسد", () => {
    const p = byName("pg-runtime.ts");
    expect(p).toMatch(/createMonotonicClock\(\)/);
    expect(p).toMatch(/createToolPolicyAdmin\(\{ store: store\.value, clock: wallClock as never \}\)/);
    expect(p).toMatch(/createPolicySource\(\{ reader: admin\.value, clock: clock as never, maxStaleMs: tuning\["maxStaleMs"\], refreshTimeoutMs \}\)/);
    expect(p).toMatch(/createPolicyRefresher\(\{ source: source\.value, timer, \.\.\.tuning \} as never\)/);
    expect(p).toMatch(/preflightDeadlineMs: tuning\["attemptDeadlineMs"\]/);
    expect(p).toMatch(/relation:statementTimeoutMs<=refreshTimeoutMs/);
  });

  it("هیچ مقدارِ پول/ارز/حساب/کلید یا نامِ فیلدِ سیاستی در ماژول نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/\b(price|currency|account|apiKey|password|graceMs|maxCallMs|onUnknownCost|ttl)\b/i);
  });
});
