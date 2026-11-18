/**
 * settlement — اعتبارسنجی پیکربندی روی مرز (ورودی `unknown`؛ بی‌پرتاب؛ مشکل‌ها فقط نام فیلدند، هرگز مقدار).
 */
import { LIMITS } from "@/modules/ledger";
import type { Clock, CloseRemainder, Ledger } from "@/modules/ledger";
import { isDecoratedLedger } from "./decorated";
import type { DurableLedgerConfig, SettlementConfigError, SettlementOutbox, SettlementResult, SweeperConfig } from "./types";

export const SETTLEMENT_LIMITS = Object.freeze({
  maxGraceMs: LIMITS.MAX_TTL_MS / 2,
  defaultSweepLimit: 100,
  maxSweepLimit: 1000,
  defaultMaxAttempts: 10,
  maxMaxAttempts: 100,
  defaultRetryDelayMs: 30_000,
  maxRetryDelayMs: 86_400_000,
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

export type ResolvedSweeperConfig = Readonly<{ ledger: Ledger; outbox: SettlementOutbox; clock: Clock; limit: number; maxAttempts: number; retryDelayMs: number }>;

export function resolveSweeperConfig(raw: unknown): SettlementResult<ResolvedSweeperConfig> {
  const issues: string[] = [];
  try {
    if (!isRecord(raw)) return configError(["پیکربندی باید یک شیء ساده باشد."]);
    const allowed = new Set(["ledger", "outbox", "clock", "limit", "maxAttempts", "retryDelayMs"]);
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
    if (issues.length > 0) return configError(issues);
    return {
      ok: true,
      value: Object.freeze({ ledger: raw["ledger"] as Ledger, outbox: raw["outbox"] as SettlementOutbox, clock: raw["clock"] as Clock, limit: limit as number, maxAttempts: maxAttempts as number, retryDelayMs: retryDelayMs as number }),
    };
  } catch {
    return configError(["خواندن پیکربندی ناموفق بود."]);
  }
}

export type { SweeperConfig };
