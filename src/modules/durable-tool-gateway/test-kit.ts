/**
 * ابزار مشترکِ آزمون‌های durable-tool-gateway (از index صادر نمی‌شود). همهٔ قیمت‌ها **ساختگیِ آزمون**‌اند.
 * قیمتِ آزمون: ۱ خرد به ازای هر توکنِ ورودی و ۳ خرد به ازای هر توکنِ خروجی؛ بدترین‌هزینهٔ `STEP` = ۴۹۳ (حسابِ دستی؛ metered-tool-gateway).
 */
import type { Cost, ModelLimits, ToolGateway, ToolSpec } from "@/modules/ai-gateway";
import { createLedger, createMemoryStore } from "@/modules/ledger";
import type { AccountStore, Balance, Clock, Ledger } from "@/modules/ledger";
import { createMemoryOutbox, createSettlementSweeper } from "@/modules/settlement";
import type { OutboxResult, SettlementOutbox, Sweeper } from "@/modules/settlement";
import { createDurableToolGateway } from "./gateway";

export const TENANT = "tenant-d";
export const ACCOUNT = "acct-d";
export const KEY = { tenantId: TENANT, accountId: ACCOUNT };
export const UNIT = "IRR_MICROS";
export const PRICE = { currency: "IRR", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 3_000_000, version: "test-v1" };
export const MODELS = { legal: { price: PRICE, maxOutputTokens: 1000 }, free: { price: null, maxOutputTokens: 1000 } } as const;
export const TOOL: ToolSpec = { name: "t", description: "d", parameters: { type: "object", properties: {} } };
export const STEP = Object.freeze({ model: "legal", messages: Object.freeze([Object.freeze({ role: "user", content: "abcd" })]), maxOutputTokens: 100, tools: Object.freeze([TOOL]) });
/** ورودی: ۴ + ۱۶۹ بایتِ ابزار + ۲ بخش × ۱۰ سربار = ۱۹۳؛ خروجی ۱۰۰ × ۳ = ۳۰۰ ⇒ ۴۹۳. */
export const WORST = 493;
export const OVERHEAD = 10;
export const GRACE = 10_000;
export const TTL = 60_000;
export const FUNDS = 100_000;
export const refOf = (reservationId: string) => ({ ...KEY, reservationId });

export type MutableClock = Clock & { advance(d: number): void };
export function mutableClock(start = 1_000_000): MutableClock {
  let t = start;
  return { nowMs: () => t, advance: (d) => void (t += d) };
}

export const cost = (micros: number, currency = "IRR"): Cost => ({ micros, currency, priceVersion: "test-v1" });
export type StepReply = Readonly<{ ok: boolean; value?: unknown; error?: unknown }>;
export const stepOk = (micros: number | null): StepReply => ({
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
  },
});
export const stepErr = (code: string, extra: Record<string, unknown> = {}): StepReply => ({
  ok: false,
  error: { code, message: "m", retryable: false, warnings: [], usage: null, cost: null, ...extra },
});

type Reply = StepReply | ((input: unknown, index: number) => unknown | Promise<unknown>);
export type Stub = { gateway: ToolGateway; inputs: unknown[] };
export function stubGateway(reply: Reply): Stub {
  const inputs: unknown[] = [];
  const limits = (m: string): ModelLimits | null => {
    const spec = (MODELS as Record<string, { price: unknown; maxOutputTokens: number }>)[m];
    return spec === undefined ? null : { maxInputChars: 20_000, maxOutputTokens: spec.maxOutputTokens, priced: spec.price !== null };
  };
  const gateway: ToolGateway = {
    completeStep: async (input) => {
      inputs.push(input);
      const i = inputs.length - 1;
      return (typeof reply === "function" ? await (reply as (a: unknown, b: number) => unknown)(input, i) : reply) as never;
    },
    toolFormat: () => "openai-chat",
    limits,
  };
  return { gateway, inputs };
}

type Fault = { fail: number; skip?: number };
type LedgerOp = "reserve" | "charge" | "close";
/** دفترِ ناپایدار: شمارِ مشخصی فراخوانیِ یک عملیات (پس از `skip`) شکست می‌خورد. */
export function flakyLedger(ledger: Ledger, plan: Partial<Record<LedgerOp, Fault>>): Ledger {
  const count: Record<string, number> = {};
  const wrap = <K extends LedgerOp>(name: K): Ledger[K] =>
    (async (input: never) => {
      count[name] = (count[name] ?? 0) + 1;
      const p = plan[name];
      const n = count[name] as number;
      if (p !== undefined && n > (p.skip ?? 0) && n <= (p.skip ?? 0) + p.fail) return { ok: false, error: { code: "STORE_FAILURE", message: "LEAK-CANARY-9c1" } };
      return (ledger[name] as (i: never) => Promise<unknown>)(input);
    }) as Ledger[K];
  return { ...ledger, reserve: wrap("reserve"), charge: wrap("charge"), close: wrap("close") };
}

