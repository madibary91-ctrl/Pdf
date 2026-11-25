/**
 * نگهبانِ کد منبعِ tool-policy-store-pg (ADR-0070؛ در tooling چون ماژول نباید node:fs را import کند): بی‌پایگاه، همیشه اجرا می‌شود.
 * آداپتورِ فقط‌افزودنی: فقط drizzle-orm، رابط عمومیِ tool-policy-admin، فایل‌های نسبی و node:crypto (فقط checksum)؛ بی‌ساعت/تصادف/محیط/شبکه،
 * بی‌رشتهٔ اتصال، بی‌`CREATE SCHEMA` (قفلِ مشترکِ ensureSchema؛ schema-ensure-key-parity)، بی‌UPDATE/DELETE/TRUNCATE/DROP در کدِ اجرایی،
 * بی‌افشای متنِ خطا؛ هر مقدارِ داده پارامترِ پیوندی است و `sql.raw` فقط دو جای ثابت دارد.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../src/modules/registry";
import { HIGH_RISK_MODULES } from "./git-discipline";

const DIR = join(__dirname, "..", "src", "modules", "tool-policy-store-pg");
const NON_PRODUCT = new Set(["test-db.ts"]);
const strip = (c: string): string => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const sources = readdirSync(DIR)
  .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !NON_PRODUCT.has(n))
  .map((n) => ({ name: n, code: strip(readFileSync(join(DIR, n), "utf8")) }));
const byName = (n: string): string => sources.find((s) => s.name === n)?.code ?? "";

describe("tool-policy-store-pg · مرزهای کد منبع", () => {
  it("فهرست فایل‌های منبع شناخته‌شده است (فایل تازه باید آگاهانه اضافه شود)", () => {
    expect(sources.map((s) => s.name).sort()).toEqual(["errors.ts", "index.ts", "migrate.ts", "migrations.ts", "naming.ts", "rows.ts", "store.ts", "types.ts"]);
  });

  it("هیچ فایلی از Date، Math.random، fetch، process، تایمر، performance، require، eval، console یا globalThis استفاده نمی‌کند", () => {
    const forbidden: [string, RegExp][] = [
      ["Date", /\bDate\b/],
      ["Math.random", /Math\s*\.\s*random/],
      ["fetch", /\bfetch\s*\(/],
      ["process", /\bprocess\b/],
      ["timers", /\bset(Timeout|Interval|Immediate)\b/],
      ["performance", /\bperformance\b/],
      ["require", /\brequire\s*\(/],
      ["eval/Function", /\b(eval|new\s+Function)\b/],
      ["console", /\bconsole\b/],
      ["globalThis", /\bglobalThis\b/],
    ];
    for (const s of sources) for (const [label, re] of forbidden) expect(s.code, `${s.name}: ${label}`).not.toMatch(re);
  });

  it("importها فقط drizzle-orm، tool-policy-admin (رابطِ عمومی) و فایل‌های نسبی؛ node:crypto فقط در migrations.ts؛ بی‌import پویا", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: import()`).not.toMatch(/\bimport\s*\(/);
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        if (spec.startsWith("./")) continue;
        if (spec === "node:crypto") {
          expect(s.name, "node:crypto").toBe("migrations.ts");
          continue;
        }
        expect(["drizzle-orm", "@/modules/tool-policy-admin"], `${s.name}: ${spec}`).toContain(spec);
      }
    }
  });

  it("هیچ رشتهٔ اتصال، رمز یا process.env؛ pg (درایور) را هم import نمی‌کند (پایگاه تزریق می‌شود)", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: connection string`).not.toMatch(/postgres(ql)?:\/\//i);
      expect(s.code, `${s.name}: pg`).not.toMatch(/from\s+"pg"/);
      expect(s.code, `${s.name}: password`).not.toMatch(/password/i);
    }
  });

  it("هیچ CREATE SCHEMA (قفلِ مشترکِ ensureSchema، ADR-0037) و هیچ کلیدِ schema:ensure: در ماژول نیست", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: CREATE SCHEMA`).not.toMatch(/CREATE\s+SCHEMA/i);
      expect(s.code, `${s.name}: schema:ensure:`).not.toContain("schema:ensure:");
    }
  });

  it("آداپتور فقط می‌نویسد‌افزودن: در store/migrate/rows/errors/naming هیچ UPDATE/DELETE/TRUNCATE/DROP/ALTER نیست (فقط INSERT … ON CONFLICT DO NOTHING و CREATE TABLE IF NOT EXISTS برای دفتر)", () => {
    for (const n of ["store.ts", "migrate.ts", "rows.ts", "errors.ts", "naming.ts"]) {
      expect(byName(n), `${n}: UPDATE/DELETE/TRUNCATE/DROP/ALTER`).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/);
    }
    const inserts = byName("store.ts").match(/INSERT INTO/g) ?? [];
    expect(inserts).toHaveLength(1);
    expect(byName("store.ts")).toContain("ON CONFLICT (version) DO NOTHING");
    expect(byName("store.ts")).not.toMatch(/DO UPDATE/i);
    // تنها INSERTِ migrate.ts دفترِ مهاجرت است.
    expect(byName("migrate.ts").match(/INSERT INTO/g) ?? []).toHaveLength(1);
  });

  it("sql.raw فقط دو جای ثابت دارد: فهرستِ ستون‌های ثابت (store) و دستورهای مهاجرتِ رندرشده (migrate)", () => {
    const uses = sources.flatMap((s) => [...s.code.matchAll(/sql\.raw\(\s*([A-Za-z_]+)/g)].map((m) => `${s.name}:${m[1]}`));
    expect(uses.sort()).toEqual(["migrate.ts:renderStatement", "store.ts:RECORD_COLUMNS"]);
  });

  it("هر ${…}ی که در متنِ SQLِ store/migrate می‌نشیند یا پارامترِ پیوندی است یا شناسهٔ نقل‌قول‌شدهٔ ثابت (جدول/شِما با sql.identifier)؛ فهرستِ بسته", () => {
    const allowed: Record<string, readonly string[]> = {
      "store.ts": [
        "String(timeout)", "COLUMNS", "table", "String(version)", "String(rec.version)", "JSON.stringify(rec.overrides)", "JSON.stringify(rec.policy)",
        "JSON.stringify(rec.changes)", "rec.source.kind", 'rec.source.kind === "rollback" ? String(rec.source.toVersion) : null', "rec.actor", "rec.reason",
        "String(rec.createdAtMs)", "before", "limit",
      ],
      "migrate.ts": [
        "tableRef(schema, LEDGER_TABLE)", "schema", "`tool-policy-store:migrate:${schema", "m.name", "migrationChecksum(m)", "regclassName(schema, VERSIONS_TABLE)",
        "sql.join(EXPECTED_TRIGGERS.map((n) => sql`${n", "regclassName(schema, LEDGER_TABLE)", "regclass", "tableRef(schema, VERSIONS_TABLE)",
      ],
    };
    for (const n of ["store.ts", "migrate.ts"]) {
      for (const t of byName(n).matchAll(/sql`(?:[^`\\]|\\.|`(?=[^`]*\$\{))*`/g)) {
        for (const ph of t[0].matchAll(/\$\{([^}]*)\}/g)) expect(allowed[n], `${n}: \${${ph[1]}}`).toContain(ph[1]);
      }
    }
  });

  it("خطا هرگز با متنِ استثنا ساخته نمی‌شود: هیچ `.message` یا `String(e)`ی از خطای گرفته‌شده خوانده نمی‌شود", () => {
    for (const s of sources) {
      expect(s.code, `${s.name}: e.message`).not.toMatch(/\b(e|err|error|cause)\s*\.\s*message\b/);
      expect(s.code, `${s.name}: String(e)`).not.toMatch(/String\(\s*(e|err|error)\s*\)/);
      expect(s.code, `${s.name}: \${e}`).not.toMatch(/\$\{\s*(e|err|error)\s*\}/);
    }
  });

  it("هر عملیاتِ store از run() می‌گذرد (مهلت + بررسیِ مهاجرت)، و فقط run() تراکنش باز می‌کند", () => {
    const store = byName("store.ts");
    expect((store.match(/db\.transaction\(/g) ?? []).length).toBe(1);
    for (const op of ["latest", "get", "list"]) expect(store, op).toMatch(new RegExp(`${op}:[\\s\\S]*?run\\("read"`));
    expect(store).toMatch(/append:[\s\S]*?run\("write"/);
    expect(store).toContain("assertCurrent(tx, schema)");
    expect(store).toContain("assertWritable(tx, schema)");
    expect(store).toContain("set_config('statement_timeout'");
    expect(store).toContain("set_config('lock_timeout'");
  });

  it("هر ورودی پیش از پایگاه اعتبارسنجی می‌شود: append با parsePolicyRecord، get/list با isSafeInt", () => {
    const store = byName("store.ts");
    expect(store).toMatch(/parsePolicyRecord\(record\)/);
    expect(store.match(/isSafeInt\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("ثبت در registry: لایهٔ ۶، ناخالص (پایگاه)، humanReview، dependsOn دقیقاً tool-policy-admin؛ و در HIGH_RISK_MODULES", () => {
    const m = MODULES.find((x) => x.name === "tool-policy-store-pg");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ layer: 6, step: 8, humanReview: true, pure: false });
    expect([...m!.dependsOn]).toEqual(["tool-policy-admin"]);
    expect(HIGH_RISK_MODULES).toContain("tool-policy-store-pg");
  });

  it("هیچ مقدارِ پول (قیمت، ارز، حساب، کلید) و هیچ نام/عددِ فیلدِ سیاست در ماژول نیست", () => {
    for (const s of sources) {
      const code = s.code.replace(/"[^"]*"/g, '""');
      for (const re of [/\bprice\b/i, /\bcurrency\b/i, /\btenantId\b/, /\baccountId\b/, /\bapiKey\b/i, /\bendpoint\b/i, /\bIRR\b/, /\bgraceMs\b/, /\bmaxCallMs\b/, /\bttlMs\b/, /\bonUnknownCost\b/]) {
        expect(code, `${s.name}: ${re}`).not.toMatch(re);
      }
    }
  });

  it("مهاجرت‌ها در مخزن ثبت و ویرایش‌ناپذیرند: نامِ 0001_init هست و فایلِ مهاجرت CREATE SCHEMA ندارد", () => {
    expect(byName("migrations.ts")).toContain('name: "0001_init"');
  });
});
