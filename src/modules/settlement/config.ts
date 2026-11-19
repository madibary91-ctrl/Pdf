/**
 * settlement — اعتبارسنجی پیکربندی روی مرز (ورودی `unknown`؛ بی‌پرتاب؛ مشکل‌ها فقط نام فیلدند، هرگز مقدار).
 */
import { LIMITS } from "@/modules/ledger";
import type { Clock, CloseRemainder, Ledger } from "@/modules/ledger";
import { isDecoratedLedger } from "./decorated";
import { LEASE_MS_MAX, isLeaseMs } from "./validate";
import type { DeadLetter, DeadLetterOutbox, DurableLedgerConfig, LoopTimer, SettlementConfigError, SettlementOutbox, SettlementResult, SweepLoopConfig, SweepObserver, Sweeper, SweeperConfig } from "./types";

export const SETTLEMENT_LIMITS = Object.freeze({
  maxGraceMs: LIMITS.MAX_TTL_MS / 2,
  defaultSweepLimit: 100,
  maxSweepLimit: 1000,
  maxLeaseMs: LEASE_MS_MAX,
  defaultMaxAttempts: 10,
  maxMaxAttempts: 100,
  defaultRetryDelayMs: 30_000,
  maxRetryDelayMs: 86_400_000,
  defaultMaxDrainRuns: 20,
  maxMaxDrainRuns: 1000,
  defaultStopTimeoutMs: 30_000,
  maxStopTimeoutMs: 3_600_000,
  defaultDeadBatchLimit: 50,
  maxDeadBatchLimit: 1000,
  defaultDeadBatchesPerRun: 5,
  maxDeadBatchesPerRun: 100,
  defaultDeliverTimeoutMs: 30_000,
  maxDeliverTimeoutMs: 3_600_000,
});

