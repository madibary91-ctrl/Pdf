/**
 * نگهبان منبع settlement-pending (ADR-0046): فقط drizzle-orm، نوعِ رابطِ عمومیِ ledger/settlement، فایل‌های نسبی و `node:crypto` تنها برای checksum؛
 * بی‌ساعت/تصادف/محیط/شبکه/فایل/تایمر؛ بی‌رشتهٔ اتصال؛ هر مقدارِ داده پارامتر پیوندی است. **این ماژول هیچ‌وقت در `settlement_outbox`/`settlement_dead_ack`
 * نمی‌نویسد** (فقط خواندن + DDL/TRIGGERِ مهاجرت) و در جدولِ نمایه فقط TRIGGERها و backfill می‌نویسند. فقط فایل‌های محصول (نه *.test.ts و pg-kit).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "./index";

const DIR = __dirname;
const NON_PRODUCT = new Set(["pg-kit.ts", "test-kit.ts"]);
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !NON_PRODUCT.has(n))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));

describe("settlement-pending · نگهبان منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["errors.ts", "index.ts", "migrate.ts", "migrations.ts", "naming.ts", "read.ts", "store.ts", "types.ts"]);
  });

  it("هیچ فایلی از Date، Math.random، fetch، process، تایمر، performance، require، eval، console یا import() استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["process", /(?<![\w-])process(?![\w-])/],
      ["globalThis", /\bglobalThis\b/],
      ["setTimeout/Interval", /\b(set|clear)(Timeout|Interval|Immediate)\b/],
      ["performance", /\bperformance\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
      ["import()", /import\s*\(/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("ساعتِ پایگاه فقط ستونِ فراداده‌ایِ applied_at دفترِ مهاجرت است؛ هیچ منطقی به now() تکیه نمی‌کند", () => {
    for (const s of sources.filter((x) => x.name !== "migrate.ts")) expect(s.code, `${s.name}: now()`).not.toMatch(/\bnow\s*\(\s*\)|current_timestamp|clock_timestamp|statement_timestamp/i);
    const migrate = sources.find((x) => x.name === "migrate.ts")?.code ?? "";
    expect([...migrate.matchAll(/\bnow\s*\(\s*\)/gi)]).toHaveLength(1);
    expect(migrate).toMatch(/applied_at timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it("importها فقط: drizzle-orm، @/modules/ledger و @/modules/settlement (رابط عمومی)، فایل‌های نسبی و node:crypto تنها در migrations.ts", () => {
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        const ok = spec === "drizzle-orm" || spec === "@/modules/ledger" || spec === "@/modules/settlement" || /^\.\/[a-z-]+$/.test(spec) || (spec === "node:crypto" && s.name === "migrations.ts");
        expect(ok, `${s.name}: ${spec}`).toBe(true);
      }
      expect(s.code, s.name).not.toMatch(/from\s+["']pg["']|@\/db|@\/modules\/[a-z-]+\/(pg|internal)/);
    }
  });

  it("کدِ زمان‌اجرا (غیر از migrations.ts) هیچ INSERT/UPDATE/DELETE/TRUNCATE به outbox یا تأییدها ندارد؛ تنها نوشتنش دفترِ مهاجرتِ خودش است", () => {
    for (const s of sources.filter((x) => x.name !== "migrations.ts")) {
      expect(s.code, `${s.name}: DML روی settlement`).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b[^`;]*\b(settlement_outbox|settlement_dead_ack|\$\{[TA]\})/i);
      expect(s.code, `${s.name}: FOR UPDATE`).not.toMatch(/\bFOR\s+(UPDATE|SHARE|NO\s+KEY)/i);
    }
    const writes = sources.flatMap((s) => (s.name === "migrations.ts" ? [] : [...s.code.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+\$\{tableRef\([^)]*\)\}/g)].map((m) => `${s.name}:${m[0]}`)));
    expect(writes.every((w) => /settlement_pending_migration_ledger|tableRef\(schema, LEDGER\)/.test(w) || /LEDGER/.test(w))).toBe(true);
  });

  it("رشتهٔ اتصال، کلید یا اسرار در کد نیست", () => {
    for (const s of sources) expect(s.code, s.name).not.toMatch(/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{10,}|api[_-]?key|password/i);
  });

  it("رابط عمومی فقط نام‌های اعلام‌شده را صادر می‌کند", () => {
    expect(Object.keys(api).sort()).toEqual(["PENDING_LIST_LIMIT_MAX", "createPendingDeadIndex"]);
  });

  it("هیچ تستی در این ماژول .skip/.only/xit/todo ندارد", () => {
    for (const n of readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && f !== "purity.test.ts")) {
      expect(readFileSync(join(DIR, n), "utf8"), n).not.toMatch(/\.(skip|only|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/);
    }
  });
});
