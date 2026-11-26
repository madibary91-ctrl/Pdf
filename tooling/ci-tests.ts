/**
 * «دروازهٔ صفر-رد» (zero-skip gate) برای CI — تنها دستور رسمی اجرای تست‌ها در محیط خودکار.
 *
 * چرا؟ تست‌های پایگاه‌داده وقتی پایگاه تنظیم نباشد بی‌صدا `skip` می‌شوند و Vitest باز هم «سبز» می‌دهد.
 * برای نرم‌افزار حقوقی «سبزِ بی‌اجرا» پذیرفتنی نیست. این فایل سه کار می‌کند:
 *   1. پیش از اجرا مطمئن می‌شود پایگاه آزمون تنظیم و در دسترس است (وگرنه با پیام روشن قرمز می‌شود)؛
 *   2. Vitest را با `CI=true` و گزارش JSON اجرا می‌کند؛
 *   3. گزارش را می‌خواند و اگر حتی یک تست رد شده/شکست‌خورده باشد یا شمار تست‌های سبز از کف مقرر کمتر باشد، قرمز می‌شود.
 *
 * اجرا (محلی و CI یکسان):  node tooling/ci-tests.ts
 *   (Node ≥ 22.18؛ بدون وابستگی تازه: TypeScript با «حذف نوع» در خود Node اجرا می‌شود.)
 *
 * بخش خالصِ این فایل (`evaluateReport`) در `tooling/ci-tests.test.ts` آزموده می‌شود.
 * `todo`ها (نمونه‌های مرجع منتظر حقوقدان، AGENTS.md قاعدهٔ ۷) رد‌شده حساب نمی‌شوند، ولی در خروجی گزارش می‌شوند.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

/**
 * کفِ شمار تست‌های سبز (چنگک): اگر فایل تستی بی‌صدا از اجرا خارج شود (مثلاً با `exclude` در پیکربندی)،
 * شمار سبزها می‌افتد و CI قرمز می‌شود. هنگام افزودن تست جدید می‌توان بالا برد؛ پایین آوردنش نیاز به بازبینی دارد.
 * (۱۷۶۱ = وضعیت پس از ذخیرهٔ PostgreSQL دفتر اعتبار `ledger` (ADR-0019 ل۲)، با PostgreSQL ۱۵ واقعی و ۰ رد؛ پیشینه: ۶۰۳ ← ۷۳۵ ← ۸۲۳ ← ۱۳۷۷ ← ۱۵۷۲ ← ۱۷۶۱ ← ۱۹۴۵ (پس از metering، ADR-0020 م۱) ← … ← ۳۹۴۲ ← ۴۰۴۲ (پس از settlement-migrate، ADR-0034) ← ۴۰۷۱ (پس از settlement-schema-ensure، ADR-0035) ← ۴۰۹۳ (legal-kb-store-schema-ensure، ADR-0036) ← ۴۱۱۳ (پیمانِ کلیدِ schema:ensure، ADR-0037) ← ۴۱۳۶ (نگهبانِ ارجاع‌های مستنداتِ زنده، ADR-0038) ← ۴۳۵۰ (پایشِ پسماندِ زنگِ تسویه `settlement-backlog`، ADR-0039) ← ۴۳۸۲ (رفعِ ناپایداریِ انتظارِ قفلِ کانونی `lock-wait`، ADR-0040) ← ۴۴۰۳ (علتِ ناپایداریِ دودیِ زمانِ واقعیِ `settlement-runtime` و پیامِ شکستِ تشخیصی، ADR-0041) ← ۴۴۰۳ (پایداریِ دودیِ زمانِ واقعی، ADR-0041) ← ۴۵۹۷ (پایشِ زندهٔ پسماندِ زنگِ تسویه `settlement-backlog-watch`، ADR-0042) ← ۴۶۷۷ (سیم‌کشیِ پایش به بوت و پروب‌های HTTP در `settlement-bootstrap`، ADR-0043) ← ۴۸۱۳ (ابزارِ `backlog:cost`، ADR-0044) ← ۴۸۵۳ (سقفِ زمانِ سمتِ پایگاهِ خواندن‌های outbox، ADR-0045) ← ۴۸۷۲ (سیم‌کشیِ سقفِ سمتِ پایگاه در پایشِ `settlement-bootstrap`، ADR-0045) ← ۵۰۱۱ (نمایهٔ مشتقِ `settlement-pending`، ADR-0046) ← ۵۰۹۹ (CLIِ نمایه `settlement-pending-migrate`، ADR-0047) ← ۵۱۳۲ (برگشتِ رسمیِ نمایه `down()` در `settlement-pending`، ADR-0048) ← ۵۱۷۹ (دستورِ `down` در CLI، ADR-0049) ← ۵۱۸۹ (وجود‌سنجیِ بی‌کشِ کهنه `relationExists`، ADR-0050) ← ۵۲۵۷ (منبعِ pending در bootstrap، ADR-0051) ← ۵۲۷۰ (دامنهٔ انتظارِ قفلِ مشورتی و کنترلِ منفیِ بی‌وابستگی به بار، ADR-0052) ← ۵۸۴۸ (ادغامِ ۰۰۵۶+۰۰۵۷؛ ⚠ کمتر از واقع بود: شمارِ واقعی پس از ادغام ۶۰۳۶ است) ← ۶۱۷۱ (مجریِ حلقهٔ ابزار `tool-runner`، ADR-0058؛ ۶۰۳۶ + ۱۳۵، با PostgreSQL واقعی و ۰ رد).)
 * بالا بردن کف **هیچ تستی را عوض نمی‌کند**: `tooling/gate-floor.ts` آخرین مقدار تأییدشده را از تاریخچهٔ گیت می‌خواند و فقط
 * «کاهش» را می‌گیرد (ADR-0012). پایین آوردن ممنوع است (G3).
 */
