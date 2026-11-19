/**
 * settlement-runtime — اعتبارسنجیِ مرزی و ساختنِ سه قطعهٔ `settlement` (رفتگر، حلقه، ارزیاب) از یک پیکربندیِ واحد (ADR-0031).
 * ورودی `unknown`؛ هرگز نمی‌پرتابد؛ مشکل‌ها فقط نامِ فیلدند، هرگز مقدار (حتی اگر رشتهٔ اتصال/کلید در فیلدِ اشتباه باشد).
 * اعتبارسنجیِ عمیق (بازه‌ها، سازگاریِ فاصله/عقب‌نشینی با graceMs…) تکرار نمی‌شود: سازنده‌های `settlement` منبعِ حقیقت‌اند و issueهایشان بی‌تغییر می‌رسد.
 */
import { SETTLEMENT_LIMITS, createSettlementSweeper, createSweepHealthCheck, createSweepLoop } from "@/modules/settlement";
import type { SettlementConfigError, SweepHealthCheck, SweepLoop, Sweeper } from "@/modules/settlement";
import type { RuntimeResult } from "./types";

export const SETTLEMENT_RUNTIME_LIMITS = Object.freeze({
  defaultStartTimeoutMs: 15_000,
  maxStartTimeoutMs: 300_000,
});

export const TUNING_KEYS = ["graceMs", "intervalMs", "maxBackoffMs", "maxDrainRuns", "stopTimeoutMs", "leaseMs", "limit", "maxAttempts", "retryDelayMs", "deadLetters", "observer", "health", "startTimeoutMs"] as const;
const SWEEPER_OPTIONAL = ["limit", "maxAttempts", "retryDelayMs"] as const;
const LOOP_OPTIONAL = ["maxBackoffMs", "maxDrainRuns", "stopTimeoutMs", "observer"] as const;
const DEAD_KEYS = ["deliver", "batchLimit", "maxBatchesPerRun", "deliverTimeoutMs"] as const;
const DEAD_OPTIONAL = ["batchLimit", "maxBatchesPerRun", "deliverTimeoutMs"] as const;
const HEALTH_KEYS = ["degradedAfterMs", "downAfterMs"] as const;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isFn = (v: unknown): v is (...args: never[]) => unknown => typeof v === "function";
export const hasFns = (v: unknown, names: readonly string[]): boolean => (typeof v === "object" || typeof v === "function") && v !== null && names.every((n) => typeof (v as Record<string, unknown>)[n] === "function");
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;

export function configError(issues: readonly string[]): { ok: false; error: SettlementConfigError } {
  return { ok: false, error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندی اجرای تسویهٔ ماندگار نامعتبر است.", issues: Object.freeze([...new Set(issues)]) }) };
}

/** هر کلید فقط یک بار خوانده می‌شود (getter دو بار پاسخ متفاوت نمی‌دهد)؛ `null` اگر شیء ساده نباشد. */
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

export function pick(snap: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (snap[k] !== undefined) out[k] = snap[k];
  return out;
}

export type Assembled = Readonly<{ sweeper: Sweeper; loop: SweepLoop; check: SweepHealthCheck; startTimeoutMs: number }>;

const PLACEHOLDER_SWEEPER: Sweeper = Object.freeze({ sweep: () => Promise.reject(new Error("placeholder")) });

/** `snap` باید پیش‌تر از `snapshot` آمده و ورودی‌های پورت (`ledger/outbox/clock/timer`) جدا اعتبارسنجی شده باشند. */
export function assemble(snap: Record<string, unknown>, ports: Readonly<{ ledger: unknown; outbox: unknown; clock: unknown; timer: unknown }>): RuntimeResult<Assembled> {
  const issues: string[] = [];
  const grace = snap["graceMs"];
  if (!isIntIn(grace, 1, SETTLEMENT_LIMITS.maxGraceMs)) return configError([...issues, `graceMs الزامی است (صحیح ۱ تا ${SETTLEMENT_LIMITS.maxGraceMs}).`]);

  const startTimeoutMs = snap["startTimeoutMs"] === undefined ? SETTLEMENT_RUNTIME_LIMITS.defaultStartTimeoutMs : snap["startTimeoutMs"];
  if (!isIntIn(startTimeoutMs, 1, SETTLEMENT_RUNTIME_LIMITS.maxStartTimeoutMs)) issues.push(`startTimeoutMs باید صحیح ۱ تا ${SETTLEMENT_RUNTIME_LIMITS.maxStartTimeoutMs} باشد.`);

  // زنگِ ماندگار: انتخابِ آگاهانه (false یا { deliver }) — نبودن = شکستِ بسته، نه «بی‌صدا غیرفعال».
  const dl = snap["deadLetters"];
  let deadLetters: Record<string, unknown> | null = null;
  if (dl === false) deadLetters = null;
  else if (isRecord(dl)) {
    const deadSnap = snapshot(dl) as Record<string, unknown>;
    issues.push(...unknownKeyIssues(deadSnap, DEAD_KEYS, " (deadLetters)"));
    if (!isFn(deadSnap["deliver"])) issues.push("deadLetters.deliver باید تابع باشد.");
    deadLetters = { outbox: ports.outbox, deliver: deadSnap["deliver"], ...pick(deadSnap, DEAD_OPTIONAL) };
  } else issues.push("deadLetters الزامی است: false (آگاهانه، فقط درون‌حافظه‌ای) یا { deliver }.");

  const healthRaw = snap["health"];
  let healthCfg: Record<string, unknown> = {};
  if (healthRaw !== undefined) {
    if (!isRecord(healthRaw)) issues.push("health باید شیء ساده باشد.");
    else {
      const hs = snapshot(healthRaw) as Record<string, unknown>;
      issues.push(...unknownKeyIssues(hs, HEALTH_KEYS, " (health)"));
      healthCfg = pick(hs, HEALTH_KEYS);
    }
  }

  const sweeper = createSettlementSweeper({
    ledger: ports.ledger,
    outbox: ports.outbox,
    clock: ports.clock,
    leaseMs: snap["leaseMs"] === undefined ? Math.min(grace, SETTLEMENT_LIMITS.maxLeaseMs) : snap["leaseMs"],
    ...pick(snap, SWEEPER_OPTIONAL),
  });
  if (!sweeper.ok) issues.push(...sweeper.error.issues);

  const loop = createSweepLoop({
    sweeper: sweeper.ok ? sweeper.value : PLACEHOLDER_SWEEPER,
    timer: ports.timer,
    clock: ports.clock,
    graceMs: grace,
    intervalMs: snap["intervalMs"] === undefined ? Math.max(1, Math.floor(grace / 4)) : snap["intervalMs"],
    ...pick(snap, LOOP_OPTIONAL),
    ...(deadLetters === null ? {} : { deadLetters }),
  });
  if (!loop.ok) issues.push(...loop.error.issues);

  const check = createSweepHealthCheck({ graceMs: grace, ...healthCfg });
  if (!check.ok) issues.push(...check.error.issues);

  if (issues.length > 0 || !sweeper.ok || !loop.ok || !check.ok) return configError(issues);
  return { ok: true, value: Object.freeze({ sweeper: sweeper.value, loop: loop.value, check: check.value, startTimeoutMs: startTimeoutMs as number }) };
}
