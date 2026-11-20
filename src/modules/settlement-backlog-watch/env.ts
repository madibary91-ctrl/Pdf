/**
 * settlement-backlog-watch — خواندنِ آستانه‌ها از متغیرهای محیط (تابعِ خالص؛ `env` آرگومان است و این ماژول هرگز به محیطِ فرایند دست نمی‌زند).
 * قاعده‌ها (هم‌راستا با `settlement-bootstrap`): نبودن یا رشتهٔ خالی ⇒ «تنظیم‌نشده» (پیش‌فرضِ امن)؛ اعداد فقط رقمِ لاتینِ مثبت؛
 * هر کلیدِ ناشناختهٔ `SETTLEMENT_BACKLOG_*` خطاست (غلط‌یابِ نام)؛ مقدارِ هیچ متغیری هرگز در پیام نمی‌آید (فقط نامِ متغیر).
 * محدوده و ترتیبِ مقدارها را `createBacklogWatch` می‌سنجد، نه اینجا.
 */
import type { BacklogEnvOverrides, BacklogEnvResult, BacklogReadyPolicy } from "./types";

export const SETTLEMENT_BACKLOG_WATCH_ENV = Object.freeze({
  intervalMs: "SETTLEMENT_BACKLOG_INTERVAL_MS",
  timeoutMs: "SETTLEMENT_BACKLOG_TIMEOUT_MS",
  degradedCount: "SETTLEMENT_BACKLOG_DEGRADED_COUNT",
  downCount: "SETTLEMENT_BACKLOG_DOWN_COUNT",
  degradedAfterMs: "SETTLEMENT_BACKLOG_DEGRADED_AFTER_MS",
  downAfterMs: "SETTLEMENT_BACKLOG_DOWN_AFTER_MS",
  sampleMaxAgeMs: "SETTLEMENT_BACKLOG_SAMPLE_MAX_AGE_MS",
  sampleLimit: "SETTLEMENT_BACKLOG_SAMPLE_LIMIT",
  readyPolicy: "SETTLEMENT_BACKLOG_READY_POLICY",
} as const);

type NumericKey = Exclude<keyof typeof SETTLEMENT_BACKLOG_WATCH_ENV, "readyPolicy">;
const NUMERIC: readonly NumericKey[] = ["intervalMs", "timeoutMs", "degradedCount", "downCount", "degradedAfterMs", "downAfterMs", "sampleMaxAgeMs", "sampleLimit"];
const NAMES: readonly string[] = Object.values(SETTLEMENT_BACKLOG_WATCH_ENV);
const PREFIX = "SETTLEMENT_BACKLOG_";

const fail = (issues: readonly string[]): BacklogEnvResult => ({
  ok: false,
  error: Object.freeze({ code: "INVALID_ENV" as const, message: "متغیرهای محیطیِ پایشِ پسماندِ زنگ نامعتبرند.", issues: Object.freeze([...issues]) }),
});

export function parseBacklogWatchEnv(env: unknown): BacklogEnvResult {
  try {
    if (typeof env !== "object" || env === null || Array.isArray(env)) return fail(["env باید یک شیء ساده باشد."]);
    const rec = env as Record<string, unknown>;
    const issues: string[] = [];
    for (const k of Object.keys(rec)) if (k.startsWith(PREFIX) && !NAMES.includes(k)) issues.push(`متغیر ناشناخته: ${JSON.stringify(k.slice(0, 60))}.`);
    const out: Record<string, number | BacklogReadyPolicy> = {};
    for (const key of NUMERIC) {
      const name = SETTLEMENT_BACKLOG_WATCH_ENV[key];
      const v = rec[name];
      if (v === undefined || v === "") continue;
      if (typeof v !== "string" || !/^[1-9][0-9]{0,15}$/.test(v) || !Number.isSafeInteger(Number(v))) {
        issues.push(`${name} باید عددِ صحیحِ مثبت (رقمِ لاتینی) باشد.`);
        continue;
      }
      out[key] = Number(v);
    }
    const pName = SETTLEMENT_BACKLOG_WATCH_ENV.readyPolicy;
    const p = rec[pName];
    if (p !== undefined && p !== "") {
      if (p === "report" || p === "gate_down") out["readyPolicy"] = p;
      else issues.push(`${pName} باید report یا gate_down باشد.`);
    }
    if (issues.length > 0) return fail(issues);
    return { ok: true, value: Object.freeze(out) as BacklogEnvOverrides };
  } catch {
    return fail(["env قابل‌خواندن نیست."]);
  }
}