const OUTBOX_METHODS = ["begin", "recordCharge", "recordClose", "resolveClose", "finish", "recordFailure", "bury", "get", "listDue", "listDead", "counts"] as const;
const LEDGER_METHODS = ["openAccount", "grant", "reserve", "charge", "close", "refund", "balance", "journal"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;
const hasFns = (v: unknown, names: readonly string[]): boolean => (typeof v === "object" || typeof v === "function") && v !== null && names.every((n) => typeof (v as Record<string, unknown>)[n] === "function");

export function configError(issues: readonly string[]): { ok: false; error: SettlementConfigError } {
  return { ok: false, error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندی تسویهٔ ماندگار نامعتبر است.", issues: Object.freeze([...issues]) }) };
}

function checkCommon(raw: Record<string, unknown>, issues: string[]): void {
  if (!hasFns(raw["ledger"], LEDGER_METHODS)) issues.push("ledger باید Ledger کامل باشد.");
  if (!hasFns(raw["outbox"], OUTBOX_METHODS)) issues.push("outbox باید پورت SettlementOutbox کامل باشد.");
  if (!hasFns(raw["clock"], ["nowMs"])) issues.push("clock الزامی است و باید nowMs داشته باشد.");
}

export function resolveDurableLedgerConfig(raw: unknown): SettlementResult<DurableLedgerConfig> {
  const issues: string[] = [];
  try {
    if (!isRecord(raw)) return configError(["پیکربندی باید یک شیء ساده باشد."]);
    const allowed = new Set(["ledger", "outbox", "clock", "graceMs", "onUnknownCost"]);
    for (const k of Object.keys(raw)) if (!allowed.has(k)) issues.push(`کلید ناشناخته: ${JSON.stringify(k.slice(0, 40))}.`);
    checkCommon(raw, issues);
    if (isDecoratedLedger(raw["ledger"])) issues.push("ledger خودش دفتر تسویهٔ ماندگار است؛ دکوراتور را دو بار نپوشانید.");
    if (!isIntIn(raw["graceMs"], 1, SETTLEMENT_LIMITS.maxGraceMs)) issues.push(`graceMs الزامی است (صحیح ۱ تا ${SETTLEMENT_LIMITS.maxGraceMs}).`);
    if (raw["onUnknownCost"] !== "forfeit" && raw["onUnknownCost"] !== "release") issues.push("onUnknownCost الزامی است: «forfeit» یا «release».");
    if (issues.length > 0) return configError(issues);
    return {
      ok: true,
      value: Object.freeze({
        ledger: raw["ledger"] as Ledger,
        outbox: raw["outbox"] as SettlementOutbox,
        clock: raw["clock"] as Clock,
        graceMs: raw["graceMs"] as number,
        onUnknownCost: raw["onUnknownCost"] as CloseRemainder,
      }),
    };
  } catch {
    return configError(["خواندن پیکربندی ناموفق بود."]);
  }
}

/** `leaseMs`: `null` ⇒ بی‌اجاره (`listDue`، رفتارِ پیشین)؛ عدد ⇒ `outbox.claimDue` (ADR-0029؛ در این حالت `outbox` یقیناً `claimDue` دارد). */
export type ResolvedSweeperConfig = Readonly<{ ledger: Ledger; outbox: SettlementOutbox; clock: Clock; limit: number; maxAttempts: number; retryDelayMs: number; leaseMs: number | null }>;

export function resolveSweeperConfig(raw: unknown): SettlementResult<ResolvedSweeperConfig> {
  const issues: string[] = [];
  try {
    if (!isRecord(raw)) return configError(["پیکربندی باید یک شیء ساده باشد."]);
    const allowed = new Set(["ledger", "outbox", "clock", "limit", "maxAttempts", "retryDelayMs", "leaseMs"]);
    for (const k of Object.keys(raw)) if (!allowed.has(k)) issues.push(`کلید ناشناخته: ${JSON.stringify(k.slice(0, 40))}.`);
    if (!hasFns(raw["ledger"], ["charge", "close"])) issues.push("ledger باید charge و close داشته باشد.");
    if (!hasFns(raw["outbox"], OUTBOX_METHODS)) issues.push("outbox باید پورت SettlementOutbox کامل باشد.");
    if (!hasFns(raw["clock"], ["nowMs"])) issues.push("clock الزامی است و باید nowMs داشته باشد.");
    // رفتگر باید دفتر **خام** را بگیرد؛ با دفتر دکوراته‌شده هر تلاشِ رفتگر خودش قصد ثبت می‌کرد و دور می‌زد.
    if (isDecoratedLedger(raw["ledger"])) issues.push("رفتگر باید دفتر خام را بگیرد، نه دفتر تسویهٔ ماندگار.");
    const limit = raw["limit"] ?? SETTLEMENT_LIMITS.defaultSweepLimit;
    const maxAttempts = raw["maxAttempts"] ?? SETTLEMENT_LIMITS.defaultMaxAttempts;
    const retryDelayMs = raw["retryDelayMs"] ?? SETTLEMENT_LIMITS.defaultRetryDelayMs;
    if (!isIntIn(limit, 1, SETTLEMENT_LIMITS.maxSweepLimit)) issues.push(`limit باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxSweepLimit} باشد.`);
    if (!isIntIn(maxAttempts, 1, SETTLEMENT_LIMITS.maxMaxAttempts)) issues.push(`maxAttempts باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxMaxAttempts} باشد.`);
    if (!isIntIn(retryDelayMs, 1, SETTLEMENT_LIMITS.maxRetryDelayMs)) issues.push(`retryDelayMs باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxRetryDelayMs} باشد.`);
    // اجارهٔ رفتگر (ADR-0029): اختیاری؛ حاضر-ولی-`undefined` مثلِ نبودن است. با آن، outbox باید `claimDue` داشته باشد (خاموش‌شدنِ بی‌صدا ممنوع).
    const leaseMs = raw["leaseMs"];
    if (leaseMs !== undefined) {
      if (!isLeaseMs(leaseMs)) issues.push(`leaseMs باید صحیح ۱ تا ${LEASE_MS_MAX} باشد.`);
      if (!hasFns(raw["outbox"], ["claimDue"])) issues.push("با leaseMs، outbox باید claimDue داشته باشد.");
    }
    if (issues.length > 0) return configError(issues);
    return {
      ok: true,
      value: Object.freeze({
        ledger: raw["ledger"] as Ledger,
        outbox: raw["outbox"] as SettlementOutbox,
        clock: raw["clock"] as Clock,
        limit: limit as number,
        maxAttempts: maxAttempts as number,
        retryDelayMs: retryDelayMs as number,
        leaseMs: leaseMs === undefined ? null : (leaseMs as number),
      }),
    };
  } catch {
    return configError(["خواندن پیکربندی ناموفق بود."]);
  }
}

export type ResolvedDeadLetters = Readonly<{
  outbox: DeadLetterOutbox;
  deliver: (letter: DeadLetter) => unknown;
  batchLimit: number;
  maxBatchesPerRun: number;
  deliverTimeoutMs: number;
}>;

const DEAD_LETTER_KEYS = new Set(["outbox", "deliver", "batchLimit", "maxBatchesPerRun", "deliverTimeoutMs"]);

/** `deadLetters` (ADR-0026): اختیاری؛ `undefined` ⇒ `null`. مشکل‌ها فقط نامِ فیلدند. */
function resolveDeadLetters(raw: unknown, issues: string[]): ResolvedDeadLetters | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) {
    issues.push("deadLetters باید شیء ساده باشد.");
    return null;
  }
  for (const k of Object.keys(raw)) if (!DEAD_LETTER_KEYS.has(k)) issues.push(`کلید ناشناختهٔ deadLetters: ${JSON.stringify(k.slice(0, 40))}.`);
  if (!hasFns(raw["outbox"], ["listUnacknowledgedDead", "acknowledgeDead"])) issues.push("deadLetters.outbox باید listUnacknowledgedDead و acknowledgeDead داشته باشد.");
  if (typeof raw["deliver"] !== "function") issues.push("deadLetters.deliver الزامی است و باید تابع باشد.");
  const batchLimit = raw["batchLimit"] ?? SETTLEMENT_LIMITS.defaultDeadBatchLimit;
  const batches = raw["maxBatchesPerRun"] ?? SETTLEMENT_LIMITS.defaultDeadBatchesPerRun;
  const timeout = raw["deliverTimeoutMs"] ?? SETTLEMENT_LIMITS.defaultDeliverTimeoutMs;
  if (!isIntIn(batchLimit, 1, SETTLEMENT_LIMITS.maxDeadBatchLimit)) issues.push(`deadLetters.batchLimit باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxDeadBatchLimit} باشد.`);
  if (!isIntIn(batches, 1, SETTLEMENT_LIMITS.maxDeadBatchesPerRun)) issues.push(`deadLetters.maxBatchesPerRun باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxDeadBatchesPerRun} باشد.`);
  if (!isIntIn(timeout, 1, SETTLEMENT_LIMITS.maxDeliverTimeoutMs)) issues.push(`deadLetters.deliverTimeoutMs باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxDeliverTimeoutMs} باشد.`);
  if (issues.length > 0) return null;
  return Object.freeze({
    outbox: raw["outbox"] as DeadLetterOutbox,
    deliver: raw["deliver"] as (letter: DeadLetter) => unknown,
    batchLimit: batchLimit as number,
    maxBatchesPerRun: batches as number,
    deliverTimeoutMs: timeout as number,
  });
}

