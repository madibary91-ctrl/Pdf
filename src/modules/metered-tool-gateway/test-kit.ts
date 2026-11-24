/**
 * ابزار مشترکِ آزمون‌های metered-tool-gateway (از index صادر نمی‌شود). همهٔ قیمت‌ها **ساختگیِ آزمون**‌اند و هیچ ارتباطی با قیمتِ واقعی ندارند.
 * قیمتِ آزمون: ۱ خرد به ازای هر توکنِ ورودی و ۳ خرد به ازای هر توکنِ خروجی (حسابِ دستیِ ساده).
 */
import type { Cost, ModelLimits, ToolGateway, ToolSpec } from "@/modules/ai-gateway";
import { createLedger, createMemoryStore } from "@/modules/ledger";
import type { AccountStore, Balance, Clock, Ledger } from "@/modules/ledger";
import { createMeteredToolGateway } from "./gateway";
import type { MeteredToolGateway, MeteredToolGatewayOptions } from "./types";

export const TENANT = "tenant-t";
export const ACCOUNT = "acct-t";
export const CURRENCY = "IRR";
export const UNIT = "IRR_MICROS";
export const PRICE = { currency: "IRR", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 3_000_000, version: "test-v1" };
export const PRICE_USD = { currency: "USD", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 1_000_000, version: "test-usd" };

export const MODELS = {
  legal: { price: PRICE, maxOutputTokens: 1000 },
  free: { price: null, maxOutputTokens: 1000 },
  usd: { price: PRICE_USD, maxOutputTokens: 1000 },
} as const;

export const TOOL: ToolSpec = { name: "t", description: "d", parameters: { type: "object", properties: {} } };
/** `encodeTools("openai-chat", [TOOL])` ⇒ ۱۶۹ بایتِ JSON (اندازه‌گیریِ دستی). */
export const TOOLS_BYTES = 169;
export const OVERHEAD = 10;
export const STEP = Object.freeze({ model: "legal", messages: Object.freeze([Object.freeze({ role: "user", content: "abcd" })]), maxOutputTokens: 100, tools: Object.freeze([TOOL]) });
/** ورودی: ۴ + ۱۶۹ بایت + ۲ بخش × ۱۰ سربار = ۱۹۳؛ خروجی ۱۰۰ × ۳ = ۳۰۰ ⇒ ۴۹۳. */
export const WORST = 493;

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

export async function balance(ledger: Ledger): Promise<Balance> {
  const b = await ledger.balance({ tenantId: TENANT, accountId: ACCOUNT });
  if (!b.ok) throw new Error(`balance failed: ${b.error.code}`);
  return b.value;
}

export const cost = (micros: number, currency = "IRR"): Cost => ({ micros, currency, priceVersion: "test-v1" });
export const stepOk = (micros: number | null, extra: Record<string, unknown> = {}): unknown => ({
  ok: true,
  value: {
    text: "t",
    toolCalls: [],
    finish: "stop",
    assistantMessage: { role: "assistant", content: "t" },
    format: "openai-chat",
    model: "legal",
    provider: "p",
    servedModel: null,
    requestId: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    cost: micros === null ? null : cost(micros),
    latencyMs: 1,
    warnings: [],
    ...extra,
  },
});
export const stepErr = (code: string, extra: Record<string, unknown> = {}): unknown => ({
  ok: false,
  error: { code, message: "m", retryable: false, warnings: [], usage: null, cost: null, ...extra },
});

type Reply = unknown | ((input: unknown, index: number) => unknown | Promise<unknown>);
export function stubGateway(reply: Reply, over: { format?: "openai-chat" | null; limits?: (model: string) => ModelLimits | null } = {}): { gateway: ToolGateway; inputs: unknown[]; options: unknown[] } {
  const inputs: unknown[] = [];
  const options: unknown[] = [];
  const limits =
    over.limits ??
    ((m: string): ModelLimits | null => {
      const spec = (MODELS as Record<string, { price: unknown; maxOutputTokens: number }>)[m];
      return spec === undefined ? null : { maxInputChars: 20_000, maxOutputTokens: spec.maxOutputTokens, priced: spec.price !== null };
    });
  const gateway: ToolGateway = {
    completeStep: async (input, opts) => {
      inputs.push(input);
      options.push(opts);
      const i = inputs.length - 1;
      return (typeof reply === "function" ? await (reply as (a: unknown, b: number) => unknown)(input, i) : reply) as never;
    },
    toolFormat: () => ("format" in over ? (over.format ?? null) : "openai-chat"),
    limits,
  };
  return { gateway, inputs, options };
}

export function baseOptions(ledger: Ledger, gateway: ToolGateway, over: Record<string, unknown> = {}): MeteredToolGatewayOptions {
  return {
    gateway,
    ledger,
    account: { tenantId: TENANT, accountId: ACCOUNT },
    currency: CURRENCY,
    models: MODELS,
    scopeId: "scope-1",
    reservationTtlMs: 60_000,
    perMessageOverheadTokens: OVERHEAD,
    onUnknownCost: "forfeit",
    ...over,
  } as MeteredToolGatewayOptions;
}

export function make(ledger: Ledger, gateway: ToolGateway, over: Record<string, unknown> = {}): MeteredToolGateway {
  const r = createMeteredToolGateway(baseOptions(ledger, gateway, over));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}
