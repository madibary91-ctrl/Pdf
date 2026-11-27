/**
 * نگهبانِ راستیِ راهنمای استقرارِ نقش‌ها (`docs/runbooks/tool-policy-roles.md`؛ ADR-0082).
 * ریشه: راهنمایی که از کد جدا بماند دروغ می‌شود (کدِ خروجِ عوض‌شده، متغیرِ حذف‌شده، فلگِ ناموجود، ترتیبِ جابه‌جاشده) و استقرارِ امنیتی را خراب می‌کند.
 * آنچه ماشین می‌تواند بسنجد قفل می‌شود (نه معنای جمله‌ها): ۱) جدولِ کدهای خروج = `GRANTS_EXIT`؛ ۲) هر `npm run` در `package.json` هست؛
 * ۳) فرمان‌ها/فلگ‌ها فقط آنچه CLIها می‌پذیرند؛ ۴) نامِ envها دقیقاً مجموعهٔ `TOOL_POLICY_BOOTSTRAP_ENV`؛ ۵) ترتیبِ گام‌ها؛ ۶) جدولِ قرارداد = `RUNTIME_CONTRACT`؛
 * ۷) هیچ رمز/رشتهٔ اتصالِ دارای رمز؛ ۸) مسیرهای ریشه‌دارِ ذکرشده موجودند. بازرس یک تابعِ خالص است و با نمونه‌های ساختگیِ نقض آزموده می‌شود.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_POLICY_BOOTSTRAP_ENV } from "@/modules/tool-policy-bootstrap";
import { GRANTS_EXIT, RUNTIME_CONTRACT } from "@/modules/tool-policy-grants";

const ROOT = process.cwd();
const RUNBOOK = join(ROOT, "docs", "runbooks", "tool-policy-roles.md");
const ALL_TABLE_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
const GRANTS_COMMANDS = ["plan", "verify", "apply"];
const GRANTS_FLAGS = ["--role", "--timeout-ms"];
const MIGRATE_COMMANDS = ["status", "up"];
const MIGRATE_FLAGS = ["--create-schema", "--timeout-ms"];
const ORDER = ["policy:migrate -- up", "CREATE ROLE", "policy:grants -- plan", "policy:grants -- apply", "policy:grants -- verify", "TOOL_POLICY_HOST=on"];

/** ناحیهٔ بینِ دو سرتیتر (`## n)`) — بی‌سرتیترِ بعدی تا پایان. */
function section(text: string, n: string): string {
  const start = text.indexOf(`## ${n})`);
  if (start < 0) return "";
  const rest = text.slice(start + 3);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

function cells(row: string): string[] {
  return row.split("|").slice(1, -1).map((c) => c.trim());
}

export function checkRunbook(text: string, scripts: ReadonlySet<string>, exists: (path: string) => boolean): string[] {
  const out: string[] = [];

  // ۱) جدولِ کدهای خروج دقیقاً GRANTS_EXIT است.
  const rows = section(text, "۴").split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l)).map(cells);
  const doc = new Map(rows.map((c) => [c[1] ?? "", Number(c[0])]));
  for (const [name, code] of Object.entries(GRANTS_EXIT)) if (doc.get(name) !== code) out.push(`exit:${name}≠${code}`);
  for (const name of doc.keys()) if (!(name in GRANTS_EXIT)) out.push(`exit:extra:${name}`);
  if (rows.length !== Object.keys(GRANTS_EXIT).length) out.push("exit:rowcount");

  // ۲) هر `npm run X` در scripts هست.
  for (const m of text.matchAll(/npm run ([\w:-]+)/g)) if (!scripts.has(m[1] as string)) out.push(`script:${m[1]}`);

  // ۳) فرمان و فلگِ هر CLI فقط آنچه می‌پذیرد.
  for (const [script, commands, flags] of [
    ["policy:grants", GRANTS_COMMANDS, GRANTS_FLAGS],
    ["policy:migrate", MIGRATE_COMMANDS, MIGRATE_FLAGS],
  ] as const) {
    for (const m of text.matchAll(new RegExp(`npm run ${script} -- (\\S+)([^\\n|\`]*)`, "g"))) {
      if (!commands.includes(m[1] as string)) out.push(`command:${script}:${m[1]}`);
      for (const f of (m[2] as string).matchAll(/(--[\w-]+)/g)) if (!flags.includes(f[1] as string)) out.push(`flag:${script}:${f[1]}`);
    }
  }

  // ۴) envها دقیقاً مجموعهٔ شناخته‌شدهٔ bootstrap؛ هر کدام دست‌کم یک بار ذکر شده.
  const known = new Set<string>(Object.values(TOOL_POLICY_BOOTSTRAP_ENV));
  const mentioned = new Set([...text.matchAll(/TOOL_POLICY_[A-Z_]+/g)].map((m) => m[0]));
  for (const e of mentioned) if (!known.has(e)) out.push(`env:unknown:${e}`);
  for (const e of known) if (!mentioned.has(e)) out.push(`env:undocumented:${e}`);

  // ۵) ترتیبِ گام‌ها در بخشِ «ترتیبِ استقرار» (نخستین رخدادِ هر نشانه صعودی؛ ذکرِ پیشینِ نام‌ها در اصل‌ها حساب نمی‌شود).
  const steps = section(text, "۲");
  const at = ORDER.map((s) => steps.indexOf(s));
  at.forEach((p, i) => p < 0 && out.push(`order:missing:${ORDER[i]}`));
  for (let i = 1; i < at.length; i++) if ((at[i] as number) >= 0 && (at[i - 1] as number) >= 0 && (at[i] as number) <= (at[i - 1] as number)) out.push(`order:${ORDER[i - 1]}>=${ORDER[i]}`);

  // ۶) جدولِ قرارداد = RUNTIME_CONTRACT (حقِ مجاز در ستونِ دوم؛ هیچ حقِ دیگری از فهرستِ کامل در آن ستون نباشد).
  const contractRows = new Map(section(text, "۳").split("\n").filter((l) => l.startsWith("|")).map(cells).map((c) => [c[0] ?? "", c[1] ?? ""]));
  const check = (label: string, cell: string | undefined, allowed: readonly string[], universe: readonly string[]): void => {
    if (cell === undefined) return void out.push(`contract:missingrow:${label}`);
    for (const p of universe) {
      const has = new RegExp(`\`${p}\``).test(cell);
      if (allowed.includes(p) !== has) out.push(`contract:${label}:${p}:${has ? "extra" : "missing"}`);
    }
  };
  check("schema", contractRows.get("شِما"), RUNTIME_CONTRACT.schema, ["USAGE", "CREATE"]);
  for (const [table, allowed] of Object.entries(RUNTIME_CONTRACT.tables)) check(table, contractRows.get(`\`${table}\``), allowed, ALL_TABLE_PRIVS);

  // ۷) بی‌رمز: رشتهٔ اتصالِ دارای رمزِ واقعی یا PASSWORD با مقدارِ لفظی ممنوع؛ فقط جانشین `<…>`.
  for (const m of text.matchAll(/postgres(?:ql)?:\/\/[^\s`<>]*:[^\s`<>@]+@/g)) out.push(`secret:url:${m[0].length}`);
  for (const m of text.matchAll(/PASSWORD\s+'([^']*)'/gi)) if (!/^<[^<>]+>$/.test(m[1] as string)) out.push("secret:password");

  // ۸) مسیرهای ریشه‌دارِ بک‌تیک موجودند.
  for (const m of text.matchAll(/`((?:src|tooling|docs)\/[^\s`*<>{}$()|=,;:?[\]"']+)`/g)) if (!exists(m[1] as string)) out.push(`path:${m[1]}`);

  return out;
}

const scriptsOf = (): ReadonlySet<string> => new Set(Object.keys((JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts));
const existsOf = (p: string): boolean => existsSync(join(ROOT, p));
const TEXT = readFileSync(RUNBOOK, "utf8");
const run = (text: string): string[] => checkRunbook(text, scriptsOf(), existsOf);

describe("راهنمای استقرارِ نقش‌های سیاستِ ابزار · هم‌خوانی با کد", () => {
  it("راهنمای فعلی هیچ نقضی ندارد", () => {
    expect(run(TEXT)).toEqual([]);
  });

  it("راهنما خالی/بریده نیست و هر شش گامِ استقرار را دارد", () => {
    expect(TEXT.length).toBeGreaterThan(3000);
    for (const n of ["۱", "۲", "۳", "۴", "۵", "۶", "۷"]) expect(section(TEXT, n).length).toBeGreaterThan(100);
    expect((section(TEXT, "۲").match(/^\| [۱-۶] \|/gm) ?? []).length).toBe(6);
  });

  describe("نقضِ ساختگی باید گرفته شود (بازرس کور نیست)", () => {
    const mutate = (from: string | RegExp, to: string): string => {
      const next = TEXT.replace(from, to);
      expect(next).not.toBe(TEXT);
      return next;
    };
    it("کدِ خروجِ عوض‌شده / نامِ ناموجود / ردیفِ حذف‌شده", () => {
      expect(run(mutate("| 5 | DRIFT |", "| 9 | DRIFT |"))).toContain("exit:DRIFT≠5");
      expect(run(mutate("| 8 | ROLE_UNUSABLE |", "| 8 | ROLE_BAD |"))).toEqual(expect.arrayContaining(["exit:ROLE_UNUSABLE≠8", "exit:extra:ROLE_BAD"]));
      expect(run(mutate(/^\| 7 \| TIMEOUT \|.*\n/m, ""))).toEqual(expect.arrayContaining(["exit:TIMEOUT≠7", "exit:rowcount"]));
    });
    it("اسکریپت/فرمان/فلگِ ناموجود", () => {
      expect(run(mutate("npm run policy:migrate --", "npm run policy:migrat --"))).toContain("script:policy:migrat");
      expect(run(mutate("policy:grants -- verify --role=policy_runtime` | **", "policy:grants -- check --role=policy_runtime` | **"))).toContain("command:policy:grants:check");
      expect(run(mutate("-- up --create-schema`", "-- up --create-schema --force`"))).toContain("flag:policy:migrate:--force");
    });
    it("env ناشناخته یا مستندنشده", () => {
      expect(run(mutate("`TOOL_POLICY_RETRY_MS`، ", ""))).toContain("env:undocumented:TOOL_POLICY_RETRY_MS");
      expect(run(`${TEXT}\n\`TOOL_POLICY_FOO_MS\``)).toContain("env:unknown:TOOL_POLICY_FOO_MS");
    });
    it("ترتیبِ جابه‌جاشدهٔ گام‌ها یا گامِ حذف‌شده", () => {
      const swapped = TEXT.replaceAll("policy:grants -- verify", "policy:grants -- ZZ").replace("policy:grants -- plan", "policy:grants -- verify").replaceAll("policy:grants -- ZZ", "policy:grants -- plan");
      expect(run(swapped).some((v) => v.startsWith("order:"))).toBe(true);
      expect(run(TEXT.replaceAll("CREATE ROLE", "ساختنِ نقش"))).toContain("order:missing:CREATE ROLE");
    });
    it("جدولِ قراردادِ ناهمخوان (حقِ زیاد یا گمشده)", () => {
      expect(run(mutate("| `tool_policy_migration_ledger` | فقط `SELECT` |", "| `tool_policy_migration_ledger` | `SELECT` + `UPDATE` |"))).toContain("contract:tool_policy_migration_ledger:UPDATE:extra");
      expect(run(mutate("`SELECT` + `INSERT` | خطا", "`SELECT` | خطا"))).toContain("contract:tool_policy_versions:INSERT:missing");
      expect(run(mutate("| شِما | `USAGE` |", "| شِما | `USAGE` + `CREATE` |"))).toContain("contract:schema:CREATE:extra");
    });
    it("رمز یا رشتهٔ اتصالِ دارای رمز", () => {
      expect(run(mutate("PASSWORD '<از مدیریتِ اسرار>'", "PASSWORD 'hunter2'"))).toContain("secret:password");
      expect(run(`${TEXT}\nDATABASE_URL=postgres://u:hunter2@db/x`)).toEqual(expect.arrayContaining([expect.stringMatching(/^secret:url:/)]));
      expect(run(`${TEXT}\nDATABASE_URL=postgres://db.internal/x`).some((v) => v.startsWith("secret:"))).toBe(false);
    });
    it("ارجاعِ مسیرِ ناموجود", () => {
      expect(run(`${TEXT}\nببینید \`src/modules/nope/index.ts\``)).toContain("path:src/modules/nope/index.ts");
    });
  });
});