export type ResolvedSweepLoopConfig = Readonly<{
  sweeper: Sweeper;
  timer: LoopTimer;
  clock: Clock;
  graceMs: number;
  intervalMs: number;
  maxBackoffMs: number;
  maxDrainRuns: number;
  stopTimeoutMs: number;
  observer: SweepObserver | null;
  deadLetters: ResolvedDeadLetters | null;
}>;

const OBSERVER_KEYS = ["onReport", "onBuried", "onFault"] as const;

/**
 * حلقهٔ رفتگر (ADR-0023). قاعدهٔ ایمنی: فاصلهٔ دو گذر هرگز از ⌊graceMs/2⌋ بیشتر نمی‌شود؛ رزروِ یتیم در `created + graceMs` سررسید می‌شود و
 * `graceMs ≤ ttl/2`، پس با فاصلهٔ ≤ grace/2 نیمی از grace برای زمانِ خودِ گذر می‌ماند و رزرو پیش از انقضا دیده می‌شود.
 */
export function resolveSweepLoopConfig(raw: unknown): SettlementResult<ResolvedSweepLoopConfig> {
  const issues: string[] = [];
  try {
    if (!isRecord(raw)) return configError(["پیکربندی باید یک شیء ساده باشد."]);
    const allowed = new Set(["sweeper", "timer", "clock", "graceMs", "intervalMs", "maxBackoffMs", "maxDrainRuns", "stopTimeoutMs", "observer", "deadLetters"]);
    for (const k of Object.keys(raw)) if (!allowed.has(k)) issues.push(`کلید ناشناخته: ${JSON.stringify(k.slice(0, 40))}.`);
    if (!hasFns(raw["sweeper"], ["sweep"])) issues.push("sweeper باید sweep داشته باشد (createSettlementSweeper).");
    if (!hasFns(raw["timer"], ["after", "cancel"])) issues.push("timer الزامی است و باید after و cancel داشته باشد.");
    if (!hasFns(raw["clock"], ["nowMs"])) issues.push("clock الزامی است و باید nowMs داشته باشد.");
    const grace = raw["graceMs"];
    const graceOk = isIntIn(grace, 2, SETTLEMENT_LIMITS.maxGraceMs);
    if (!graceOk) issues.push(`graceMs الزامی است (صحیح ۲ تا ${SETTLEMENT_LIMITS.maxGraceMs}).`);
    const half = graceOk ? Math.floor(grace / 2) : 0;
    const interval = raw["intervalMs"];
    const intervalOk = graceOk && isIntIn(interval, 1, half);
    if (!intervalOk) issues.push(graceOk ? `intervalMs الزامی است (صحیح ۱ تا ⌊graceMs/2⌋ = ${half}).` : "intervalMs الزامی است (صحیح و ≤ ⌊graceMs/2⌋).");
    const backoff = raw["maxBackoffMs"] ?? (graceOk ? half : undefined);
    if (graceOk && !(isIntIn(backoff, 1, half) && (!intervalOk || (backoff as number) >= (interval as number)))) issues.push(`maxBackoffMs باید صحیح، ≥ intervalMs و ≤ ⌊graceMs/2⌋ = ${half} باشد.`);
    const drain = raw["maxDrainRuns"] ?? SETTLEMENT_LIMITS.defaultMaxDrainRuns;
    if (!isIntIn(drain, 1, SETTLEMENT_LIMITS.maxMaxDrainRuns)) issues.push(`maxDrainRuns باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxMaxDrainRuns} باشد.`);
    const stopTimeout = raw["stopTimeoutMs"] ?? SETTLEMENT_LIMITS.defaultStopTimeoutMs;
    if (!isIntIn(stopTimeout, 1, SETTLEMENT_LIMITS.maxStopTimeoutMs)) issues.push(`stopTimeoutMs باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxStopTimeoutMs} باشد.`);
    const observer = raw["observer"];
    if (observer !== undefined) {
      if (!isRecord(observer)) issues.push("observer باید شیء ساده باشد.");
      else {
        for (const k of Object.keys(observer)) if (!(OBSERVER_KEYS as readonly string[]).includes(k)) issues.push(`کلید ناشناختهٔ observer: ${JSON.stringify(k.slice(0, 40))}.`);
        for (const k of OBSERVER_KEYS) if (observer[k] !== undefined && typeof observer[k] !== "function") issues.push(`observer.${k} باید تابع باشد.`);
      }
    }
    const deadLetters = resolveDeadLetters(raw["deadLetters"], issues);
    if (issues.length > 0) return configError(issues);
    return {
      ok: true,
      value: Object.freeze({
        sweeper: raw["sweeper"] as Sweeper,
        timer: raw["timer"] as LoopTimer,
        clock: raw["clock"] as Clock,
        graceMs: grace as number,
        intervalMs: interval as number,
        maxBackoffMs: backoff as number,
        maxDrainRuns: drain as number,
        stopTimeoutMs: stopTimeout as number,
        observer: observer === undefined ? null : (observer as SweepObserver),
        deadLetters,
      }),
    };
  } catch {
    return configError(["خواندن پیکربندی ناموفق بود."]);
  }
}

export type { SweeperConfig, SweepLoopConfig };
