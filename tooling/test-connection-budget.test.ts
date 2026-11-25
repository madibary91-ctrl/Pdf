/**
 * نگهبانِ «بودجهٔ اتصال آزمون‌ها» (ADR-0024، تحویل ۰۰۲۴) — بی‌پایگاه، همیشه اجرا می‌شود.
 *
 * چرا؟ Vitest فایل‌های آزمون را موازی اجرا می‌کند و PostgreSQL سقفِ اتصال دارد (`max_connections`، پیش‌فرض ۱۰۰). استخرِ `pg` اتصالِ بیکار را
 * ۱۰ ثانیه نگه می‌دارد؛ فایلی که چندین استخر را تا `afterAll` باز می‌گذارد (۲۴×۴ = ۹۶ در آزمون تفاضلیِ settlement؛ ۸۵ در ledger) کلِ سقف را می‌خورد و
 * فایلِ هم‌زمانِ دیگر `53300 too many clients` می‌گیرد ⇒ شکستِ تصادفیِ بی‌ارتباط با کدِ آن فایل (ناپایداریِ دروازهٔ صفر-شکست، بی‌`retry`).
 * قاعده: هر `new Pool({ connectionString: TEST_DB_URL … })` در کمک‌تست‌های `src/**​/test-db.ts` باید `idleTimeoutMillis` در (۰، ۱۰۰۰] بدهد.
 * تازه‌ترین سنجش با پایگاه واقعی (اوجِ اتصال) در `settlement/pg/connection-budget.pg.test.ts` است؛ این‌جا فقط جلوی بازگشتِ الگو را می‌گیرد.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

export const MAX_IDLE_MS = 1_000;

/** مشکل‌های استخرهای آزمونِ بی‌مهلتِ بیکاری در یک متنِ منبع (خالص). */
export function findPoolProblems(source: string): string[] {
  const problems: string[] = [];
  const idleConst = (name: string): number | null => {
    const m = new RegExp(`const\\s+${name}\\s*(?::\\s*number\\s*)?=\\s*([0-9_]+)\\s*;`).exec(source);
    return m === null ? null : Number((m[1] as string).replace(/_/g, ""));
  };
  for (const m of source.matchAll(/new\s+Pool\(\{([^}]*)\}/g)) {
    const body = m[1] as string;
    if (!body.includes("TEST_DB_URL")) continue; // اتصالِ عمداً خراب/استخرِ ویژهٔ آزمونِ خرابی: بی‌قاعده
    const idle = /idleTimeoutMillis\s*:\s*([A-Za-z_][A-Za-z_0-9]*|[0-9_]+)/.exec(body);
    if (idle === null) {
      problems.push("بدون idleTimeoutMillis");
      continue;
    }
    const raw = idle[1] as string;
    const value = /^[0-9_]+$/.test(raw) ? Number(raw.replace(/_/g, "")) : idleConst(raw);
    if (value === null) problems.push(`idleTimeoutMillis=${raw} قابل‌حل نیست`);
    else if (!(value > 0 && value <= MAX_IDLE_MS)) problems.push(`idleTimeoutMillis=${value} خارج از (۰، ${MAX_IDLE_MS}]`);
  }
  return problems;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === "test-db.ts") out.push(p);
  }
  return out;
}

describe("tooling · بودجهٔ اتصال آزمون‌ها (اسکنر)", () => {
  it("استخرِ بی‌مهلت، مهلتِ بلند یا نامعلوم را می‌گیرد", () => {
    expect(findPoolProblems("const pool = new Pool({ connectionString: TEST_DB_URL, max: 10 });")).toEqual(["بدون idleTimeoutMillis"]);
    expect(findPoolProblems("new Pool({ connectionString: TEST_DB_URL, max: 4, idleTimeoutMillis: 10_000 })")).toEqual(["idleTimeoutMillis=10000 خارج از (۰، 1000]"]);
    expect(findPoolProblems("new Pool({ connectionString: TEST_DB_URL, idleTimeoutMillis: 0 })")).toEqual(["idleTimeoutMillis=0 خارج از (۰، 1000]"]);
    expect(findPoolProblems("new Pool({ connectionString: TEST_DB_URL, idleTimeoutMillis: UNKNOWN })")).toEqual(["idleTimeoutMillis=UNKNOWN قابل‌حل نیست"]);
    expect(findPoolProblems("new Pool({ connectionString: TEST_DB_URL, idleTimeoutMillis: LATE })\nconst LATE = 5000;")).toEqual(["idleTimeoutMillis=5000 خارج از (۰، 1000]"]);
  });

  it("مهلتِ کوتاه (عدد یا ثابتِ هم‌فایل)، چند استخر در یک فایل و استخرِ غیرآزمونی را می‌پذیرد/نمی‌شمارد", () => {
    expect(findPoolProblems("new Pool({ connectionString: TEST_DB_URL, max: options.poolSize ?? 10, idleTimeoutMillis: 50 })")).toEqual([]);
    expect(findPoolProblems("export const IDLE: number = 1_000;\nnew Pool({ connectionString: TEST_DB_URL, idleTimeoutMillis: IDLE })")).toEqual([]);
    expect(findPoolProblems("new Pool({ connectionString: TEST_DB_URL, idleTimeoutMillis: 50 })\nnew Pool({ connectionString: TEST_DB_URL, max: 1 })")).toEqual(["بدون idleTimeoutMillis"]);
    expect(findPoolProblems('new Pool({ host: "127.0.0.1", port: 1, max: 1 })')).toEqual([]);
  });

  it("همهٔ کمک‌تست‌های پایگاهِ مخزن (src/**/test-db.ts) استخرِ با مهلتِ بیکاریِ کوتاه می‌سازند", () => {
    const root = join(__dirname, "..", "src");
    const files = walk(root).map((f) => relative(join(__dirname, ".."), f).split("\\").join("/")).sort();
    // فهرست شناخته‌شده: کمک‌تستِ تازه باید آگاهانه اضافه شود (و از همین قاعده بگذرد).
    expect(files).toEqual([
      "src/modules/ledger/pg/test-db.ts",
      "src/modules/legal-kb-store/test-db.ts",
      "src/modules/metering/test-db.ts",
      "src/modules/retrieval/test-db.ts",
      "src/modules/settlement-backlog/test-db.ts",
      "src/modules/settlement-runtime/test-db.ts",
      "src/modules/settlement/pg/test-db.ts",
      "src/modules/settlement/test-db.ts",
      "src/modules/tool-policy-store-pg/test-db.ts",
    ]);
    for (const f of files) {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      expect(src, `${f}: باید دست‌کم یک استخرِ آزمون بسازد`).toMatch(/new\s+Pool\(\{[^}]*TEST_DB_URL/);
      expect(findPoolProblems(src), f).toEqual([]);
    }
  });
});
