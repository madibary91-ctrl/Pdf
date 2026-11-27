/**
 * همارزیِ tool-policy-grants با همسایگانش (ADR-0081): قراردادِ حقوق نسخهٔ ایستای نامِ ذخیره‌ساز است و نباید از آن جدا شود.
 *  - نام‌ها و شِمای پیش‌فرض با `tool-policy-store-pg` (متنِ منبع)؛
 *  - فهرست‌سفیدِ شِما با `createPgPolicyVersionStore` (۲۰۰۰ نامِ تصادفی)؛
 *  - سیاستِ env با `tool-policy-migrate` (۲۰۰۰ محیطِ تصادفی)، که خودش با bootstrap قفل است؛
 *  - شمارِ `CREATE TABLE` در مهاجرت‌های ذخیره‌ساز: جدولِ تازه بی‌به‌روزکردنِ قرارداد این آزمون را قرمز می‌کند (کاملیتِ واقعی در آزمونِ PostgreSQL).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGrantsArgs } from "@/modules/tool-policy-grants";
import { parseMigrateArgs } from "@/modules/tool-policy-migrate";
import { createPgPolicyVersionStore, TOOL_POLICY_DEFAULT_SCHEMA, type PolicyPgDatabase } from "@/modules/tool-policy-store-pg";
import { CONTRACT_TABLES, DEFAULT_POLICY_SCHEMA, LEDGER_TABLE, VERSIONS_TABLE, parseSchema } from "../src/modules/tool-policy-grants/contract";

const read = (rel: string): string => readFileSync(join(__dirname, "..", "src", "modules", rel), "utf8");
/** mulberry32: بذرِ ثابت، توزیعِ خوب در بیت‌های پایین (LCG ساده برای `% n`ی کوچک بد است). */
let seed = 2024;
const rnd = (n: number): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
};
const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;

