/**
 * ابزار مشترک آزمون‌های metering (از index صادر نمی‌شود). همهٔ قیمت‌ها **ساختگیِ آزمون**‌اند؛ هیچ ارتباطی با قیمت واقعی ندارند.
 * قیمت آزمون: ۱ خرد به ازای هر توکن ورودی و ۳ خرد به ازای هر توکن خروجی (حساب دستی ساده).
 */
import type { Completion, Gateway, GatewayError, ModelLimits, PriceSpec } from "@/modules/ai-gateway";
import { createLedger, createMemoryStore } from "@/modules/ledger";
import type { AccountStore, Balance, Clock, Ledger } from "@/modules/ledger";
import type { MeteredModel, MeteringConfig } from "./types";

export const TENANT = "tenant-m";
export const ACCOUNT = "acct-m";
export const CURRENCY = "IRR";
export const UNIT = "IRR_MICROS";

export const PRICE: PriceSpec = { currency: "IRR", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 3_000_000, version: "test-v1" };
export const PRICE_ALT: PriceSpec = { currency: "IRR", inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 5_000_000, version: "test-v2" };
export const PRICE_USD: PriceSpec = { currency: "USD", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 1_000_000, version: "test-usd" };

export const MODELS: Readonly<Record<string, MeteredModel>> = {
  main: { price: PRICE, maxOutputTokens: 1000 },
  alt: { price: PRICE_ALT, maxOutputTokens: 1000 },
  free: { price: null, maxOutputTokens: 1000 },
  usd: { price: PRICE_USD, maxOutputTokens: 1000 },
};

/** درخواست نمونه: ۴ بایت ورودی + سربار ۱۰ ⇒ کران ۱۴؛ خروجی ۱۰۰ ⇒ بدترین‌هزینهٔ main = ۱۴ + ۳۰۰ = ۳۱۴. */
export const REQUEST = Object.freeze({ model: "main", messages: Object.freeze([Object.freeze({ role: "user", content: "abcd" })]), maxOutputTokens: 100 });
export const WORST = 314;

export type MutableClock = Clock & { advance(d: number): void };
export function mutableClock(start = 1_000_000): MutableClock {
  let t = start;
  return { nowMs: () => t, advance: (d) => void (t += d) };
}

export async function fundedLedger(amount: number, store: AccountStore = createMemoryStore(), clock: MutableClock = mutableClock()): Promise<{ ledger: Ledger; store: AccountStore; clock: MutableClock }> {
  const made = createLedger({ store, clock });
  if (!made.ok) throw new Error(`createLedger failed: ${made.error.code}`);
  const o = await made.value.openAccount({ tenantId: TENANT, accountId: ACCOUNT, unit: UNIT });
  if (!o.ok) throw new Error(`open failed: ${o.error.code}`);
  if (amount > 0) {
    const g = await made.value.grant({ tenantId: TENANT, accountId: ACCOUNT, grantId: "g0", unit: UNIT, amount, source: "purchase" });
    if (!g.ok) throw new Error(`grant failed: ${g.error.code}`);
  }
  return { ledger: made.value, store, clock };
}

export function config(ledger: Ledger, gateway: Gateway, over: Record<string, unknown> = {}): MeteringConfig {
  return {
    gateway,
    ledger,
    account: { tenantId: TENANT, accountId: ACCOUNT },
    currency: CURRENCY,
    models: MODELS,
    scopeId: "scope-1",
    reservationTtlMs: 60_000,
    maxProviderCalls: 1,
    perMessageOverheadTokens: 10,
    onUnknownCost: "forfeit",
    ...over,
  } as MeteringConfig;
}

export async function balance(ledger: Ledger): Promise<Balance> {
  const b = await ledger.balance({ tenantId: TENANT, accountId: ACCOUNT });
  if (!b.ok) throw new Error(`balance failed: ${b.error.code}`);
  return b.value;
}

// ───────── دروازهٔ ساختگی ─────────

export const completion = (micros: number | null, extra: Record<string, unknown> = {}): Completion =>
  ({
    text: "t",
    finishReason: "stop",
    model: "main",
    provider: "p",
    servedModel: null,
    requestId: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    cost: micros === null ? null : { micros, currency: "IRR", priceVersion: "test-v1" },
    latencyMs: 1,
    warnings: [],
    ...extra,
  }) as unknown as Completion;

export const okResult = (micros: number | null, extra: Record<string, unknown> = {}) => ({ ok: true as const, value: completion(micros, extra) });
export const errResult = (code: string, extra: Record<string, unknown> = {}) => ({ ok: false as const, error: { code, message: "m", retryable: false, warnings: [], ...extra } as unknown as GatewayError });

export const report = (over: Record<string, unknown> = {}) => ({
  requestedModel: "main",
  attempts: [{ index: 1, model: "main", modelAttempt: 1, waitedMs: 0, outcome: "ok", reachedProvider: true, usage: null, cost: null, latencyMs: 1 }],
  spend: [{ currency: "IRR", micros: 100 }],
  costUnknownAttempts: 0,
  stoppedBecause: "success",
  ...over,
});

export type FakeGateway = Gateway & { calls: unknown[]; signals: unknown[] };

/** هر تماس یک گام را مصرف می‌کند (تابع: گام پویا)؛ پایان سناریو بلند شکست می‌خورد. */
export function fakeGateway(steps: readonly unknown[] | ((n: number, input: unknown) => unknown | Promise<unknown>), limits: ModelLimits | null = { maxInputChars: 1000, maxOutputTokens: 1000, priced: true }): FakeGateway {
  const calls: unknown[] = [];
  const signals: unknown[] = [];
  return {
    calls,
    signals,
    async complete(input: unknown, options?: Readonly<{ signal?: AbortSignal }>) {
      calls.push(input);
      signals.push(options?.signal);
      const n = calls.length;
      const step = typeof steps === "function" ? await steps(n, input) : steps[n - 1];
      if (step === undefined) throw new Error("سناریوی fakeGateway تمام شد");
      if (step instanceof Error) throw step;
      return step as never;
    },
    limits: () => limits,
  };
}

/** دفترِ ناپایدار: پیش از نتیجهٔ واقعی، شمار مشخصی خطای STORE_FAILURE برمی‌گرداند (یا می‌پرتابد). */
export function flakyLedger(ledger: Ledger, plan: Partial<Record<"reserve" | "charge" | "close", { fail: number; mode?: "result" | "throw"; code?: "STORE_FAILURE" | "INTERNAL_ERROR" | "RESERVATION_NOT_FOUND" }>>): Ledger & { count: Record<string, number> } {
  const count: Record<string, number> = { reserve: 0, charge: 0, close: 0 };
  const wrap = <K extends "reserve" | "charge" | "close">(name: K) =>
    (async (input: never) => {
      count[name] = (count[name] ?? 0) + 1;
      const p = plan[name];
      if (p !== undefined && (count[name] as number) <= p.fail) {
        if (p.mode === "throw") throw new Error("boom");
        return { ok: false, error: { code: p.code ?? "STORE_FAILURE", message: "x" } };
      }
      return (ledger[name] as (i: never) => Promise<unknown>)(input);
    }) as Ledger[K];
  return { ...ledger, reserve: wrap("reserve"), charge: wrap("charge"), close: wrap("close"), count };
}
