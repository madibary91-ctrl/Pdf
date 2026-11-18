/**
 * آزمونِ نگهبانِ کد منبعِ آداپتور PostgreSQL (ADR-0019 تصمیم ۱). هستهٔ ledger را `../purity.test.ts` نگهبانی می‌کند؛
 * این‌جا آداپتور: فقط `drizzle-orm` و `node:crypto` (فقط برای checksum مهاجرت)، بی‌ساعت/تصادف/محیط/شبکه، بی‌رشتهٔ اتصال.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_DB } from "./test-db";

const DIR = __dirname;
const NON_PRODUCT = new Set(["test-db.ts"]);
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !NON_PRODUCT.has(n))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("ledger/pg · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["audit.ts", "errors.ts", "index.ts", "migrate.ts", "migrations.ts", "naming.ts", "read.ts", "rows.ts", "store.ts", "types.ts", "write.ts"]);
  });

  it("هیچ فایلی از Date، Math.random، fetch، process، تایمر، performance، require، eval یا console استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["process", /\bprocess\b/],
      ["setTimeout/Interval", /\bset(Timeout|Interval|Immediate)\b/],
      ["performance", /\bperformance\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
    // ساعت پایگاه فقط ستون فراداده‌ایِ `applied_at` دفتر مهاجرت است؛ هیچ منطق دفتر به `now()` پایگاه تکیه نمی‌کند (ساعت تزریقی است).
    for (const s of sources.filter((x) => x.name !== "migrate.ts")) expect(s.code, `${s.name}: now()`).not.toMatch(/\bnow\s*\(\s*\)/i);
  });

  it("importها فقط: drizzle-orm، فایل‌های نسبیِ همین ماژول (یک سطح بالاتر مجاز) و node:crypto تنها در migrations.ts", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        const ok = spec === "drizzle-orm" || spec.startsWith("./") || (spec.startsWith("../") && !spec.startsWith("../../")) || (spec === "node:crypto" && s.name === "migrations.ts");
        expect(ok, `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/import\s*\(/);
    }
  });

  it("از هسته فقط فایل‌های خالص import می‌شود (موتور/سرویس/ذخیرهٔ حافظه‌ای نه) و هیچ ماژول دیگری", () => {
    const allowed = new Set(["../types", "../invariants", "../validate"]);
    for (const s of sources) for (const m of s.code.matchAll(/from\s+["'](\.\.\/[^"']+)["']/g)) expect(allowed.has(m[1] as string), `${s.name}: ${m[1]}`).toBe(true);
    for (const s of sources) expect(s.code, s.name).not.toMatch(/@\/modules\//);
  });

  it("رشتهٔ اتصال، کلید یا اسرار در کد نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{10,}|api[_-]?key|password/i);
  });

  it("هر مقدارِ دادهٔ SQL پارامتر پیوندی است؛ تنها sql.raw دستورهای مهاجرتِ ثابت و `FOR UPDATE` است", () => {
    for (const s of sources) {
      const raws = [...s.code.matchAll(/sql\.raw\(((?:[^()]|\([^()]*\))*)\)/g)].map((m) => (m[1] as string).trim());
      if (s.name === "migrate.ts") expect(raws).toEqual(["renderStatement(statement, schema)"]);
      else if (s.name === "read.ts") expect(raws.sort()).toEqual(['" FOR UPDATE"', '""']);
      else expect(raws, s.name).toEqual([]);
    }
  });

  it("رابط عمومی آداپتور فقط نام‌های اعلام‌شده را بیرون می‌دهد", async () => {
    const mod = await import("./index");
    expect(Object.keys(mod).sort()).toEqual(["LEDGER_DEFAULT_SCHEMA", "createPgAccountStore"]);
    const top = await import("../index");
    expect(top.createPgAccountStore).toBe(mod.createPgAccountStore);
    expect(top.LEDGER_DEFAULT_SCHEMA).toBe("ledger");
    // کارخانهٔ داخلی (نگهبان‌های معنایی قابل‌خاموش) هرگز بیرون نیست.
    expect(Object.keys(top)).not.toContain("buildPgStore");
  });

  it("در CI نبودنِ پایگاه آزمون خودش شکست است («سبزِ بی‌اجرا» پذیرفتنی نیست)", () => {
    if (process.env["CI"] === "true") expect(HAS_DB).toBe(true);
    else expect(typeof HAS_DB).toBe("boolean");
  });
});
