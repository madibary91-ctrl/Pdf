/**
 * tool-policy-migrate — سیاستِ آرگومان و محیط (ADR-0080 تصمیم ۲). تابعِ خالص و بی‌پرتاب؛ ورودی `unknown`.
 *  - دستور: `status` | `up` (یا تنها `--help`/`-h`). دستورِ دیگر، دستورِ تکراری، فلگِ ناشناخته/تکراری، آرگومانِ اضافه ⇒ خطا.
 *  - فلگ: `--timeout-ms=N` (یک توکن؛ N فقط رقمِ لاتینِ مثبت در [۱۰۰۰، ۶۰۰۰۰۰]، پیش‌فرض ۶۰٬۰۰۰) و `--create-schema` (بی‌مقدار، فقط با `up`).
 *  - **شِما فقط از محیط** (`TOOL_POLICY_SCHEMA`، همان نام و همان معنای tool-policy-bootstrap: نبودن/خالی = پیش‌فرض)، نه از فلگ:
 *    تا مهاجرت‌دهنده و برنامه هرگز دو شِمای متفاوت را نبینند (آزمونِ همارزی در tooling).
 *  - `DATABASE_URL` الزامی است؛ مقدارش هرگز خوانده/برگردانده نمی‌شود (فقط حضورش سنجیده می‌شود؛ اتصال را گلو می‌سازد).
 *  - غلط‌یابِ نام: هر کلیدِ ناشناختهٔ `TOOL_POLICY_*` همیشه خطاست (برخلافِ bootstrap که با `off` نادیده می‌گرفت): CLI روی «شِمای پیش‌فرض» می‌نویسد،
 *    پس تایپِ `TOOL_POLICY_SCHEMAA` نباید بی‌صدا شِمای اشتباه را مهاجرت دهد. مقدارِ دیگرِ متغیرهای شناخته‌شده (مثلاً `TOOL_POLICY_HOST`) اینجا نادیده است؛ صاحبش bootstrap است.
 *  - مشکل‌ها فقط نامِ متغیر یا نامِ فلگِ شبیهِ فلگ‌اند، هرگز مقدار؛ **آرگومانِ موضعی هرگز پژواک نمی‌شود** (ممکن است رشتهٔ اتصالی باشد که اشتباهاً داده شده).
 */
import type { ArgsResult } from "./types";

export const ENV_DATABASE_URL = "DATABASE_URL";
export const ENV_SCHEMA = "TOOL_POLICY_SCHEMA";
const ENV_PREFIX = "TOOL_POLICY_";

/** نام‌های `TOOL_POLICY_*`ی که CLI می‌پذیرد: دقیقاً مجموعهٔ tool-policy-bootstrap (آزمونِ همارزی در tooling قفلش می‌کند). */
export const KNOWN_TOOL_POLICY_ENV: readonly string[] = Object.freeze([
  "TOOL_POLICY_HOST",
  "TOOL_POLICY_INTERVAL_MS",
  "TOOL_POLICY_RETRY_MS",
  "TOOL_POLICY_ATTEMPT_DEADLINE_MS",
  "TOOL_POLICY_REFRESH_TIMEOUT_MS",
  "TOOL_POLICY_MAX_STALE_MS",
  ENV_SCHEMA,
  "TOOL_POLICY_STATEMENT_TIMEOUT_MS",
  "TOOL_POLICY_SHUTDOWN_TIMEOUT_MS",
  "TOOL_POLICY_BOOT_ATTEMPTS",
  "TOOL_POLICY_BOOT_RETRY_DELAY_MS",
]);

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
const FLAG_TIMEOUT = "--timeout-ms";
const FLAG_CREATE_SCHEMA = "--create-schema";
const DIGITS = /^[1-9][0-9]{0,9}$/;

export const USAGE: readonly string[] = Object.freeze([
  "tool-policy-migrate status [--timeout-ms=N]",
  "tool-policy-migrate up [--create-schema] [--timeout-ms=N]",
  "tool-policy-migrate --help",
  `env: ${ENV_DATABASE_URL} (الزامی)، ${ENV_SCHEMA} (اختیاری؛ پیش‌فرض tool_policy)`,
]);

