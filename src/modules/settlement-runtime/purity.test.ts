/**
 * نگهبان منبع settlement-runtime (ADR-0031): فقط رابط عمومی `ledger` و `settlement`؛ بی‌اتصالِ مستقیم (`pg`، `drizzle-orm`، `@/db`)،
 * بی‌`process`/`console`/`env`/شبکه/فایل؛ `Date` فقط در clock.ts و `setTimeout` فقط در node-timer.ts؛ بی‌اسرار.
 * فقط فایل‌های محصول (نه *.test.ts و کمک‌تست‌ها).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "./index";

const DIR = __dirname;
const NON_PRODUCT = new Set(["test-kit.ts", "test-db.ts"]);
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !NON_PRODUCT.has(n))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("settlement-runtime · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["assemble.ts", "clock.ts", "index.ts", "node-timer.ts", "pg-runtime.ts", "runtime.ts", "types.ts"]);
  });
  it("هیچ فایلی از process، console، fetch، eval، require، crypto، Math.random یا performance استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["process", /\bprocess\b/],
      ["console", /\bconsole\b/],
      ["fetch", /\bfetch\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["require", /\brequire\s*\(/],
      ["crypto", /\bcrypto\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["performance", /\bperformance\b/],
      ["setInterval", /\bsetInterval\b/],
      ["setImmediate", /\bsetImmediate\b/],
      ["import()", /import\s*\(/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });
  it("Date فقط در clock.ts و setTimeout/clearTimeout فقط در node-timer.ts", () => {
    for (const s of sources) {
      if (s.name !== "clock.ts") expect(s.code, `${s.name}: Date`).not.toMatch(/\bDate\b/);
      if (s.name !== "node-timer.ts") expect(s.code, `${s.name}: setTimeout`).not.toMatch(/\b(setTimeout|clearTimeout)\b/);
    }
    expect(sources.find((s) => s.name === "clock.ts")?.code).toMatch(/\bDate\.now\b/);
    expect(sources.find((s) => s.name === "node-timer.ts")?.code).toMatch(/\bsetTimeout\b/);
  });
  it("importها فقط: رابط عمومی ledger و settlement و فایل‌های نسبیِ همین ماژول (بی‌deep import، بی‌پایگاهِ مستقیم، بی‌node:)", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(spec === "@/modules/ledger" || spec === "@/modules/settlement" || /^\.\/[a-z-]+$/.test(spec), `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/\b(drizzle-orm|@\/db|node:)/);
      expect(s.code, s.name).not.toMatch(/from\s+["']pg["']/);
    }
  });
  it("هرگز اتصال نمی‌سازد و استخر را نمی‌بندد: بی‌Pool، بی‌drizzle()، بی‌end()", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bnew\s+Pool\b/);
      expect(s.code, s.name).not.toMatch(/\bdrizzle\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.end\s*\(/);
    }
  });
  it("هیچ فایلی خودش مهاجرت را در start صدا نمی‌زند: migrate فقط در pg-runtime.ts و فقط داخلِ تابعِ migrate", () => {
    for (const s of sources) {
      if (s.name === "pg-runtime.ts") continue;
      expect(s.code, s.name).not.toMatch(/\.migrate\s*\(/);
    }
    const code = sources.find((s) => s.name === "pg-runtime.ts")?.code ?? "";
    const calls = [...code.matchAll(/\.migrate\s*\(/g)].length;
    expect(calls).toBe(2); // دفتر و outbox؛ هر دو فقط درونِ migrate()
    const start = code.indexOf("const migrate = async");
    for (const m of code.matchAll(/\.migrate\s*\(/g)) expect(m.index as number).toBeGreaterThan(start);
  });
  it("رشتهٔ اتصال، کلید یا اسرار در کد نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{10,}|api[_-]?key|password/i);
  });
  it("رابط عمومی فقط نام‌های اعلام‌شده را صادر می‌کند", () => {
    expect(Object.keys(api).sort()).toEqual(["SETTLEMENT_RUNTIME_LIMITS", "createNodeTimer", "createPgSettlementRuntime", "createSettlementRuntime", "createSystemClock"]);
  });
  it("هیچ تستی در این ماژول .skip/.only/xit/todo ندارد", () => {
    for (const n of readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && f !== "purity.test.ts")) {
      expect(readFileSync(join(DIR, n), "utf8"), n).not.toMatch(/\.(skip|only|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/);
    }
  });
  it("هر فایلِ آزمون با dbDescribe یا بی‌پایگاه است: کمک‌تستِ پایگاه فقط در runtime.pg.test.ts استفاده می‌شود", () => {
    for (const n of readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && f !== "runtime.pg.test.ts" && f !== "purity.test.ts")) {
      expect(readFileSync(join(DIR, n), "utf8"), n).not.toMatch(/from\s+["']\.\/test-db["']/);
    }
  });
});
