/**
 * رگرسیونِ «اجرای تست‌ها بدون پایگاه» (ماشین توسعه‌ای که `KB_TEST_DATABASE_URL`/`DATABASE_URL` ندارد، مثلاً ویندوزِ مالک).
 *
 * سیاست (test-db): بدون پایگاه، تست‌های پایگاه **رد (skip)** می‌شوند و اجرا **سبز** می‌ماند؛ فقط دروازهٔ صفر-رد
 * (`ci-tests.ts`) و `guard.test.ts` در CI آن را قرمز می‌کنند. باگ واقعی که این آزمون می‌گیرد: `describe.skip` بدنه‌اش را اجرا می‌کند
 * (hook‌هایش را نه)؛ پس هر `openTest…Db()` که در بدنهٔ `describe` (نه در `beforeAll`) صدا زده شود، بدون پایگاه یک promise ردشده و
 * بی‌دستگیره می‌سازد و Vitest با «Unhandled Rejection» اجرا را قرمز می‌کند — فقط وقتی پایگاه نیست، پس در CI/ماشین دارای پایگاه دیده نمی‌شد.
 *
 * روش: یک Vitest زیرفرایند، فقط روی فایل‌هایی که `test-db` را import می‌کنند، با محیطِ بی‌پایگاه و بی‌CI. محیط **صریحاً** خالی می‌شود
 * (`""` نه حذف) چون `dotenv` متغیرِ موجود را (حتی خالی) بازنویسی نمی‌کند؛ پس فایل `.env` توسعه‌دهنده نتیجه را عوض نمی‌کند.
 * مستقل از سیستم‌عامل است (`process.execPath` + ورودیِ جاوااسکریپتیِ Vitest؛ بی‌shell و بی‌`npx`).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "tooling/no-database-run.test.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".test.ts")) out.push(relative(ROOT, p).split("\\").join("/"));
  }
  return out;
}

/** فایل‌های تستی که کمک‌تست پایگاه را import می‌کنند (همان‌ها که بدون پایگاه باید رد شوند). */
function databaseTestFiles(): string[] {
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "tooling"))].filter((f) => f !== SELF);
  return files.filter((f) => /from\s+["'][^"']*test-db["']/.test(readFileSync(join(ROOT, f), "utf8"))).sort();
}

function offlineEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CI" || k === "GITHUB_ACTIONS" || k === "CI_MIN_PASSED" || k.startsWith("VITEST") || k.startsWith("GIT_")) continue;
    env[k] = v;
  }
  env["KB_TEST_DATABASE_URL"] = "";
  env["DATABASE_URL"] = "";
  return env as NodeJS.ProcessEnv;
}

describe("اجرای تست‌ها بدون پایگاه (ماشین توسعه‌ای بی‌PostgreSQL)", () => {
  const files = databaseTestFiles();

  it("فایل‌های تست پایگاه شناسایی می‌شوند (نگهبانِ خودِ آزمون؛ نه تهی)", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain("src/modules/ledger/pg/ledger.pg.property.test.ts");
    expect(files).toContain("src/modules/ledger/pg/store.test.ts");
    expect(files).toContain("src/modules/legal-kb-store/store.test.ts");
  });

  it("بدون پایگاه: Vitest با کد ۰ تمام می‌شود، بی‌هیچ خطای مدیریت‌نشده (Unhandled Rejection/Error) و بی‌شکست", () => {
    const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");
    const r = spawnSync(process.execPath, [vitest, "run", "--reporter=default", ...files], { cwd: ROOT, encoding: "utf8", env: offlineEnv(), timeout: 150_000, maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(r.error, String(r.error)).toBeUndefined();
    expect(out).not.toMatch(/Unhandled (Rejection|Error)/i);
    expect(out).not.toContain("Vitest caught");
    expect(out, out.slice(-2000)).not.toMatch(/\bfailed\b/i);
    expect(r.status, out.slice(-2000)).toBe(0);
    // واقعاً رد شده‌اند (نه اینکه پایگاه به‌طور ناخواسته پیدا شده و اجرا شده باشند):
    expect(out).toMatch(/skipped/);
  }, 180_000);
});