/** نامِ کلیدِ env (نه مقدارش) با نویسه‌های قابل‌چاپ و کوتاه‌شده در پیام می‌آید. */
const safeName = (k: string): string => JSON.stringify(k.replace(/[^\x20-\x7e]/g, "?").slice(0, 48));
/** فقط نامِ فلگِ شبیهِ فلگ (`--abc-d`) پژواک می‌شود؛ هر چیزِ دیگر (مثلاً رشتهٔ اتصالِ اشتباهاً داده‌شده) هرگز. */
const safeFlag = (name: string): string => (/^--[a-z][a-z0-9-]{0,31}$/.test(name) ? JSON.stringify(name) : "?");

export function parseMigrateArgs(argv: unknown, env: unknown): ArgsResult {
  let command: "status" | "up" | null = null;
  try {
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) return { ok: false, command, issues: ["argv باید آرایه‌ای از رشته باشد."] };
    const args = argv as readonly string[];
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { ok: true, value: Object.freeze({ command: "help" as const }) };

    const issues: string[] = [];
    let timeoutMs: number | null = null;
    let createSchema = false;
    let seenCommand = false;
    let seenTimeout = false;
    let seenCreate = false;
    for (const a of args) {
      if (a === "--help" || a === "-h") {
        issues.push("--help باید تنها بیاید.");
      } else if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        const name = eq === -1 ? a : a.slice(0, eq);
        if (name === FLAG_TIMEOUT) {
          if (seenTimeout) {
            issues.push(`${FLAG_TIMEOUT} تکراری است.`);
          } else {
            seenTimeout = true;
            const raw = eq === -1 ? "" : a.slice(eq + 1);
            const n = DIGITS.test(raw) ? Number(raw) : NaN;
            if (!(n >= MIN_TIMEOUT_MS && n <= MAX_TIMEOUT_MS)) issues.push(`${FLAG_TIMEOUT} باید عددِ صحیحِ لاتین در [${MIN_TIMEOUT_MS}، ${MAX_TIMEOUT_MS}] باشد (شکل: ${FLAG_TIMEOUT}=N).`);
            else timeoutMs = n;
          }
        } else if (name === FLAG_CREATE_SCHEMA) {
          if (eq !== -1) issues.push(`${FLAG_CREATE_SCHEMA} مقدار نمی‌گیرد.`);
          else if (seenCreate) issues.push(`${FLAG_CREATE_SCHEMA} تکراری است.`);
          else {
            seenCreate = true;
            createSchema = true;
          }
        } else {
          issues.push(`فلگِ ناشناختهٔ ${safeFlag(name)}.`);
        }
      } else if (a.startsWith("-")) {
        issues.push("فلگِ ناشناخته (کوتاه).");
      } else if (seenCommand) {
        issues.push("آرگومانِ اضافه (فقط یک دستور).");
      } else {
        seenCommand = true;
        if (a === "status" || a === "up") command = a;
        else issues.push("دستورِ ناشناخته (status یا up).");
      }
    }
    if (!seenCommand) issues.push("دستور لازم است (status یا up).");
    if (createSchema && command === "status") issues.push(`${FLAG_CREATE_SCHEMA} فقط با up معنا دارد (status هرگز نمی‌نویسد).`);

    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      issues.push("env باید یک شیء ساده باشد.");
      return { ok: false, command, issues: Object.freeze(issues) };
    }
    const src = env as Record<string, unknown>;
    const url = src[ENV_DATABASE_URL];
    if (typeof url !== "string" || url === "") issues.push(`${ENV_DATABASE_URL} الزامی است.`);
    for (const k of Object.keys(src)) if (k.startsWith(ENV_PREFIX) && !KNOWN_TOOL_POLICY_ENV.includes(k)) issues.push(`متغیرِ ناشناختهٔ ${safeName(k)} (پیشوندِ ${ENV_PREFIX} رزرو است).`);
    const schemaRaw = src[ENV_SCHEMA];
    let schema: string | null = null;
    if (schemaRaw !== undefined && schemaRaw !== "") {
      if (typeof schemaRaw !== "string") issues.push(`${ENV_SCHEMA} باید رشته باشد.`);
      else schema = schemaRaw;
    }

    if (issues.length > 0 || command === null) return { ok: false, command, issues: Object.freeze(issues) };
    return { ok: true, value: Object.freeze({ command, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, schema, createSchema }) };
  } catch {
    return { ok: false, command, issues: ["خواندنِ آرگومان/env ناموفق بود."] };
  }
}
