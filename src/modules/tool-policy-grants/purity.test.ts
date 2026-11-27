/**
 * نگهبان منبع tool-policy-grants (ADR-0081): ماژول `process`، `globalThis`، `console`، `pg`، drizzle، ساعتِ سیستم و اتصال را مستقیم نمی‌شناسد؛
 * پایگاه، زمان‌سنج و نوشتن همه تزریقی است. **SQL فقط در `plan.ts`** (متنِ ثابتِ پرس‌وجوها و دستورهایی که از شناسه‌های اعتبارسنجی‌شده ساخته می‌شوند) و
 * واژه‌نامهٔ حق‌ها در `contract.ts` است؛ هیچ فایلِ دیگری واژهٔ SQL ندارد. ماژول به هیچ ماژولِ دیگری import نمی‌دهد. فقط فایل‌های محصول.
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
const code = (name: string): string => sources.find((s) => s.name === name)?.code ?? "";

describe("tool-policy-grants · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["args.ts", "cli.ts", "contract.ts", "deadline.ts", "execute.ts", "index.ts", "lazy-database.ts", "plan.ts", "report.ts", "types.ts"]);
  });

  it("process، globalThis، global، console، fetch، eval، require، import()، crypto و Math.random در هیچ فایلی نیست", () => {
    const forbidden: [string, RegExp][] = [
      ["process", /(?<![\w-])process(?![\w-])/],
      ["globalThis", /\bglobalThis\b/],
      ["global", /\bglobal\b/],
      ["console", /\bconsole\b/],
      ["fetch", /\bfetch\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["require", /\brequire\s*\(/],
      ["import()", /import\s*\(/],
      ["crypto", /\bcrypto\b/],
      ["Math.random", /Math\s*\.\s*random/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("Date، setTimeout، setInterval و setImmediate نیست (زمان‌سنج تزریقی)", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/\b(Date|setTimeout|clearTimeout|setInterval|setImmediate|queueMicrotask)\b/);
  });

  it("importها فقط فایل‌های نسبیِ همین ماژول‌اند (نه ماژولِ دیگر، نه drizzle، pg یا node:)", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) expect(/^\.\/[a-z-]+$/.test(m[1] as string), `${s.name}: ${m[1]}`).toBe(true);
      expect(s.code, s.name).not.toMatch(/\b(drizzle-orm|@\/db|node:)/);
    }
  });

  it("اتصال نمی‌سازد و استخر نمی‌بندد؛ فقط از پورت‌ها می‌گذرد", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bnew\s+Pool\b/);
      expect(s.code, s.name).not.toMatch(/\bdrizzle\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.end\s*\(/);
    }
    for (const s of sources.filter((x) => x.name !== "execute.ts")) expect(s.code, s.name).not.toMatch(/ports\.(query|transact)\s*\(/);
    expect(code("execute.ts")).toMatch(/ports\.query\(/);
    expect(code("execute.ts")).toMatch(/ports\.transact\(/);
    // `close` فقط از راهِ پایگاهِ تنبل (کران‌دار) صدا زده می‌شود.
    for (const s of sources.filter((x) => !["lazy-database.ts", "cli.ts"].includes(x.name))) expect(s.code, s.name).not.toMatch(/\.close\s*\(/);
    expect(code("cli.ts").match(/\.close\s*\(/g)).toHaveLength(1);
    expect(code("cli.ts")).toMatch(/lazy\.close\(p\.timer\)/);
  });

  it("واژهٔ SQL فقط در plan.ts و contract.ts؛ جای دیگر نیست", () => {
    for (const s of sources.filter((x) => !["plan.ts", "contract.ts"].includes(x.name))) expect(s.code, s.name).not.toMatch(/\b(GRANT|REVOKE|SELECT|INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/);
  });

  it("هیچ «CREATE ROLE»، «ALTER ROLE»، «PASSWORD» یا «CREATE SCHEMA» در ماژول نیست (نقش نمی‌سازد، رمز نمی‌گذارد، شِما نمی‌سازد)", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/\b(CREATE\s+(ROLE|USER|SCHEMA)|ALTER\s+(ROLE|USER)|PASSWORD|SUPERUSER\s+TO|WITH\s+GRANT\s+OPTION)\b/i);
  });

  it("نگهبانِ فقط‌افزودنی: قرارداد به UPDATE/DELETE/TRUNCATE/CREATE هرگز نمی‌دهد (متنِ GRANTهای طرح)", () => {
    const plan = code("plan.ts");
    const grants = [...plan.matchAll(/`GRANT [^`]*`/g)].map((m) => m[0]);
    expect(grants.length).toBe(2); // دو الگوی GRANT در منبع: شِما و حلقهٔ جدول‌ها؛ هر دو فقط از RUNTIME_CONTRACT پر می‌شوند
    for (const g of grants) expect(g).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|CREATE|ALL|OPTION|PUBLIC)\b/);
  });

  it("رابط عمومی: فقط نام‌های مستند", () => {
    expect(Object.keys(api).sort()).toEqual(["CONTRACT_TABLES", "GRANTS_EXIT", "RUNTIME_CONTRACT", "TOOL_POLICY_GRANTS_USAGE", "parseGrantsArgs", "parseRuntimeRole", "planStatements", "runToolPolicyGrants"]);
  });
});
