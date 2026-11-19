/**
 * پیمانِ **ایستای** (بی‌پایگاه) قفلِ مشترکِ ساختِ شِما بینِ `ledger`، `settlement` و `legal-kb-store` (م۳‑ه‑۳‑و؛ ADR-0037).
 * همراهِ `schema-ensure-cross-module.pg.test.ts`: آن رفتارِ واقعی را می‌سنجد، این **سطحِ کد** را قفل می‌کند تا ماژولِ تازه‌ای
 * که `CREATE SCHEMA` می‌زند بی‌قفل و بی‌خبر وارد نشود (ریشهٔ همان خانوادهٔ باگِ `23505`).
 *   ۱) سه تعریفِ `ensureSchema` دقیقاً یک قالبِ کلید دارند و هر سه «قفل ← SELECT از pg_namespace ← CREATE SCHEMA IF NOT EXISTS» به همین ترتیب‌اند؛
 *   ۲) هر `CREATE SCHEMA` در کدِ غیرآزمونِ `src/` یا درون یکی از همین سه `ensureSchema` است یا در فهرستِ سفیدِ بسته (مهاجرتِ اعمال‌شدهٔ ممیزی)؛
 *   ۳) کلیدِ `schema:ensure:` جای دیگری در `src/` نیست (کپیِ چهارم باید آگاهانه به این آزمون اضافه شود).
 * خودِ پویشگر هم با نمونه‌های ساختگی آزموده می‌شود (نقضِ ساختگی را باید بگیرد).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const LOCK_KEY_TEMPLATE = "`schema:ensure:${schema}`";

/** تنها سه جایی که مجازند قفلِ مشترک و `CREATE SCHEMA` را در `ensureSchema` داشته باشند. */
const ENSURE_FILES: readonly string[] = ["src/modules/ledger/pg/migrate.ts", "src/modules/legal-kb-store/migrate.ts", "src/modules/settlement/pg/migrate.ts"];

/**
 * فهرستِ سفیدِ بستهٔ `CREATE SCHEMA` بیرون از `ensureSchema`: مهاجرتِ ۰۰۰۲ در legal-kb-store شِمای ممیزی را با `CREATE SCHEMA` ساده می‌سازد
 * (اعمال‌شده و ویرایش‌ناپذیر؛ checksum دارد)؛ زیرِ قفلِ ماژولی اجرا می‌شود، نه قفلِ مشترک (ADR-0036 محدودیت ۴ / ADR-0037).
 * افزودنِ ردیفِ تازه یعنی تصمیمِ معماری، نه گزینهٔ آزمون.
 */
const CREATE_SCHEMA_ALLOWLIST: Readonly<Record<string, number>> = { "src/modules/legal-kb-store/migrations.ts": 1 };

/** حذفِ توضیح‌ها (بلوکی و تک‌خطی) تا اشاره در مستندات به `CREATE SCHEMA` نقض شمرده نشود. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
}

type Finding = Readonly<{ file: string; rule: "create-schema-outside-ensure" | "create-schema-count" | "key-copy-outside-ensure" }>;

const CREATE_SCHEMA = /CREATE\s+SCHEMA\b/gi;

/** تابعِ خالصِ پویش روی `{مسیر ← متن}`؛ ensureFiles و allowlist تزریقی‌اند تا با نمونهٔ ساختگی آزموده شود. */
function scan(
  files: Readonly<Record<string, string>>,
  ensureFiles: readonly string[] = ENSURE_FILES,
  allow: Readonly<Record<string, number>> = CREATE_SCHEMA_ALLOWLIST,
): Finding[] {
  const out: Finding[] = [];
  for (const [file, raw] of Object.entries(files)) {
    const code = stripComments(raw);
    const creates = code.match(CREATE_SCHEMA)?.length ?? 0;
    const isEnsure = ensureFiles.includes(file);
    if (creates > 0 && !isEnsure) {
      const allowed = allow[file];
      if (allowed === undefined) out.push({ file, rule: "create-schema-outside-ensure" });
      else if (creates !== allowed) out.push({ file, rule: "create-schema-count" });
    }
    if (isEnsure && creates !== 1) out.push({ file, rule: "create-schema-count" });
    if (!isEnsure && code.includes("schema:ensure:")) out.push({ file, rule: "key-copy-outside-ensure" });
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) acc.push(p);
  }
  return acc;
}

function repoSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const abs of walk(join(ROOT, "src"))) {
    const rel = relative(ROOT, abs).replace(/\\/g, "/");
    // کمک‌تست‌ها (test-db.ts / test-kit.ts) کدِ تولید نیستند.
    if (/\/test-(db|kit)\.ts$/.test(rel)) continue;
    out[rel] = readFileSync(abs, "utf8");
  }
  return out;
}

/** بدنهٔ تابعِ `ensureSchema` تا اولین `}` در ستونِ صفر. */
function ensureBody(source: string): string {
  const start = source.indexOf("export async function ensureSchema(");
  expect(start, "ensureSchema پیدا نشد").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 3);
}

