/**
 * tool-policy-bootstrap — سیاستِ محیط (ADR-0076 تصمیم ۲). تابعِ خالص و بی‌پرتاب؛ ورودی `unknown`.
 *  - **شکست‌بسته:** `TOOL_POLICY_HOST` فقط `on` یا `off` (یا نبودن/خالی = off)؛ هر مقدارِ دیگر (`ON`، `true`، `1`) رد می‌شود،
 *    نه این‌که بی‌صدا «روشن» یا «خاموش» حدس زده شود.
 *  - **غلط‌یابِ نام:** وقتی `on` است هر کلیدِ ناشناختهٔ `TOOL_POLICY_*` خطاست؛ وقتی `off` است محیط نادیده می‌ماند.
 *  - **بی‌پیش‌فرضِ حدسی:** پنج عددِ tuning (`INTERVAL_MS`، `RETRY_MS`، `ATTEMPT_DEADLINE_MS`، `REFRESH_TIMEOUT_MS`، `MAX_STALE_MS`) الزامی‌اند؛
 *    «سیاست تا چند ثانیه کهنه ماند هنوز معتبر است» تصمیمِ مالکِ محصول است. بازه و رابطه‌ها را `createPgToolPolicyRuntime` می‌سنجد (منبعِ حقیقتِ یگانه).
 *  - **اعداد:** فقط رقمِ لاتین و مثبت، بی‌صفرِ آغازین/علامت/نماد/فاصله.
 *  - **هر کلید فقط یک بار خوانده می‌شود** (getterِ خصمانه دو پاسخ نمی‌دهد). مشکل‌ها فقط نامِ متغیرند، هرگز مقدار.
 */
import type { EnvResult } from "./types";

export const ENV_PREFIX = "TOOL_POLICY_";
export const ENV_HOST = "TOOL_POLICY_HOST";
export const ENV_INTERVAL_MS = "TOOL_POLICY_INTERVAL_MS";
export const ENV_RETRY_MS = "TOOL_POLICY_RETRY_MS";
export const ENV_ATTEMPT_DEADLINE_MS = "TOOL_POLICY_ATTEMPT_DEADLINE_MS";
export const ENV_REFRESH_TIMEOUT_MS = "TOOL_POLICY_REFRESH_TIMEOUT_MS";
export const ENV_MAX_STALE_MS = "TOOL_POLICY_MAX_STALE_MS";
export const ENV_SCHEMA = "TOOL_POLICY_SCHEMA";
export const ENV_STATEMENT_TIMEOUT_MS = "TOOL_POLICY_STATEMENT_TIMEOUT_MS";
export const ENV_SHUTDOWN_TIMEOUT_MS = "TOOL_POLICY_SHUTDOWN_TIMEOUT_MS";
export const ENV_BOOT_ATTEMPTS = "TOOL_POLICY_BOOT_ATTEMPTS";
export const ENV_BOOT_RETRY_DELAY_MS = "TOOL_POLICY_BOOT_RETRY_DELAY_MS";

const KNOWN: readonly string[] = [
  ENV_HOST,
  ENV_INTERVAL_MS,
  ENV_RETRY_MS,
  ENV_ATTEMPT_DEADLINE_MS,
  ENV_REFRESH_TIMEOUT_MS,
  ENV_MAX_STALE_MS,
  ENV_SCHEMA,
  ENV_STATEMENT_TIMEOUT_MS,
  ENV_SHUTDOWN_TIMEOUT_MS,
  ENV_BOOT_ATTEMPTS,
  ENV_BOOT_RETRY_DELAY_MS,
];

const DIGITS = /^[1-9][0-9]{0,9}$/;

/** نامِ کلیدِ ناشناخته (نه مقدارش) با نویسه‌های قابل‌چاپ و کوتاه‌شده در پیام می‌آید. */
const safeName = (k: string): string => JSON.stringify(k.replace(/[^\x20-\x7e]/g, "?").slice(0, 48));

export function parseBootstrapEnv(raw: unknown): EnvResult {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, issues: ["env باید یک شیء ساده باشد."] };
    const src = raw as Record<string, unknown>;
    // عکسِ یک‌باره: هر کلید دقیقاً یک بار خوانده می‌شود.
    const snap = new Map<string, unknown>();
    for (const k of Object.keys(src)) if (k.startsWith(ENV_PREFIX)) snap.set(k, src[k]);
    const read = (name: string): unknown => snap.get(name);

    const host = read(ENV_HOST);
    if (host === undefined || host === "" || host === "off") return { ok: true, value: Object.freeze({ enabled: false as const }) };
    if (host !== "on") return { ok: false, issues: [`${ENV_HOST} باید on یا off باشد.`] };

    const issues: string[] = [];
    for (const k of snap.keys()) if (!KNOWN.includes(k)) issues.push(`متغیرِ ناشناختهٔ ${safeName(k)} (پیشوندِ ${ENV_PREFIX} رزرو است).`);

    const intVar = (name: string, required: boolean): number | null => {
      const v = read(name);
      if (v === undefined || v === "") {
        if (required) issues.push(`${name} الزامی است.`);
        return null;
      }
      if (typeof v !== "string" || !DIGITS.test(v)) {
        issues.push(`${name} باید عددِ صحیحِ مثبتِ لاتین باشد.`);
        return null;
      }
      return Number(v);
    };
    const schemaRaw = read(ENV_SCHEMA);
    let schema: string | null = null;
    if (schemaRaw !== undefined && schemaRaw !== "") {
      if (typeof schemaRaw !== "string") issues.push(`${ENV_SCHEMA} باید رشته باشد.`);
      else schema = schemaRaw;
    }

    const intervalMs = intVar(ENV_INTERVAL_MS, true);
    const retryMs = intVar(ENV_RETRY_MS, true);
    const attemptDeadlineMs = intVar(ENV_ATTEMPT_DEADLINE_MS, true);
    const refreshTimeoutMs = intVar(ENV_REFRESH_TIMEOUT_MS, true);
    const maxStaleMs = intVar(ENV_MAX_STALE_MS, true);
    const statementTimeoutMs = intVar(ENV_STATEMENT_TIMEOUT_MS, false);
    const shutdownTimeoutMs = intVar(ENV_SHUTDOWN_TIMEOUT_MS, false);
    const bootAttempts = intVar(ENV_BOOT_ATTEMPTS, false);
    const bootRetryDelayMs = intVar(ENV_BOOT_RETRY_DELAY_MS, false);

    if (issues.length > 0 || intervalMs === null || retryMs === null || attemptDeadlineMs === null || refreshTimeoutMs === null || maxStaleMs === null) {
      return { ok: false, issues: Object.freeze([...issues]) };
    }
    const tuning = Object.freeze({ intervalMs, retryMs, attemptDeadlineMs, refreshTimeoutMs, maxStaleMs });
    return { ok: true, value: Object.freeze({ enabled: true as const, tuning, schema, statementTimeoutMs, shutdownTimeoutMs, bootAttempts, bootRetryDelayMs }) };
  } catch {
    return { ok: false, issues: ["خواندنِ env ناموفق بود."] };
  }
}