export const MIN_PASSED_TESTS = 8575;

/**
 * کد خروجیِ «پایگاه آزمون در دسترس نیست» (تنظیم‌نشده، اتصال ناممکن یا بدون دسترسی CREATE) — جدا از «تست شکست خورد» (۱).
 * چرا؟ هوک `pre-push` محلی باید بتواند این دو را تشخیص دهد: نبودن پایگاه در ماشین توسعه هشدار است (دروازهٔ نهایی CI است)،
 * ولی شکستِ واقعی تست همیشه مسدودکننده است. CI و «کنترل منفی» فقط «غیرصفر» را می‌سنجند؛ پس این کد دروازه را ضعیف نمی‌کند.
 * مقدار باید با `GATE_EXIT_DB_UNAVAILABLE` در `git-discipline.ts` یکی بماند (آزمون همگامی در `pre-push-gate.test.ts`).
 */
export const EXIT_DB_UNAVAILABLE = 3;

export type GateOptions = Readonly<{ minPassed: number }>;

export type GateSummary = Readonly<{
  files: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
}>;

export type GateResult = Readonly<{
  ok: boolean;
  problems: readonly string[];
  summary: GateSummary;
  skippedTests: readonly string[];
  failedTests: readonly string[];
  todoTests: readonly string[];
}>;

type Assertion = { status: string; fullName: string };
type FileResult = { name: string; status: string; assertions: Assertion[] };

