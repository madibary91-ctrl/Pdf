/**
 * tool-policy-grants — سیاستِ آرگومان و محیط (ADR-0081). تابعِ خالص و بی‌پرتاب؛ ورودی `unknown`.
 *  - دستور: `plan` | `verify` | `apply` (یا تنها `--help`/`-h`). دستورِ دیگر/تکراری، فلگِ ناشناخته/تکراری، آرگومانِ اضافه ⇒ خطا.
 *  - فلگ: `--role=NAME` (الزامی؛ فهرست‌سفیدِ `parseRole`) و `--timeout-ms=N` (رقمِ لاتینِ مثبت در [۱۰۰۰، ۶۰۰۰۰۰]، پیش‌فرض ۶۰٬۰۰۰).
 *  - **شِما فقط از محیط** (`TOOL_POLICY_SCHEMA`، همان نام و معنای tool-policy-bootstrap و tool-policy-migrate: نبودن/خالی = پیش‌فرض)، نه از فلگ:
 *    تا مهاجرت‌دهنده، حقوق و برنامه هرگز دو شِمای متفاوت را نبینند (آزمونِ همارزی در tooling). شِمای نامعتبر خطای `USAGE` است.
 *  - `DATABASE_URL` برای `verify`/`apply` الزامی است (مقدارش هرگز خوانده/برگردانده نمی‌شود؛ اتصال را گلو می‌سازد)؛ `plan` به پایگاه نیاز ندارد.
 *  - غلط‌یابِ نام: هر کلیدِ ناشناختهٔ `TOOL_POLICY_*` خطاست (تایپِ `TOOL_POLICY_SCHEMAA` نباید بی‌صدا روی شِمای پیش‌فرض GRANT بزند).
 *  - مشکل‌ها فقط نامِ متغیر یا نامِ فلگِ شبیهِ فلگ‌اند، هرگز مقدار؛ **آرگومانِ موضعی و مقدارِ `--role` هرگز پژواک نمی‌شود**.
 */
import { parseRole, parseSchema } from "./contract";
import type { ArgsResult, GrantsCommandName } from "./types";

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
const FLAG_ROLE = "--role";
const DIGITS = /^[1-9][0-9]{0,9}$/;
const COMMANDS: readonly string[] = ["plan", "verify", "apply"];

export const USAGE: readonly string[] = Object.freeze([
  "tool-policy-grants plan --role=NAME",
  "tool-policy-grants verify --role=NAME [--timeout-ms=N]",
  "tool-policy-grants apply --role=NAME [--timeout-ms=N]",
  "tool-policy-grants --help",
  `env: ${ENV_DATABASE_URL} (برای verify/apply الزامی؛ نقشِ مدیر/مهاجرت)، ${ENV_SCHEMA} (اختیاری؛ پیش‌فرض tool_policy)`,
  "NAME: نقشِ زمانِ اجرا؛ حروفِ کوچکِ لاتین، رقم و _ (با حرف شروع، حداکثر ۶۳ نویسه)",
]);

const safeName = (k: string): string => JSON.stringify(k.replace(/[^\x20-\x7e]/g, "?").slice(0, 48));
const safeFlag = (name: string): string => (/^--[a-z][a-z0-9-]{0,31}$/.test(name) ? JSON.stringify(name) : "?");

export function parseGrantsArgs(argv: unknown, env: unknown): ArgsResult {
  let command: GrantsCommandName | null = null;
  try {
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) return { ok: false, command, issues: ["argv باید آرایه‌ای از رشته باشد."] };
    const args = argv as readonly string[];
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { ok: true, value: Object.freeze({ command: "help" as const }) };

    const issues: string[] = [];
    let timeoutMs: number | null = null;
    let role: string | null = null;
    let seenCommand = false;
    let seenTimeout = false;
    let seenRole = false;
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
        } else if (name === FLAG_ROLE) {
          if (seenRole) {
            issues.push(`${FLAG_ROLE} تکراری است.`);
          } else {
            seenRole = true;
            const parsed = eq === -1 ? { ok: false as const } : parseRole(a.slice(eq + 1));
            if (!parsed.ok) issues.push(`${FLAG_ROLE} نامعتبر است (شکل: ${FLAG_ROLE}=NAME؛ حروفِ کوچکِ لاتین، رقم و _، نه postgres/public/pg_*).`);
            else role = parsed.value;
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
        if (COMMANDS.includes(a)) command = a as GrantsCommandName;
        else issues.push("دستورِ ناشناخته (plan، verify یا apply).");
      }
    }
    if (!seenCommand) issues.push("دستور لازم است (plan، verify یا apply).");
    if (!seenRole) issues.push(`${FLAG_ROLE} الزامی است.`);
    if (command === "plan" && seenTimeout) issues.push(`${FLAG_TIMEOUT} با plan معنا ندارد (plan به پایگاه وصل نمی‌شود).`);

    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      issues.push("env باید یک شیء ساده باشد.");
      return { ok: false, command, issues: Object.freeze(issues) };
    }
    const src = env as Record<string, unknown>;
    if (command !== "plan") {
      const url = src[ENV_DATABASE_URL];
      if (typeof url !== "string" || url === "") issues.push(`${ENV_DATABASE_URL} الزامی است.`);
    }
    for (const k of Object.keys(src)) if (k.startsWith(ENV_PREFIX) && !KNOWN_TOOL_POLICY_ENV.includes(k)) issues.push(`متغیرِ ناشناختهٔ ${safeName(k)} (پیشوندِ ${ENV_PREFIX} رزرو است).`);
    const schemaRaw = src[ENV_SCHEMA];
    let schema: string | null = null;
    if (schemaRaw !== undefined && schemaRaw !== "") {
      if (typeof schemaRaw !== "string") {
        issues.push(`${ENV_SCHEMA} باید رشته باشد.`);
      } else {
        const p = parseSchema(schemaRaw);
        if (!p.ok) issues.push(`${ENV_SCHEMA} نامعتبر است.`);
        else schema = p.value;
      }
    }

    if (issues.length > 0 || command === null || role === null) return { ok: false, command, issues: Object.freeze(issues) };
    return { ok: true, value: Object.freeze({ command, role, schema, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS }) };
  } catch {
    return { ok: false, command, issues: ["خواندنِ آرگومان/env ناموفق بود."] };
  }
}
