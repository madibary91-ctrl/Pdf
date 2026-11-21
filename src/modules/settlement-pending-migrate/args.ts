/**
 * settlement-pending-migrate — سیاستِ آرگومان و محیط (ADR-0047 تصمیم ۲). تابعِ خالص و بی‌پرتاب؛ ورودی `unknown`.
 *  - دستور: `status` | `up` | `verify` (یا تنها `--help`/`-h`). دستورِ دیگر/تکراری، فلگِ ناشناخته/تکراری، آرگومانِ اضافه ⇒ خطا.
 *  - فلگ: فقط `--timeout-ms=N` (یک توکن)، N فقط رقمِ لاتینِ مثبت در [۱۰۰۰، ۶۰۰۰۰۰]. پیش‌فرض ۶۰٬۰۰۰. همین عدد سقفِ زمانِ سمتِ پایگاهِ verify هم هست.
 *  - **شِما فقط از محیط:** `SETTLEMENT_OUTBOX_SCHEMA` (نمایه همیشه در شِمای outbox است؛ نبودن/خالی = پیش‌فرض)، نه از فلگ: تا مهاجرت‌دهنده و برنامه هرگز دو شِمای متفاوت را نبینند.
 *  - `DATABASE_URL` الزامی است؛ مقدارش هرگز خوانده/برگردانده نمی‌شود (فقط حضورش؛ اتصال را گلو می‌سازد).
 *  - غلط‌یابِ نام: هر کلیدِ ناشناختهٔ `SETTLEMENT_*` همیشه خطاست (CLI روی «شِمای پیش‌فرض» می‌نویسد؛ تایپِ `SETTLEMENT_OUTBOX_SCHEMAA` نباید بی‌صدا شِمای اشتباه را مهاجرت دهد).
 *    **برخلافِ settlement-migrate**، متغیرهای پایشِ پسماند (`SETTLEMENT_BACKLOG_WATCH` و آستانه‌هایش) شناخته‌اند: این فرمان دقیقاً برای همان پایش است و باید با
 *    **همان فایلِ envِ برنامه** اجرا شود؛ مقدارشان اینجا نادیده است (صاحبشان bootstrap است). همارزی با bootstrap را آزمونِ tooling قفل می‌کند.
 *  - مشکل‌ها فقط نامِ متغیر یا نامِ فلگِ شبیهِ فلگ‌اند، هرگز مقدار؛ **آرگومانِ موضعی هرگز پژواک نمی‌شود** (ممکن است رشتهٔ اتصالی باشد که اشتباهاً داده شده).
 */
import { SETTLEMENT_BACKLOG_WATCH_ENV } from "@/modules/settlement-backlog-watch";
import type { ArgsResult, PendingCommandName } from "./types";

export const ENV_DATABASE_URL = "DATABASE_URL";
export const ENV_LEDGER_SCHEMA = "SETTLEMENT_LEDGER_SCHEMA";
export const ENV_OUTBOX_SCHEMA = "SETTLEMENT_OUTBOX_SCHEMA";
export const ENV_BACKLOG_WATCH = "SETTLEMENT_BACKLOG_WATCH";
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
  ENV_BACKLOG_WATCH,
  ...Object.values(SETTLEMENT_BACKLOG_WATCH_ENV),
]);

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
const FLAG_TIMEOUT = "--timeout-ms";
const DIGITS = /^[1-9][0-9]{0,9}$/;
const COMMANDS: readonly string[] = ["status", "up", "verify"];

/** نامِ کلیدِ env (نه مقدارش) با نویسه‌های قابل‌چاپ و کوتاه‌شده در پیام می‌آید. */
const safeName = (k: string): string => JSON.stringify(k.replace(/[^\x20-\x7e]/g, "?").slice(0, 48));
/** فقط نامِ فلگِ شبیهِ فلگ (`--abc-d`) پژواک می‌شود؛ هر چیزِ دیگر (مثلاً رشتهٔ اتصالِ اشتباهاً داده‌شده) هرگز. */
const safeFlag = (name: string): string => (/^--[a-z][a-z0-9-]{0,31}$/.test(name) ? JSON.stringify(name) : "?");

export function parsePendingMigrateArgs(argv: unknown, env: unknown): ArgsResult {
  let command: PendingCommandName | null = null;
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
        if (COMMANDS.includes(a)) command = a as PendingCommandName;
        else issues.push("دستورِ ناشناخته (status، up یا verify).");
      }
    }
    if (!seenCommand) issues.push("دستور لازم است (status، up یا verify).");

    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      issues.push("env باید یک شیء ساده باشد.");
      return { ok: false, command, issues: Object.freeze(issues) };
    }
    const src = env as Record<string, unknown>;
    const url = src[ENV_DATABASE_URL];
    if (typeof url !== "string" || url === "") issues.push(`${ENV_DATABASE_URL} الزامی است.`);
    for (const k of Object.keys(src)) if (k.startsWith(ENV_PREFIX) && !KNOWN_SETTLEMENT_ENV.includes(k)) issues.push(`متغیرِ ناشناختهٔ ${safeName(k)} (پیشوندِ ${ENV_PREFIX} رزرو است).`);
    let schema: string | null = null;
    // نوعِ هر دو متغیرِ شِما سنجیده می‌شود (هم‌معنا با bootstrap/settlement-migrate)، هرچند فقط شِمای outbox به کار می‌رود: یک فایلِ env یا برای همه معتبر است یا برای هیچ‌کدام.
    for (const name of [ENV_LEDGER_SCHEMA, ENV_OUTBOX_SCHEMA]) {
      const raw = src[name];
      if (raw === undefined || raw === "") continue;
      if (typeof raw !== "string") issues.push(`${name} باید رشته باشد.`);
      else if (name === ENV_OUTBOX_SCHEMA) schema = raw;
    }

    if (issues.length > 0 || command === null) return { ok: false, command, issues: Object.freeze(issues) };
    return { ok: true, value: Object.freeze({ command, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, schema }) };
  } catch {
    return { ok: false, command, issues: ["خواندنِ آرگومان/env ناموفق بود."] };
  }
}

/** متنِ راهنما (ثابت؛ بی‌مقدار). */
export const USAGE: readonly string[] = Object.freeze([
  "settlement-pending-migrate status [--timeout-ms=N]   وضعیتِ فقط‌خواندنیِ نمایه؛ خروج ۳ اگر نصب نشده/معلق باشد",
  "settlement-pending-migrate up [--timeout-ms=N]       نصبِ اختیاری و idempotent (TRIGGER + backfill زیرِ قفل) و راستی‌آزماییِ پس از آن",
  "settlement-pending-migrate verify [--timeout-ms=N]   راستی‌آزماییِ سنگینِ نمایه در برابر حقیقت؛ خروج ۹ اگر ناهمخوان باشد",
  "محیط: DATABASE_URL (الزامی)، SETTLEMENT_OUTBOX_SCHEMA (اختیاری؛ همان برنامه). پیش‌نیاز: settlement:migrate up",
  "خروج: ۰ ok · ۱ internal · ۲ usage · ۳ pending · ۴ unavailable · ۵ schema-mismatch · ۶ migration-failed · ۷ timeout · ۸ prerequisite · ۹ inconsistent · ۱۰ lock-busy",
]);