const EMPTY: GateSummary = { files: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseReport(report: unknown): FileResult[] | null {
  if (!isRecord(report) || !Array.isArray(report["testResults"])) return null;
  const files: FileResult[] = [];
  for (const f of report["testResults"] as unknown[]) {
    if (!isRecord(f) || typeof f["name"] !== "string" || typeof f["status"] !== "string" || !Array.isArray(f["assertionResults"])) return null;
    const assertions: Assertion[] = [];
    for (const a of f["assertionResults"] as unknown[]) {
      if (!isRecord(a) || typeof a["status"] !== "string") return null;
      assertions.push({ status: a["status"], fullName: typeof a["fullName"] === "string" ? a["fullName"] : "(بدون نام)" });
    }
    files.push({ name: f["name"], status: f["status"], assertions });
  }
  return files;
}

/** ارزیابی خالص گزارش JSON ویتست؛ هر چیزِ نامعمول یا مبهم = شکست (ایمن‌به‌طور پیش‌فرض). */
export function evaluateReport(report: unknown, options: GateOptions): GateResult {
  const files = parseReport(report);
  if (files === null) {
    return { ok: false, problems: ["گزارش آزمون ناخوانا/نامعتبر است (ساختار JSON ویتست نیست)."], summary: EMPTY, skippedTests: [], failedTests: [], todoTests: [] };
  }
  const skippedTests: string[] = [];
  const failedTests: string[] = [];
  const todoTests: string[] = [];
  const problems: string[] = [];
  let passed = 0;

  for (const file of files) {
    const label = file.name.replace(/\\/g, "/");
    // فایلی که اصلاً بارگذاری نشده (خطای import/سینتکس) assertion ندارد ولی وضعیتش failed است.
    if (file.status !== "passed" && file.status !== "skipped" && file.assertions.every((a) => a.status !== "failed")) {
      failedTests.push(`${label} (فایل اجرا نشد: ${file.status})`);
    }
    if (file.status === "skipped" && file.assertions.length === 0) skippedTests.push(`${label} (کل فایل رد شد)`);
    for (const a of file.assertions) {
      const entry = `${label} › ${a.fullName}`;
      if (a.status === "passed") passed++;
      else if (a.status === "failed") failedTests.push(entry);
      else if (a.status === "todo") todoTests.push(entry);
      else skippedTests.push(entry); // skipped | pending | disabled | هر وضعیت ناشناخته ⇒ «اجرا نشده»
    }
  }

  if (failedTests.length > 0) problems.push(`${failedTests.length} تست/فایل شکست خورد.`);
  if (skippedTests.length > 0) problems.push(`${skippedTests.length} تست رد (skip) شد؛ در CI هیچ تستی نباید رد شود (پایگاه آزمون تنظیم و در دسترس باشد).`);
  if (passed < options.minPassed) problems.push(`فقط ${passed} تست سبز شد؛ کف مقرر ${options.minPassed} است (آیا فایل تستی از اجرا خارج شده؟).`);

  const summary: GateSummary = { files: files.length, passed, failed: failedTests.length, skipped: skippedTests.length, todo: todoTests.length };
  return { ok: problems.length === 0, problems, summary, skippedTests, failedTests, todoTests };
}

/**
 * علتِ شکست‌ها از گزارش JSON (خالص و آزمون‌پذیر): «نام تست + اولین خط پیام خطا».
 * بدون این، فقط «۱ تست شکست خورد» دیده می‌شد و برای یافتن علت باید لاگ کامل (نیازمند دسترسی) باز می‌شد؛
 * اکنون همین فهرست در خروجی، annotation و Step Summary گیت‌هاب می‌آید.
 */
export function describeFailures(report: unknown, limit = 20): readonly string[] {
  if (!isRecord(report) || !Array.isArray(report["testResults"])) return [];
  const out: string[] = [];
  for (const f of report["testResults"] as unknown[]) {
    if (!isRecord(f) || typeof f["name"] !== "string") continue;
    const label = f["name"].replace(/\\/g, "/").replace(/^.*\/((?:src|tooling)\/)/, "$1");
    let reported = false;
    for (const a of Array.isArray(f["assertionResults"]) ? (f["assertionResults"] as unknown[]) : []) {
      if (!isRecord(a) || a["status"] !== "failed") continue;
      reported = true;
      const first = Array.isArray(a["failureMessages"]) && typeof a["failureMessages"][0] === "string" ? firstLine(a["failureMessages"][0]) : "(بدون پیام)";
      out.push(`${label} › ${typeof a["fullName"] === "string" ? a["fullName"] : "(بدون نام)"} — ${first}`);
    }
    // فایلی که اصلاً بارگذاری نشد (خطای import/سینتکس): پیام در سطح فایل است.
    if (!reported && f["status"] === "failed") out.push(`${label} — ${typeof f["message"] === "string" && f["message"] !== "" ? firstLine(f["message"]) : "فایل اجرا نشد"}`);
  }
  if (out.length > limit) return [...out.slice(0, limit), `… و ${out.length - limit} مورد دیگر`];
  return out;
}

function firstLine(text: string): string {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
  return (clean.split(/\r?\n/).find((l) => l.trim() !== "") ?? "(بدون پیام)").trim().slice(0, 300);
}

// ───────────────────────────── اجرای خط فرمان ─────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * خطِ annotation گیت‌هاب (خالص). در «کنترل منفی» (`CI_GATE_SELF_CHECK=1`) قرمز‌شدنِ دروازه **مورد انتظار** است؛
 * اگر همان `::error::` چاپ شود، صفحهٔ اجرا یک خطای قرمز نشان می‌دهد در حالی که گام سبز است و کاربر را به اشتباه می‌اندازد
 * (دقیقاً همان پیام «KB_TEST_DATABASE_URL یا DATABASE_URL لازم است» که علت شکست واقعی نبود). پس به `notice` با برچسب روشن تنزل می‌یابد.
 */
export function gateAnnotation(kind: "error" | "warning" | "notice", message: string, selfCheck: boolean): string {
  const text = message.replace(/\r?\n/g, " ");
  if (selfCheck && kind === "error") return `::notice::[کنترل منفی؛ شکست مورد انتظار است و علت شکست CI نیست] ${text}`;
  return `::${kind}::${text}`;
}

const IS_SELF_CHECK = process.env["CI_GATE_SELF_CHECK"] === "1";

function annotate(kind: "error" | "warning" | "notice", message: string): void {
  if (process.env["GITHUB_ACTIONS"] === "true") say(gateAnnotation(kind, message, IS_SELF_CHECK));
}

function stepSummary(markdown: string): void {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, `${markdown}\n`);
}

/** نشانی پایگاه آزمون؛ هرگز کامل چاپ نمی‌شود (ممکن است گذرواژه داشته باشد). */
function testDbUrl(): string | undefined {
  const url = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  return url !== undefined && url !== "" ? url : undefined;
}

