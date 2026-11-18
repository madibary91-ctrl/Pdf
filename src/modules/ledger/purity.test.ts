/**
 * آزمونِ نگهبانِ کد منبع (ADR-0018 §۱۰): ledger به I/O، ساعت سیستم، تصادف و محیط دست نمی‌زند و به هیچ ماژول دیگری وابسته نیست.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;
const NON_PRODUCT = new Set(["test-kit.ts", "store-contract.ts"]);
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !NON_PRODUCT.has(n))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("ledger · هستهٔ بی‌I/O", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["engine.ts", "index.ts", "invariants.ts", "ledger.ts", "memory-store.ts", "types.ts", "validate.ts"]);
  });
  it("هیچ فایل منبعی از Date، Math.random، fetch، process، تایمر، crypto یا console استفاده نمی‌کند", () => {
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
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });
  it("importها فقط فایل‌های نسبی همین ماژول‌اند (بی‌ماژول دیگر، بی‌node:، بی‌import پویا، بی‌وابستگی خارجی)", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) expect((m[1] as string).startsWith("./"), `${s.name}: ${m[1]}`).toBe(true);
      expect(s.code, s.name).not.toMatch(/import\s*\(/);
    }
  });
  it("رشتهٔ اتصال، کلید یا اسرار در کد نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{10,}|api[_-]?key/i);
  });
  it("رابط عمومی چیزِ داخلی را بیرون نمی‌دهد (فقط نام‌های اعلام‌شده)", async () => {
    const mod = await import("./index");
    expect(Object.keys(mod).sort()).toEqual(["GRANT_SOURCES", "ID_RE", "LIMITS", "UNIT_RE", "applyCommand", "checkInvariants", "createLedger", "createMemoryStore", "foldJournal", "parseCommand", "parseKey", "viewAt"]);
  });
});
