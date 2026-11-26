/**
 * tool-policy-host — اعتبارسنجیِ مرزی (ADR-0075). ورودی `unknown`؛ هرگز نمی‌پرتابد؛
 * مشکل‌ها فقط نامِ فیلدند، هرگز مقدار. هر کلید فقط یک بار خوانده می‌شود (getter دو بار پاسخ متفاوت نمی‌دهد).
 * `null` صریح پیش‌فرض نمی‌شود (`=== undefined`، نه `??`).
 */
import type { HostError, HostResult, HostTimer, RuntimePort, SignalSource } from "./types";

export const TOOL_POLICY_HOST_LIMITS = Object.freeze({
  defaultShutdownTimeoutMs: 15_000,
  maxShutdownTimeoutMs: 300_000,
  defaultBootAttempts: 1,
  maxBootAttempts: 10,
  defaultBootDelayMs: 1_000,
  maxBootDelayMs: 60_000,
});

export const HOST_KEYS = ["runtime", "timer", "signals", "exit", "closeResources", "shutdownTimeoutMs", "bootRetry", "observer"] as const;
const RETRY_KEYS = ["maxAttempts", "delayMs"] as const;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isFn = (v: unknown): v is (...args: never[]) => unknown => typeof v === "function";
export const hasFns = (v: unknown, names: readonly string[]): boolean => (typeof v === "object" || typeof v === "function") && v !== null && names.every((n) => typeof (v as Record<string, unknown>)[n] === "function");
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;

export function hostError(code: HostError["code"], issues: readonly string[]): { ok: false; error: HostError } {
  const message = code === "INVALID_CONFIG" ? "پیکربندیِ میزبانِ سیاستِ ابزار نامعتبر است." : code === "INVALID_STORE" ? "ظرفِ میزبانِ سیاستِ ابزار نامعتبر است." : "ساختنِ میزبانِ سیاستِ ابزار ناموفق بود.";
  return { ok: false, error: Object.freeze({ code, message, issues: Object.freeze([...new Set(issues)]) }) };
}

export function snapshot(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const snap: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) snap[k] = raw[k];
  return snap;
}

export function unknownKeyIssues(snap: Record<string, unknown>, allowed: readonly string[], where = ""): string[] {
  const set = new Set<string>(allowed);
  return Object.keys(snap)
    .filter((k) => !set.has(k))
    .map((k) => `کلید ناشناخته${where}: ${JSON.stringify(k.slice(0, 40))}.`);
}

export type HostSettings = Readonly<{
  runtime: RuntimePort;
  timer: HostTimer;
  signals: SignalSource | false;
  exit: ((code: number) => unknown) | null;
  closeResources: (() => unknown) | null;
  observer: ((event: never) => unknown) | null;
  shutdownTimeoutMs: number;
  maxAttempts: number;
  delayMs: number;
}>;

export function parseHostConfig(raw: unknown): HostResult<HostSettings> {
  const snap = snapshot(raw);
  if (snap === null) return hostError("INVALID_CONFIG", ["پیکربندی باید یک شیء ساده باشد."]);
  const issues = unknownKeyIssues(snap, HOST_KEYS);

  const { runtime, timer, signals, exit, closeResources, observer } = snap;
  if (!hasFns(runtime, ["start", "stop", "health"])) issues.push("runtime باید start/stop/health داشته باشد.");
  if (!hasFns(timer, ["after", "cancel"])) issues.push("timer باید after/cancel داشته باشد.");
  if (signals !== false && !hasFns(signals, ["on", "off"])) issues.push("signals الزامی است: false (آگاهانه؛ بی‌شنونده) یا منبعی با on/off.");
  if (exit !== undefined && !isFn(exit)) issues.push("exit باید تابع باشد.");
  if (closeResources !== undefined && !isFn(closeResources)) issues.push("closeResources باید تابع باشد.");
  if (observer !== undefined && !isFn(observer)) issues.push("observer باید تابع باشد.");

  const shutdownTimeoutMs = snap["shutdownTimeoutMs"] === undefined ? TOOL_POLICY_HOST_LIMITS.defaultShutdownTimeoutMs : snap["shutdownTimeoutMs"];
  if (!isIntIn(shutdownTimeoutMs, 1, TOOL_POLICY_HOST_LIMITS.maxShutdownTimeoutMs)) issues.push(`shutdownTimeoutMs باید صحیح ۱ تا ${TOOL_POLICY_HOST_LIMITS.maxShutdownTimeoutMs} باشد.`);

  let maxAttempts: unknown = TOOL_POLICY_HOST_LIMITS.defaultBootAttempts;
  let delayMs: unknown = TOOL_POLICY_HOST_LIMITS.defaultBootDelayMs;
  const retryRaw = snap["bootRetry"];
  if (retryRaw !== undefined) {
    const rs = snapshot(retryRaw);
    if (rs === null) issues.push("bootRetry باید شیء ساده باشد.");
    else {
      issues.push(...unknownKeyIssues(rs, RETRY_KEYS, " (bootRetry)"));
      if (rs["maxAttempts"] !== undefined) maxAttempts = rs["maxAttempts"];
      if (rs["delayMs"] !== undefined) delayMs = rs["delayMs"];
    }
  }
  if (!isIntIn(maxAttempts, 1, TOOL_POLICY_HOST_LIMITS.maxBootAttempts)) issues.push(`bootRetry.maxAttempts باید صحیح ۱ تا ${TOOL_POLICY_HOST_LIMITS.maxBootAttempts} باشد.`);
  if (!isIntIn(delayMs, 1, TOOL_POLICY_HOST_LIMITS.maxBootDelayMs)) issues.push(`bootRetry.delayMs باید صحیح ۱ تا ${TOOL_POLICY_HOST_LIMITS.maxBootDelayMs} باشد.`);

  if (issues.length > 0) return hostError("INVALID_CONFIG", issues);
  return {
    ok: true,
    value: Object.freeze({
      runtime: runtime as RuntimePort,
      timer: timer as HostTimer,
      signals: signals as SignalSource | false,
      exit: (exit as ((code: number) => unknown) | undefined) ?? null,
      closeResources: (closeResources as (() => unknown) | undefined) ?? null,
      observer: (observer as ((event: never) => unknown) | undefined) ?? null,
      shutdownTimeoutMs: shutdownTimeoutMs as number,
      maxAttempts: maxAttempts as number,
      delayMs: delayMs as number,
    }),
  };
}