async function preflightDatabase(url: string): Promise<string | null> {
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
  try {
    const r = await pool.query<{ version: string; can_create: boolean }>(
      "select version() as version, has_database_privilege(current_user, current_database(), 'CREATE') as can_create",
    );
    const row = r.rows[0];
    if (!row) return "پایگاه پاسخ خالی داد.";
    if (!row.can_create) return "کاربر پایگاه اجازهٔ CREATE (ساخت شِمای آزمون) ندارد.";
    say(`✔ پایگاه آزمون در دسترس است: ${row.version.split(",")[0] ?? row.version}`);
    return null;
  } catch (e) {
    const code = isRecord(e) && typeof e["code"] === "string" ? ` [${e["code"]}]` : "";
    return `اتصال به پایگاه آزمون ممکن نشد${code} (نشانی را در KB_TEST_DATABASE_URL/DATABASE_URL بررسی کنید).`;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function vitestEntry(): string {
  const require = createRequire(join(ROOT, "package.json"));
  const pkgPath = require.resolve("vitest/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["vitest"];
  if (!bin) throw new Error("ورودی اجرایی vitest پیدا نشد.");
  return join(dirname(pkgPath), bin);
}

function fail(message: string, exitCode = 1): never {
  annotate("error", message);
  process.stderr.write(`✘ ${message}\n`);
  if (!IS_SELF_CHECK) stepSummary(`### ❌ دروازهٔ تست شکست خورد\n\n${message}\n`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  const url = testDbUrl();
  if (url === undefined) {
    fail("پایگاه آزمون تنظیم نشده است: KB_TEST_DATABASE_URL یا DATABASE_URL لازم است. (تست‌های پایگاه نباید رد شوند.)", EXIT_DB_UNAVAILABLE);
  }
  const dbProblem = await preflightDatabase(url);
  if (dbProblem !== null) fail(dbProblem, EXIT_DB_UNAVAILABLE);

  const reportDir = join(ROOT, "test-results");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, "vitest-report.json");

  const run = spawnSync(process.execPath, [vitestEntry(), "run", "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
  if (run.error) fail(`اجرای vitest ممکن نشد: ${run.error.message}`);
  if (!existsSync(reportPath)) fail("vitest گزارش JSON نساخت (احتمالاً پیش از اجرای تست‌ها از کار افتاد).");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    fail("گزارش JSON ویتست قابل خواندن نیست.");
  }
  const minPassed = Number.parseInt(process.env["CI_MIN_PASSED"] ?? "", 10) || MIN_PASSED_TESTS;
  const result = evaluateReport(parsed, { minPassed });
  const s = result.summary;

  say("\n──────── دروازهٔ صفر-رد ────────");
  say(`فایل: ${s.files} | سبز: ${s.passed} | شکست: ${s.failed} | رد‌شده: ${s.skipped} | todo: ${s.todo} | کف سبز: ${minPassed}`);
  for (const t of result.failedTests) say(`  ✘ شکست: ${t}`);
  for (const t of result.skippedTests.slice(0, 30)) say(`  ⤼ رد‌شده: ${t}`);
  if (result.skippedTests.length > 30) say(`  … و ${result.skippedTests.length - 30} مورد دیگر`);
  if (result.todoTests.length > 0) {
    say(`ℹ ${result.todoTests.length} مورد todo (منتظر نمونهٔ مرجع حقوقدان؛ رد‌شده حساب نمی‌شود).`);
    annotate("notice", `${result.todoTests.length} تست todo منتظر نمونهٔ مرجع حقوقدان است.`);
  }

  const table = `| فایل | سبز | شکست | رد‌شده | todo |\n|---|---|---|---|---|\n| ${s.files} | ${s.passed} | ${s.failed} | ${s.skipped} | ${s.todo} |`;
  if (!result.ok || run.status !== 0) {
    const reasons = [...result.problems, ...(run.status !== 0 ? [`vitest با کد ${String(run.status)} پایان یافت.`] : [])];
    for (const p of reasons) say(`✘ ${p}`);
    const details = describeFailures(parsed);
    for (const d of details) say(`  ↳ ${d}`);
    if (details.length > 0) {
      for (const d of details) annotate("error", d);
      stepSummary(`### ❌ علت شکست‌ها\n\n${details.map((d) => `- ${d}`).join("\n")}\n`);
    }
    fail(reasons.join(" "));
  }
  say("✔ همهٔ تست‌ها واقعاً اجرا و سبز شدند (۰ رد، ۰ شکست).");
  stepSummary(`### ✅ دروازهٔ تست سبز\n\n${table}\n\n۰ رد‌شده؛ تست‌های پایگاه واقعاً اجرا شدند. (${s.todo} todo منتظر حقوقدان)`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((e: unknown) => fail(`خطای پیش‌بینی‌نشده در اجراگر: ${e instanceof Error ? e.message : String(e)}`));
}
