/**
 * settlement-migrate — سیاستِ آرگومان و محیط (ADR-0034 تصمیم ۲). تابعِ خالص و بی‌پرتاب؛ ورودی `unknown`.
 *  - دستور: `status` | `up` (یا تنها `--help`/`-h`). دستورِ دیگر، دستورِ تکراری، فلگِ ناشناخته/تکراری، آرگومانِ اضافه ⇒ خطا.
 *  - فلگ: فقط `--timeout-ms=N` (یک توکن؛ شکلِ دو‌توکنی ابهام می‌سازد)، N فقط رقمِ لاتینِ مثبت در [۱۰۰۰، ۶۰۰۰۰۰]. پیش‌فرض ۶۰٬۰۰۰.
 *  - **شِماها فقط از محیط** (`SETTLEMENT_LEDGER_SCHEMA`/`SETTLEMENT_OUTBOX_SCHEMA`، همان نام‌ها و همان معنای settlement-bootstrap: نبودن/خالی = پیش‌فرض)،
 *    نه از فلگ: تا مهاجرت‌دهنده و برنامه هرگز دو شِمای متفاوت را نبینند (آزمونِ همارزی با parseBootstrapEnv در tooling).
 *  - `DATABASE_URL` الزامی است؛ مقدارش هرگز خوانده/برگردانده نمی‌شود (فقط حضورش سنجیده می‌شود؛ اتصال را گلو می‌سازد).
 *  - غلط‌یابِ نام: هر کلیدِ ناشناختهٔ `SETTLEMENT_*` همیشه خطاست (برخلافِ bootstrap که با `off` نادیده می‌گرفت): CLI روی «شِمای پیش‌فرض» می‌نویسد،
 *    پس تایپِ `SETTLEMENT_OUTBOX_SCHEMAA` نباید بی‌صدا شِمای اشتباه را مهاجرت دهد. مقدارِ دیگرِ متغیرهای شناخته‌شده (مثلاً `SETTLEMENT_GRACE_MS`) اینجا نادیده است؛ صاحبش bootstrap است.
 *  - مشکل‌ها فقط نامِ متغیر یا نامِ فلگِ شبیهِ فلگ‌اند، هرگز مقدار؛ **آرگومانِ موضعی هرگز پژواک نمی‌شود** (ممکن است رشتهٔ اتصالی باشد که اشتباهاً داده شده).
 */
import type { ArgsResult } from "./types";

export const ENV_DATABASE_URL = "DATABASE_URL";
export const ENV_LEDGER_SCHEMA = "SETTLEMENT_LEDGER_SCHEMA";
export const ENV_OUTBOX_SCHEMA = "SETTLEMENT_OUTBOX_SCHEMA";
const ENV_PREFIX = "SETTLEMENT_";

/** نام‌های `SETTLEMENT_*`ی که CLI می‌پذیرد: دقیقاً مجموعهٔ settlement-bootstrap (آزمونِ همارزی در tooling قفلش می‌کند). */
export const KNOWN_SETTLEMENT_ENV: readonly string[] = Object.freeze([
  "SETTLEMENT_HOST",
  "SETTLEMENT_GRACE_MS",
  "SETTLEMENT_SHUTDOWN_TIMEOUT_MS",
  "SETTLEMENT_BOOT_ATTEMPTS",
  "SETTLEMENT_BOOT_RETRY_DELAY_MS",
  ENV_LEDGER_SCHEMA,
  ENV_OUTBOX_SCHEMA,
]);

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
const FLAG_TIMEOUT = "--timeout-ms";
const DIGITS = /^[1-9][0-9]{0,9}$/;

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
    let seenCommand = false;
    let seenTimeout = false;
    for (const a of args) {
      if (a === "--help" || a === "-h") {
        issues.push("--help باید تنها بیاید.");
      } else if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        const name = eq === -1 ? a : a.slice(0, eq);
        if (name !== FLAG_TIMEOUT) {
          issues.push(`فلگِ ناشناختهٔ ${safeFlag(name)}.`);
        } else if (seenTimeout) {
          issues.push(`${FLAG_TIMEOUT} تکراری است.`);
        } else {
          seenTimeout = true;
          const raw = eq === -1 ? "" : a.slice(eq + 1);
          const n = DIGITS.test(raw) ? Number(raw) : NaN;
          if (!(n >= MIN_TIMEOUT_MS && n <= MAX_TIMEOUT_MS)) issues.push(`${FLAG_TIMEOUT} باید عددِ صحیحِ لاتین در [${MIN_TIMEOUT_MS}، ${MAX_TIMEOUT_MS}] باشد (شکل: ${FLAG_TIMEOUT}=N).`);
          else timeoutMs = n;
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

    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      issues.push("env باید یک شیء ساده باشد.");
      return { ok: false, command, issues: Object.freeze(issues) };
    }
    const src = env as Record<string, unknown>;
    const url = src[ENV_DATABASE_URL];
    if (typeof url !== "string" || url === "") issues.push(`${ENV_DATABASE_URL} الزامی است.`);
    for (const k of Object.keys(src)) if (k.startsWith(ENV_PREFIX) && !KNOWN_SETTLEMENT_ENV.includes(k)) issues.push(`متغیرِ ناشناختهٔ ${safeName(k)} (پیشوندِ ${ENV_PREFIX} رزرو است).`);
    const schemaVar = (name: string): string | null => {
      const v = src[name];
      if (v === undefined || v === "") return null;
      if (typeof v !== "string") {
        issues.push(`${name} باید رشته باشد.`);
        return null;
      }
      return v;
    };
    const ledgerSchema = schemaVar(ENV_LEDGER_SCHEMA);
    const settlementSchema = schemaVar(ENV_OUTBOX_SCHEMA);

    if (issues.length > 0 || command === null) return { ok: false, command, issues: Object.freeze(issues) };
    return { ok: true, value: Object.freeze({ command, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, ledgerSchema, settlementSchema }) };
  } catch {
    return { ok: false, command, issues: ["خواندنِ آرگومان/env ناموفق بود."] };
  }
}

/** متنِ راهنما (ثابت؛ بی‌مقدار). */
export const USAGE: readonly string[] = Object.freeze([
  "settlement-migrate status [--timeout-ms=N]   وضعیتِ فقط‌خواندنیِ مهاجرت‌ها؛ خروج ۳ اگر معلق باشد",
  "settlement-migrate up [--timeout-ms=N]       مهاجرتِ صریح و idempotent (دفتر ← outbox)",
  "محیط: DATABASE_URL (الزامی)، SETTLEMENT_LEDGER_SCHEMA و SETTLEMENT_OUTBOX_SCHEMA (اختیاری؛ همان‌های برنامه)",
  "خروج: ۰ ok · ۱ internal · ۲ usage · ۳ pending · ۴ unavailable · ۵ schema-mismatch · ۶ migration-failed · ۷ timeout",
]);
