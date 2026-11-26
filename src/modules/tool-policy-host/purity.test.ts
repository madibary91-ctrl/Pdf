/**
 * نگهبان منبع tool-policy-host (ADR-0075): فقط رابط عمومیِ `settlement-host` و `tool-policy-runtime`؛ هیچ فایلی `process` را نمی‌شناسد؛
 * بی‌`globalThis`/`console`/`env`/شبکه/فایل؛ بی‌`Date` و بی‌`setTimeout` (زمان‌سنج تزریقی)؛ بی‌اتصالِ پایگاه؛ بی‌اسرار.
 * فقط فایل‌های محصول (نه *.test.ts و کمک‌تست‌ها).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "./index";

const DIR = __dirname;
const NON_PRODUCT = new Set(["test-kit.ts"]);
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !NON_PRODUCT.has(n))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("tool-policy-host · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["config.ts", "host.ts", "index.ts", "probes.ts", "singleton.ts", "types.ts"]);
  });
  it("هیچ فایلی از console، globalThis، fetch، eval، require، crypto، Math.random، performance، setInterval یا setImmediate استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["console", /\bconsole\b/],
      ["globalThis", /\bglobalThis\b/],
      ["global", /\bglobal\b/],
      ["fetch", /\bfetch\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["require", /\brequire\s*\(/],
      ["crypto", /\bcrypto\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["performance", /\bperformance\b/],
      ["setInterval", /\bsetInterval\b/],
      ["setImmediate", /\bsetImmediate\b/],
      ["queueMicrotask", /\bqueueMicrotask\b/],
      ["import()", /import\s*\(/],
      ["env", /\.env\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });
  it("هیچ فایلی process را نمی‌شناسد (آداپتورِ Node در settlement-host است)؛ process.exit مستقیم هم نیست", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: process`).not.toMatch(/(?<![\w-])process(?![\w-])/);
      expect(s.code, `${s.name}: process.exit`).not.toMatch(/\bprocess\s*\.\s*exit\b/);
    }
  });
  it("Date، setTimeout و clearTimeout در هیچ فایلی نیست (زمان‌سنجِ تزریقی)", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: Date`).not.toMatch(/\bDate\b/);
      expect(s.code, `${s.name}: setTimeout`).not.toMatch(/\b(setTimeout|clearTimeout)\b/);
    }
  });
  it("importها فقط: رابط عمومیِ settlement-host و tool-policy-runtime و فایل‌های نسبیِ همین ماژول (بی‌deep import، بی‌پایگاه، بی‌node:)", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+[\"']([^\"']+)[\"']/g)) {
        const spec = m[1] as string;
        expect(spec === "@/modules/settlement-host" || spec === "@/modules/tool-policy-runtime" || /^\.\/[a-z-]+$/.test(spec), `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/\b(drizzle-orm|@\/db|node:)/);
      expect(s.code, s.name).not.toMatch(/from\s+[\"']pg[\"']/);
    }
  });
  it("هرگز اتصال نمی‌سازد، مهاجرت نمی‌کند و استخر را نمی‌بندد", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bnew\s+Pool\b/);
      expect(s.code, s.name).not.toMatch(/\bdrizzle\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.end\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.migrate\s*\(/);
    }
  });
  it("رشتهٔ اتصال، کلید یا اسرار در کد نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{10,}|api[_-]?key|password/i);
  });
  it("رابط عمومی فقط نام‌های اعلام‌شده را صادر می‌کند", () => {
    expect(Object.keys(api).sort()).toEqual(["TOOL_POLICY_HOST_LIMITS", "TOOL_POLICY_HOST_STORE_KEY", "acquireToolPolicyHost", "createToolPolicyHost", "evaluateProbe", "getToolPolicyHost", "probeToolPolicyHost"]);
  });
  it("هر دو سیگنالِ شناخته‌شده فقط SIGTERM و SIGINT‌اند (سیگنالِ تازه آگاهانه افزوده شود)", () => {
    const code = sources.find((s) => s.name === "host.ts")?.code ?? "";
    expect(code).toMatch(/const SIGNALS: readonly HostSignal\[\] = \["SIGTERM", "SIGINT"\];/);
  });
  it("هیچ تستی در این ماژول .skip/.only/xit/todo ندارد", () => {
    for (const n of readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && f !== "purity.test.ts")) {
      expect(readFileSync(join(DIR, n), "utf8"), n).not.toMatch(/\.(skip|only|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/);
    }
  });
  it("هیچ آزمونی سیگنالِ واقعی نمی‌فرستد و process.exit را صدا نمی‌زند", () => {
    for (const n of readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && f !== "purity.test.ts")) {
      const code = readFileSync(join(DIR, n), "utf8");
      expect(code, n).not.toMatch(/process\s*\.\s*kill\b/);
      expect(code, n).not.toMatch(/process\s*\.\s*(emit|exit)\s*\(/);
    }
  });
});