describe("tooling · پیمانِ ایستای قفلِ مشترکِ ساختِ شِما (ledger ≡ settlement ≡ legal-kb-store)", () => {
  const sources = repoSources();

  it("هر سه فایلِ ensureSchema هست و هر کدام دقیقاً یک تعریفِ ensureSchema دارد", () => {
    for (const f of ENSURE_FILES) {
      expect(sources[f], f).toBeDefined();
      expect((sources[f] as string).match(/export async function ensureSchema\(/g)?.length, f).toBe(1);
    }
  });

  it("هر سه از یک قالبِ کلیدِ یکسان استفاده می‌کنند و فقط یک بار در هر فایل (کلیدِ نوشته‌شده با هم برابرند)", () => {
    for (const f of ENSURE_FILES) {
      const body = stripComments(ensureBody(sources[f] as string));
      expect(body.split(LOCK_KEY_TEMPLATE).length - 1, f).toBe(1);
      expect(body, f).toContain(`pg_advisory_xact_lock(hashtextextended(\${${LOCK_KEY_TEMPLATE}}, 0))`);
    }
  });

  it("ترتیبِ درونِ هر ensureSchema: قفل ← SELECT از pg_catalog.pg_namespace ← CREATE SCHEMA IF NOT EXISTS (فقط در نبودِ ردیف)", () => {
    for (const f of ENSURE_FILES) {
      const body = stripComments(ensureBody(sources[f] as string));
      const lock = body.indexOf("pg_advisory_xact_lock");
      const select = body.indexOf("FROM pg_catalog.pg_namespace WHERE nspname = ${schema}");
      const create = body.indexOf("CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}");
      expect([lock, select, create].every((i) => i >= 0), f).toBe(true);
      expect(lock, f).toBeLessThan(select);
      expect(select, f).toBeLessThan(create);
      expect(body, f).toMatch(/if \(rows\.length === 0\) await ex\.execute\(sql`CREATE SCHEMA IF NOT EXISTS/);
    }
  });

  it("هر CREATE SCHEMA در کدِ غیرآزمونِ src/ یا در ensureSchema است یا در فهرستِ سفیدِ بسته؛ کلید جای دیگری کپی نشده", () => {
    expect(scan(sources)).toEqual([]);
  });

  it("فهرستِ سفید زنده است: فایل‌های آن هنوز همان تعدادِ CREATE SCHEMA را دارند (چنگکِ ایستا، نه بایگانی)", () => {
    for (const [f, n] of Object.entries(CREATE_SCHEMA_ALLOWLIST)) {
      expect(sources[f], f).toBeDefined();
      expect(stripComments(sources[f] as string).match(CREATE_SCHEMA)?.length ?? 0, f).toBe(n);
    }
  });
});

describe("tooling · خودِ پویشگر نقض را می‌گیرد", () => {
  const ENS = ["a/ensure.ts"];
  const OK = "await ex.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);";

  it("ماژولِ تازه‌ای که CREATE SCHEMA می‌زند (بیرونِ ensure و فهرستِ سفید) گرفته می‌شود", () => {
    expect(scan({ "a/ensure.ts": OK, "b/new.ts": "tx.execute(sql`CREATE SCHEMA IF NOT EXISTS x`)" }, ENS, {})).toEqual([{ file: "b/new.ts", rule: "create-schema-outside-ensure" }]);
  });

  it("حروفِ کوچک و فاصلهٔ چندگانه هم گرفته می‌شود", () => {
    expect(scan({ "a/ensure.ts": OK, "b/new.ts": "create   schema foo" }, ENS, {}).map((x) => x.rule)).toEqual(["create-schema-outside-ensure"]);
  });

  it("اشاره در توضیح (بلوکی/تک‌خطی) نقض نیست", () => {
    const doc = "/** CREATE SCHEMA IF NOT EXISTS */\n// CREATE SCHEMA x\nexport const a = 1;";
    expect(scan({ "a/ensure.ts": OK, "b/doc.ts": doc }, ENS, {})).toEqual([]);
  });

  it("کپیِ کلید بیرونِ ensure گرفته می‌شود", () => {
    expect(scan({ "a/ensure.ts": OK, "b/copy.ts": "const k = `schema:ensure:${s}`;" }, ENS, {}).map((x) => x.rule)).toEqual(["key-copy-outside-ensure"]);
  });

  it("تعدادِ CREATE SCHEMA در فایلِ سفید یا ensure تغییر کند گرفته می‌شود (افزودنِ دوم/حذف)", () => {
    expect(scan({ "a/ensure.ts": OK, "w/mig.ts": "CREATE SCHEMA a; CREATE SCHEMA b;" }, ENS, { "w/mig.ts": 1 }).map((x) => x.rule)).toEqual(["create-schema-count"]);
    expect(scan({ "a/ensure.ts": `${OK}\n${OK}` }, ENS, {}).map((x) => x.rule)).toEqual(["create-schema-count"]);
    expect(scan({ "a/ensure.ts": "export const none = 1;" }, ENS, {}).map((x) => x.rule)).toEqual(["create-schema-count"]);
  });

  it("فایلِ سفیدِ سالم و فایلِ بی‌ارتباط یافتهٔ کاذب نمی‌دهند", () => {
    expect(scan({ "a/ensure.ts": OK, "w/mig.ts": "CREATE SCHEMA a;", "c/x.ts": "export const v = 1;" }, ENS, { "w/mig.ts": 1 })).toEqual([]);
  });
});
