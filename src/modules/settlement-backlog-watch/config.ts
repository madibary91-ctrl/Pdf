/**
 * settlement-backlog-watch — پیش‌فرض‌های امن و اعتبارسنجیِ پیکربندی روی مرز (ورودی `unknown`؛ بی‌پرتاب؛ مشکل‌ها فقط نامِ فیلدند، هرگز مقدار).
 * هر کلید دقیقاً یک بار خوانده می‌شود. اعتبارسنجیِ آستانه‌ها (ترتیب، سقف) به `createDeadLetterBacklogMonitor` سپرده می‌شود تا قاعده‌ها دوگانه نشوند.
 */
import type { LoopTimer } from "@/modules/settlement";
import { SETTLEMENT_BACKLOG_LIMITS, createDeadLetterBacklogMonitor } from "@/modules/settlement-backlog";
import type { BacklogClock, BacklogMonitor, BacklogOutbox } from "@/modules/settlement-backlog";
import type { BacklogReadyPolicy, BacklogWatchConfigError, WatchResult } from "./types";

/**
 * پیش‌فرض‌های امنِ انتخاب‌شده (مالک انتخاب را به من سپرد؛ همه قابل‌تنظیم‌اند):
 * - **`degradedCount = 1`**: هر مردهٔ تأییدنشده یعنی پولی گیر کرده و کسی خبردار نشده؛ باید دیده شود (فقط گزارش است، ۵۰۳ نمی‌سازد).
 * - **`downCount = 10`**: ده مورد دیگر «حادثه» است نه استثنا.
 * - **`degradedAfterMs = ۱ ساعت`**, **`downAfterMs = ۲۴ ساعت`**: یک مورد باید ظرف یک ساعت رسیدگی شود؛ یک روز بی‌رسیدگی ناپذیرفتنی است.
 * - **`intervalMs = ۳۰ ثانیه`**: خواندنِ سبک (حداکثر ۱۰۰۰ ردیف) و جدا از مسیرِ درخواست؛ **`timeoutMs = ۵ ثانیه`**.
 * - **`readyPolicy = "report"`**: پیش‌فرض فقط گزارش؛ مسدودکردنِ `ready` اختیاریِ صریح است.
 */
export const SETTLEMENT_BACKLOG_WATCH_DEFAULTS = Object.freeze({
  intervalMs: 30_000,
  timeoutMs: 5_000,
  degradedCount: 1,
  downCount: 10,
  degradedAfterMs: 3_600_000,
  downAfterMs: 86_400_000,
  sampleLimit: SETTLEMENT_BACKLOG_LIMITS.defaultSampleLimit,
  readyPolicy: "report" as BacklogReadyPolicy,
});

export const SETTLEMENT_BACKLOG_WATCH_LIMITS = Object.freeze({
  minIntervalMs: 1,
  maxIntervalMs: 3_600_000,
  maxTimeoutMs: SETTLEMENT_BACKLOG_LIMITS.maxTimeoutMs,
  readyPolicies: Object.freeze(["report", "gate_down"] as const),
});

export type WatchSettings = Readonly<{
  monitor: BacklogMonitor;
  clock: BacklogClock;
  timer: LoopTimer;
  intervalMs: number;
  sampleMaxAgeMs: number;
  readyPolicy: BacklogReadyPolicy;
}>;

