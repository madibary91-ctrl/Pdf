/**
 * settlement-bootstrap — سیاستِ محیط (ADR-0033 تصمیم ۲). تابعِ خالص و بی‌پرتاب؛ ورودی `unknown`.
 *  - **شکست‌بسته:** `SETTLEMENT_HOST` فقط `on` یا `off` (یا نبودن/خالی = off)؛ هر مقدارِ دیگر (حتی `ON`، `true`، `1`، فاصله) رد می‌شود،
 *    نه این‌که بی‌صدا «روشن» یا «خاموش» حدس زده شود. پولی که بی‌صدا رفتگر ندارد یا بی‌اجازه رفتگر دارد هر دو بد است.
 *  - **غلط‌یابِ نام:** وقتی `on` است هر کلیدِ ناشناختهٔ `SETTLEMENT_*` خطاست (تایپِ `SETTLEMENT_GRAC_MS` نباید پیش‌فرضِ خطرناک بگذارد).
 *    وقتی `off` است محیط نادیده می‌ماند.
 *  - **اعداد:** فقط رقمِ لاتین و مثبت، بی‌صفرِ آغازین/علامت/نماد/فاصله؛ بازهٔ مجاز را مصرف‌کنندهٔ پایین‌دست (settlement-host/runtime) می‌سنجد.
 *  - مشکل‌ها فقط نامِ متغیرند، هرگز مقدار.
 */
import type { EnvResult } from "./types";

export const ENV_PREFIX = "SETTLEMENT_";
export const ENV_HOST = "SETTLEMENT_HOST";
export const ENV_GRACE_MS = "SETTLEMENT_GRACE_MS";
export const ENV_SHUTDOWN_TIMEOUT_MS = "SETTLEMENT_SHUTDOWN_TIMEOUT_MS";
export const ENV_BOOT_ATTEMPTS = "SETTLEMENT_BOOT_ATTEMPTS";
export const ENV_BOOT_RETRY_DELAY_MS = "SETTLEMENT_BOOT_RETRY_DELAY_MS";
export const ENV_LEDGER_SCHEMA = "SETTLEMENT_LEDGER_SCHEMA";
export const ENV_OUTBOX_SCHEMA = "SETTLEMENT_OUTBOX_SCHEMA";

const KNOWN: readonly string[] = [ENV_HOST, ENV_GRACE_MS, ENV_SHUTDOWN_TIMEOUT_MS, ENV_BOOT_ATTEMPTS, ENV_BOOT_RETRY_DELAY_MS, ENV_LEDGER_SCHEMA, ENV_OUTBOX_SCHEMA];

const DIGITS = /^[1-9][0-9]{0,9}$/;

/** نامِ کلیدِ ناشناخته (نه مقدارش) با نویسه‌های قابل‌چاپ و کوتاه شده در پیام می‌آید. */
const safeName = (k: string): string => JSON.stringify(k.replace(/[^\x20-\x7e]/g, "?").slice(0, 48));

export function parseBootstrapEnv(raw: unknown): EnvResult {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, issues: ["env باید یک شیء ساده باشد."] };
    const src = raw as Record<string, unknown>;
    const read = (name: string): unknown => src[name];

    const host = read(ENV_HOST);
    if (host === undefined || host === "" || host === "off") return { ok: true, value: Object.freeze({ enabled: false as const }) };
    if (host !== "on") return { ok: false, issues: [`${ENV_HOST} باید on یا off باشد.`] };

    const issues: string[] = [];
    for (const k of Object.keys(src)) if (k.startsWith(ENV_PREFIX) && !KNOWN.includes(k)) issues.push(`متغیرِ ناشناختهٔ ${safeName(k)} (پیشوندِ ${ENV_PREFIX} رزرو است).`);

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
    const strVar = (name: string): string | null => {
      const v = read(name);
      if (v === undefined || v === "") return null;
      if (typeof v !== "string") {
        issues.push(`${name} باید رشته باشد.`);
        return null;
      }
      return v;
    };

    const graceMs = intVar(ENV_GRACE_MS, true);
    const shutdownTimeoutMs = intVar(ENV_SHUTDOWN_TIMEOUT_MS, false);
    const bootAttempts = intVar(ENV_BOOT_ATTEMPTS, false);
    const bootRetryDelayMs = intVar(ENV_BOOT_RETRY_DELAY_MS, false);
    const ledgerSchema = strVar(ENV_LEDGER_SCHEMA);
    const settlementSchema = strVar(ENV_OUTBOX_SCHEMA);
    if (issues.length > 0 || graceMs === null) return { ok: false, issues: Object.freeze([...issues]) };
    return { ok: true, value: Object.freeze({ enabled: true as const, graceMs, shutdownTimeoutMs, bootAttempts, bootRetryDelayMs, ledgerSchema, settlementSchema }) };
  } catch {
    return { ok: false, issues: ["خواندنِ env ناموفق بود."] };
  }
}
