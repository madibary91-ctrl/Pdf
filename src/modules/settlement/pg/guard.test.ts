/**
 * نگهبانِ کد منبعِ آداپتور PostgreSQL outbox (ADR-0022). هستهٔ settlement را `../purity.test.ts` نگهبانی می‌کند (بی‌پایگاه)؛ این‌جا آداپتور:
 * فقط `drizzle-orm`، رابط عمومی ledger (فقط نوع)، فایل‌های نسبیِ همین ماژول و `node:crypto` تنها برای checksum مهاجرت؛
 * بی‌ساعت/تصادف/محیط/شبکه، بی‌رشتهٔ اتصال؛ هر مقدارِ داده پارامتر پیوندی است.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;
const NON_PRODUCT = new Set(["test-db.ts"]);
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !NON_PRODUCT.has(n))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("settlement/pg · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["errors.ts", "index.ts", "migrate.ts", "migrations.ts", "naming.ts", "rows.ts", "store.ts", "types.ts"]);
  });

  it("هیچ فایلی از Date، Math.random، fetch، process، تایمر، performance، require، eval یا console استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      [`Date`, /\bDate\b/],
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
  });

  it("ساعت پایگاه فقط ستون فراداده‌ایِ applied_at دفتر مهاجرت است؛ هیچ منطقِ تسویه‌ای به now() تکیه نمی‌کند (ساعت تزریقی است)", () => {
    for (const s of sources.filter((x) => x.name !== "migrate.ts")) expect(s.code, `${s.name}: now()`).not.toMatch(/\bnow\s*\(\s*\)|current_timestamp|clock_timestamp|statement_timestamp/i);
    const migrate = sources.find((x) => x.name === "migrate.ts")?.code ?? "";
    expect([...migrate.matchAll(/\bnow\s*\(\s*\)/gi)]).toHaveLength(1);
    expect(migrate).toMatch(/applied_at timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it("importها فقط: drizzle-orm، @/modules/ledger (رابط عمومی)، فایل‌های نسبی (یک سطح بالاتر مجاز) و node:crypto تنها در migrations.ts", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        const ok = spec === "drizzle-orm" || spec === "@/modules/ledger" || spec.startsWith("./") || (spec.startsWith("../") && !spec.startsWith("../../")) || (spec === "node:crypto" && s.name === "migrations.ts");
        expect(ok, `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/import\s*\(/);
    }
  });

  it("از هستهٔ settlement فقط فایل‌های خالص import می‌شود (types و validate)؛ از ledger فقط نوع (import type) به‌جز هیچ", () => {
    const allowed = new Set(["../types", "../validate"]);
    for (const s of sources) for (const m of s.code.matchAll(/from\s+["'](\.\.\/[^"']+)["']/g)) expect(allowed.has(m[1] as string), `${s.name}: ${m[1]}`).toBe(true);
    for (const s of sources) for (const m of s.code.matchAll(/import\s+(type\s+)?[^;]*?from\s+["']@\/modules\/ledger["']/g)) expect(m[1], `${s.name}: ledger باید فقط import type باشد`).toBeDefined();
  });

  it("رشتهٔ اتصال، کلید یا اسرار در کد نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{10,}|api[_-]?key|password/i);
  });

  it("هر مقدارِ دادهٔ SQL پارامتر پیوندی است؛ sql.raw فقط ستون‌های ثابت و دستورهای مهاجرتِ ثابت", () => {
    const raws = sources.flatMap((s) => [...s.code.matchAll(/sql\.raw\(\s*([^,)]*)/g)].map((m) => ({ file: s.name, arg: (m[1] ?? "").trim() })));
    const summary = raws.map((r) => `${r.file}: ${r.arg.startsWith('"') ? "<literal>" : r.arg}`).sort();
    expect(summary).toEqual(["migrate.ts: renderStatement(statement", "rows.ts: <literal>"]);
    // literal ثابتِ ستون‌ها فقط نام ستون و کاما دارد (نه مقدار، نه پارامتر)
    const columns = /sql\.raw\(\s*"([^"]*)"/.exec(sources.find((x) => x.name === "rows.ts")?.code ?? "")?.[1] ?? "";
    expect(columns).toMatch(/^[a-z_]+(, [a-z_]+)*$/);
  });

  it("هیچ جدولی جز دو جدولِ شناخته‌شده و هیچ شِمایی جز پارامتر ساخته/خوانده نمی‌شود (نام شِما فقط با sql.identifier)", () => {
    const all = sources.map((s) => s.code).join("\n");
    const tables = new Set([...all.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?\$\{[^}]+\}(?:\.(\w+))?/g)].map((m) => m[1] ?? "(ref)"));
    expect([...tables].sort()).toEqual(["(ref)", "settlement_dead_ack", "settlement_outbox"]);
    expect(all).not.toMatch(/\bpublic\./);
    expect(all).not.toMatch(/DROP\s+(TABLE|SCHEMA)/i);
    expect(all).not.toMatch(/\bTRUNCATE\s+(TABLE\s+)?\$\{/i);
    expect(all).not.toMatch(/DELETE\s+FROM/i);
  });
});