export const WATCH_KEYS: readonly string[] = [
  "outbox",
  "clock",
  "timer",
  "intervalMs",
  "timeoutMs",
  "degradedCount",
  "downCount",
  "degradedAfterMs",
  "downAfterMs",
  "sampleMaxAgeMs",
  "sampleLimit",
  "readyPolicy",
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;
const hasFns = (v: unknown, names: readonly string[]): boolean => (typeof v === "object" || typeof v === "function") && v !== null && names.every((n) => typeof (v as Record<string, unknown>)[n] === "function");

export function configError(issues: readonly string[]): { ok: false; error: BacklogWatchConfigError } {
  return { ok: false, error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندیِ پایشِ زندهٔ پسماندِ زنگ نامعتبر است.", issues: Object.freeze([...issues]) }) };
}

export function resolveWatchSettings(raw: unknown): WatchResult<WatchSettings> {
  const issues: string[] = [];
  try {
    if (!isRecord(raw)) return configError(["پیکربندی باید یک شیء ساده باشد."]);
    for (const k of Object.keys(raw)) if (!WATCH_KEYS.includes(k)) issues.push(`کلید ناشناخته: ${JSON.stringify(k.slice(0, 40))}.`);
    const outbox = raw["outbox"];
    const clock = raw["clock"];
    const timer = raw["timer"];
    const D = SETTLEMENT_BACKLOG_WATCH_DEFAULTS;
    const L = SETTLEMENT_BACKLOG_WATCH_LIMITS;
    const pick = (key: string, dflt: number): unknown => (raw[key] === undefined ? dflt : raw[key]);
    const intervalMs = pick("intervalMs", D.intervalMs);
    const timeoutMs = pick("timeoutMs", D.timeoutMs);
    const degradedCount = pick("degradedCount", D.degradedCount);
    const downCount = pick("downCount", D.downCount);
    const degradedAfterMs = pick("degradedAfterMs", D.degradedAfterMs);
    const downAfterMs = pick("downAfterMs", D.downAfterMs);
    const sampleLimit = pick("sampleLimit", D.sampleLimit);
    const sampleMaxAgeRaw = raw["sampleMaxAgeMs"];
    const policyRaw = raw["readyPolicy"] === undefined ? D.readyPolicy : raw["readyPolicy"];

    if (!hasFns(outbox, ["listUnacknowledgedDead"])) issues.push("outbox باید listUnacknowledgedDead داشته باشد.");
    if (!hasFns(clock, ["nowMs"])) issues.push("clock الزامی است و باید nowMs داشته باشد.");
    if (!hasFns(timer, ["after", "cancel"])) issues.push("timer الزامی است و باید after و cancel داشته باشد.");
    const intervalOk = isIntIn(intervalMs, L.minIntervalMs, L.maxIntervalMs);
    if (!intervalOk) issues.push(`intervalMs باید صحیح ${L.minIntervalMs} تا ${L.maxIntervalMs} باشد.`);
    const timeoutOk = isIntIn(timeoutMs, 1, L.maxTimeoutMs);
    if (!timeoutOk) issues.push(`timeoutMs باید صحیح ۱ تا ${L.maxTimeoutMs} باشد.`);
    if (typeof policyRaw !== "string" || !(L.readyPolicies as readonly string[]).includes(policyRaw)) issues.push("readyPolicy باید report یا gate_down باشد.");

    // کهنگیِ مجاز: بدترین فاصلهٔ سالمِ دو نمونه = intervalMs + ۲×timeoutMs (زمانِ نمونه = آغازِ خواندن). کمتر از آن ⇒ پایشِ سالم هم کهنه گزارش می‌شود.
    let sampleMaxAgeMs = 0;
    if (intervalOk && timeoutOk) {
      const floor = intervalMs + 2 * timeoutMs;
      sampleMaxAgeMs = sampleMaxAgeRaw === undefined ? 2 * intervalMs + 4 * timeoutMs : (sampleMaxAgeRaw as number);
      if (!isIntIn(sampleMaxAgeMs, 1, SETTLEMENT_BACKLOG_LIMITS.maxAgeMs)) issues.push(`sampleMaxAgeMs باید صحیح ۱ تا ${SETTLEMENT_BACKLOG_LIMITS.maxAgeMs} باشد.`);
      else if (sampleMaxAgeMs < floor) issues.push("sampleMaxAgeMs باید دست‌کم intervalMs + ۲×timeoutMs باشد (وگرنه پایشِ سالم هم کهنه گزارش می‌شود).");
    } else if (sampleMaxAgeRaw !== undefined && !isIntIn(sampleMaxAgeRaw, 1, SETTLEMENT_BACKLOG_LIMITS.maxAgeMs)) {
      issues.push(`sampleMaxAgeMs باید صحیح ۱ تا ${SETTLEMENT_BACKLOG_LIMITS.maxAgeMs} باشد.`);
    }
    if (issues.length > 0) return configError(issues);

    const made = createDeadLetterBacklogMonitor({
      outbox: outbox as BacklogOutbox,
      clock: clock as BacklogClock,
      timer,
      timeoutMs,
      degradedCount,
      downCount,
      degradedAfterMs,
      downAfterMs,
      sampleMaxAgeMs,
      sampleLimit,
    });
    // پیام‌های مانیتور فقط نامِ فیلدند (قرارداد ADR-0039)؛ همان‌ها بی‌تغییر عبور می‌کنند.
    if (!made.ok) return configError(made.error.issues);
    return {
      ok: true,
      value: Object.freeze({
        monitor: made.value,
        clock: clock as BacklogClock,
        timer: timer as LoopTimer,
        intervalMs: intervalMs as number,
        sampleMaxAgeMs,
        readyPolicy: policyRaw as BacklogReadyPolicy,
      }),
    };
  } catch {
    return configError(["پیکربندی قابل‌خواندن نیست."]);
  }
}