const OUTBOX_METHODS = ["begin", "recordCharge", "recordClose", "resolveClose", "finish", "recordFailure", "bury", "get", "listDue", "listDead", "counts"] as const;
export type OutboxMethod = (typeof OUTBOX_METHODS)[number];
/** outboxِ ناپایدار؛ شکستِ تزریقی پیش از رسیدن به outboxِ واقعی است (بی‌اثر). */
export function flakyOutbox(outbox: SettlementOutbox, plan: Partial<Record<OutboxMethod, Fault>>): SettlementOutbox {
  const count: Record<string, number> = {};
  const wrapped: Record<string, unknown> = {};
  for (const name of OUTBOX_METHODS) {
    wrapped[name] = async (...args: unknown[]) => {
      count[name] = (count[name] ?? 0) + 1;
      const p = plan[name];
      const n = count[name] as number;
      if (p !== undefined && n > (p.skip ?? 0) && n <= (p.skip ?? 0) + p.fail) return { ok: false, error: { code: "STORE_FAILURE", message: "LEAK-CANARY-9c1" } } satisfies OutboxResult<never>;
      return (outbox[name] as (...a: unknown[]) => Promise<unknown>)(...args);
    };
  }
  return wrapped as unknown as SettlementOutbox;
}

export function ok<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`unexpected failure: ${JSON.stringify(r.error)}`);
  return r.value;
}

export async function fundedLedger(amount: number, store: AccountStore = createMemoryStore(), clock: MutableClock = mutableClock()): Promise<{ ledger: Ledger; store: AccountStore; clock: MutableClock }> {
  const made = createLedger({ store, clock });
  if (!made.ok) throw new Error(`createLedger failed: ${made.error.code}`);
  const o = await made.value.openAccount({ ...KEY, unit: UNIT });
  if (!o.ok) throw new Error(`open failed: ${o.error.code}`);
  if (amount > 0) {
    const g = await made.value.grant({ ...KEY, grantId: "g0", unit: UNIT, amount, source: "purchase" });
    if (!g.ok) throw new Error(`grant failed: ${g.error.code}`);
  }
  return { ledger: made.value, store, clock };
}

export async function balance(ledger: Ledger): Promise<Balance> {
  const b = await ledger.balance(KEY);
  if (!b.ok) throw new Error(`balance failed: ${b.error.code}`);
  return b.value;
}

/** ناورداهای پول روی موجودیِ دفتر: حفظِ مجموع (`available + held + charged + forfeited = granted`). */
export async function audit(ledger: Ledger): Promise<{ available: number; held: number; charged: number; forfeited: number; granted: number; openReservations: number }> {
  const b = await balance(ledger);
  const t = b.totals;
  if (b.available + b.held + t.charged + t.forfeited !== t.granted) throw new Error("بقا شکست");
  return { available: b.available, held: b.held, charged: t.charged, forfeited: t.forfeited, granted: t.granted, openReservations: b.openReservations };
}

export type World = Readonly<{
  /** دروازهٔ ماندگار (نتیجهٔ ساخت). */
  gw: NonNullable<ReturnType<typeof createDurableToolGateway> extends infer R ? (R extends { ok: true; value: infer V } ? V : never) : never>;
  stub: Stub;
  ledger: Ledger;
  store: AccountStore;
  clock: MutableClock;
  /** outboxِ حافظه‌ایِ واقعی (زیرِ بسته‌بندیِ احتمالیِ ناپایدار). */
  outbox: SettlementOutbox;
  /** رفتگرِ واقعی روی دفترِ **خام** و outboxِ واقعی. */
  sweeper: Sweeper;
  raw: Ledger;
}>;

export type WorldOptions = {
  funds?: number;
  policy?: "forfeit" | "release";
  scopeId?: string;
  ledger?: (l: Ledger) => Ledger;
  outbox?: (o: SettlementOutbox) => SettlementOutbox;
  over?: Record<string, unknown>;
};

export function configFor(ledger: Ledger, gateway: ToolGateway, outbox: SettlementOutbox, clock: Clock, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gateway,
    ledger,
    account: KEY,
    currency: "IRR",
    models: MODELS,
    scopeId: "scope-1",
    reservationTtlMs: TTL,
    perMessageOverheadTokens: OVERHEAD,
    onUnknownCost: "forfeit",
    outbox,
    clock,
    graceMs: GRACE,
    ...over,
  };
}

export async function world(reply: Reply, o: WorldOptions = {}): Promise<World> {
  const f = await fundedLedger(o.funds ?? FUNDS);
  const raw = o.ledger?.(f.ledger) ?? f.ledger;
  const mem = createMemoryOutbox();
  const outbox = o.outbox?.(mem) ?? mem;
  const stub = stubGateway(reply);
  const made = createDurableToolGateway(configFor(raw, stub.gateway, outbox, f.clock, { onUnknownCost: o.policy ?? "forfeit", ...(o.scopeId !== undefined ? { scopeId: o.scopeId } : {}), ...(o.over ?? {}) }));
  if (!made.ok) throw new Error(made.error.issues.join(";"));
  const sweeper = createSettlementSweeper({ ledger: f.ledger, outbox: mem, clock: f.clock });
  if (!sweeper.ok) throw new Error(sweeper.error.issues.join(";"));
  return { gw: made.value, stub, ledger: f.ledger, store: f.store, clock: f.clock, outbox: mem, sweeper: sweeper.value, raw };
}

/** بذرِ قطعی (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