describe("tool-policy-grants · همارزی با tool-policy-store-pg", () => {
  it("نامِ جدول‌ها و شِمای پیش‌فرض دقیقاً همان‌هایی است که ذخیره‌ساز دارد", () => {
    const naming = read("tool-policy-store-pg/naming.ts");
    expect(naming).toContain(`export const TOOL_POLICY_DEFAULT_SCHEMA = "${DEFAULT_POLICY_SCHEMA}";`);
    expect(naming).toContain(`export const VERSIONS_TABLE = "${VERSIONS_TABLE}";`);
    expect(naming).toContain(`export const LEDGER_TABLE = "${LEDGER_TABLE}";`);
    expect(TOOL_POLICY_DEFAULT_SCHEMA).toBe(DEFAULT_POLICY_SCHEMA);
    expect(naming).toContain("SCHEMA_RE = /^[a-z][a-z0-9_]{0,39}$/");
    expect(naming).toContain('RESERVED = new Set(["public", "information_schema"])');
  });

  it("هر جدولِ ساخته‌شده در مهاجرت‌ها و مهاجرت‌دهنده در قرارداد است (دقیقاً دو CREATE TABLE)", () => {
    const migrations = read("tool-policy-store-pg/migrations.ts");
    const migrate = read("tool-policy-store-pg/migrate.ts");
    expect(migrations.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(migrations).toMatch(/const T = `\$\{S\}\.tool_policy_versions`/);
    expect(migrate.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(migrate).toContain("CREATE TABLE IF NOT EXISTS ${tableRef(schema, LEDGER_TABLE)}");
    for (const kw of ["CREATE SEQUENCE", "CREATE VIEW", "CREATE MATERIALIZED", "CREATE FOREIGN", "SERIAL"]) {
      expect(migrations, kw).not.toContain(kw);
      expect(migrate, kw).not.toContain(kw);
    }
    expect([...CONTRACT_TABLES].sort()).toEqual([LEDGER_TABLE, VERSIONS_TABLE].sort());
  });

  it("فهرست‌سفیدِ شِما با createPgPolicyVersionStore برای ۲۰۰۰ نامِ تصادفی و مرزی یکی است", () => {
    const stub = { execute: () => { throw new Error("no db"); }, transaction: () => { throw new Error("no db"); } } as unknown as PolicyPgDatabase;
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCZ0123456789_-. $\"'ن;";
    const fixed = ["", "public", "information_schema", "pg_x", "pg_", "tool_policy", "a", "A", "_a", "1a", "a".repeat(40), "a".repeat(41), "a-b", "a b", "tool_policy_test_ab12cd34ef"];
    const names = [...fixed];
    for (let i = 0; i < 2000; i++) names.push(Array.from({ length: rnd(45) }, () => alphabet[rnd(alphabet.length)]).join(""));
    let accepted = 0;
    for (const name of names) {
      const store = createPgPolicyVersionStore(stub, { schema: name });
      const mine = parseSchema(name);
      expect(mine.ok, JSON.stringify(name)).toBe(store.ok);
      if (store.ok && mine.ok) {
        expect(mine.value).toBe(store.value.schema);
        accepted++;
      }
    }
    expect(accepted).toBeGreaterThan(5);
  });
});

describe("tool-policy-grants · همارزی سیاستِ env با tool-policy-migrate", () => {
  const known = ["TOOL_POLICY_HOST", "TOOL_POLICY_INTERVAL_MS", "TOOL_POLICY_RETRY_MS", "TOOL_POLICY_ATTEMPT_DEADLINE_MS", "TOOL_POLICY_REFRESH_TIMEOUT_MS", "TOOL_POLICY_MAX_STALE_MS", "TOOL_POLICY_SCHEMA", "TOOL_POLICY_STATEMENT_TIMEOUT_MS", "TOOL_POLICY_SHUTDOWN_TIMEOUT_MS", "TOOL_POLICY_BOOT_ATTEMPTS", "TOOL_POLICY_BOOT_RETRY_DELAY_MS"];
  const typos = ["TOOL_POLICY_SCHEMAA", "TOOL_POLICY_", "TOOL_POLICY_schema", "TOOL_POLICY_X", "TOOL_POLICYSCHEMA", "OTHER", "PATH"];
  const schemaValues: unknown[] = [undefined, "", "tool_policy", "my_schema", "public", "pg_x", "Upper", 5, null, "a-b", "a".repeat(41)];
  const urlValues: unknown[] = [undefined, "", "postgres://x", 7];

  it("۲۰۰۰ محیطِ تصادفی: پذیرش و شِمای نتیجه هم‌ارز است (به‌جز اعتبارسنجیِ شِما که اینجا زودتر و در پارس است)", () => {
    let okCount = 0;
    for (let i = 0; i < 2000; i++) {
      const env: Record<string, unknown> = {};
      const u = pick(urlValues);
      if (u !== undefined) env["DATABASE_URL"] = u;
      const s = pick(schemaValues);
      if (s !== undefined) env["TOOL_POLICY_SCHEMA"] = s;
      for (let k = rnd(3); k > 0; k--) env[pick(known.filter((x) => x !== "TOOL_POLICY_SCHEMA"))] = pick(["1", "x", ""]);
      if (rnd(3) === 0) env[pick(typos)] = "v";
      const m = parseMigrateArgs(["status"], env);
      const g = parseGrantsArgs(["verify", "--role=policy_runtime"], env);
      const schemaOk = m.ok && m.value.command !== "help" ? m.value.schema === null || parseSchema(m.value.schema).ok : false;
      expect(g.ok, JSON.stringify(env)).toBe(m.ok && schemaOk);
      if (g.ok && m.ok && m.value.command !== "help" && g.value.command !== "help") {
        expect(g.value.schema).toBe(m.value.schema);
        okCount++;
      }
    }
    expect(okCount).toBeGreaterThan(100);
  });
});
