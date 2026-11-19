/**
 * نگهبان منبع settlement-migrate (ADR-0034): ماژول `process`، `globalThis`، `console`، `pg`، drizzle و ساعتِ سیستم را مستقیم نمی‌شناسد؛
 * پایگاه، زمان‌سنج و نوشتن همه تزریقی است. فقط رابط عمومیِ ledger و settlement. فقط فایل‌های محصول.
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
const tests = () => readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && f !== "purity.test.ts");

describe("settlement-migrate · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["args.ts", "cli.ts", "deadline.ts", "execute.ts", "exit-codes.ts", "index.ts", "lazy-database.ts", "report.ts", "stores.ts", "types.ts"]);
  });

  it("process (و process.env/exit)، globalThis، global، console، fetch، eval، require و import() در هیچ فایلی نیست", () => {
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

  it("importها فقط: رابط عمومیِ ledger و settlement و فایل‌های نسبیِ همین ماژول", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        expect(spec === "@/modules/ledger" || spec === "@/modules/settlement" || /^\.\/[a-z-]+$/.test(spec), `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/\b(drizzle-orm|@\/db|node:)/);
      expect(s.code, s.name).not.toMatch(/from\s+["']pg["']/);
    }
  });

  it("خودش اتصال نمی‌سازد و استخر را نمی‌بندد؛ migrate() فقط در execute.ts صدا زده می‌شود", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/\bnew\s+Pool\b/);
      expect(s.code, s.name).not.toMatch(/\bdrizzle\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.end\s*\(/);
      if (s.name !== "execute.ts") expect(s.code, s.name).not.toMatch(/\.migrate\s*\(/);
    }
    expect(sources.find((s) => s.name === "execute.ts")?.code).toMatch(/\.migrate\s*\(/);
  });

  it("SQL خام یا نوشتنِ مستقیم نیست: ماژول فقط از فروشگاه‌های ledger/settlement مهاجرت می‌دهد", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\s+(TABLE|SCHEMA|INTO|FROM)\b|sql\s*`|sql\.raw/i);
  });

  it("رشتهٔ اتصال، کلید یا اسرار در کد نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{10,}|api[_-]?key|password/i);
  });

  it("پیام‌های خطا هرگز متنِ استثنا را نمی‌گیرند (catch بی‌پارامتر): هیچ `catch (e)`، `.message` یا `.stack`ی نیست؛ error.message فروشگاه خوانده نمی‌شود", () => {
    for (const s of sources) {
      expect(s.code, s.name).not.toMatch(/catch\s*\(/);
      expect(s.code, s.name).not.toMatch(/\.(message|stack)\b/);
    }
  });

  it("DATABASE_URL مقدارش در ماژول خوانده نمی‌شود (فقط حضورش سنجیده می‌شود)", () => {
    const args = sources.find((s) => s.name === "args.ts")?.code ?? "";
    expect(args).toMatch(/typeof url !== "string"/);
    for (const s of sources.filter((x) => x.name !== "args.ts")) expect(s.code, s.name).not.toMatch(/DATABASE_URL/);
    expect(args).not.toMatch(/(value|databaseUrl|url)\s*:\s*url/);
  });

  it("رابط عمومی فقط نام‌های اعلام‌شده را صادر می‌کند", () => {
    expect(Object.keys(api).sort()).toEqual(["MIGRATE_EXIT", "SETTLEMENT_MIGRATE_USAGE", "parseMigrateArgs", "runSettlementMigrate"]);
  });

  it("فایل‌های آزمونِ شناخته‌شده‌اند (آزمونِ تازه آگاهانه افزوده می‌شود، هیچ‌کدام حذف نمی‌شود)", () => {
    const t = tests();
    for (const f of ["args.test.ts", "cli.test.ts", "cli.pg.test.ts", "process.pg.test.ts"]) expect(t, f).toContain(f);
  });
});
