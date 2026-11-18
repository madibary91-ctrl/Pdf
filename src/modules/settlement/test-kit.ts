/**
 * ابزار مشترک آزمون‌های settlement (از index صادر نمی‌شود). قیمت‌ها **ساختگیِ آزمون**‌اند (۱ خرد به ازای هر توکن ورودی، ۳ برای خروجی).
 * هر ماژول کمک‌تست خودش را دارد (ماژول‌ها کمک‌تست یکدیگر را import نمی‌کنند).
 */
import { checkInvariants, createLedger, createMemoryStore, foldJournal } from "@/modules/ledger";
import type { AccountStore, Balance, Clock, JournalEntry, Ledger, LedgerResult } from "@/modules/ledger";
import type { MeteringConfig } from "@/modules/metering";
import { createDurableLedger, createMemoryOutbox, createSettlementSweeper } from "./index";
import type { LoopTimer, OutboxResult, SettlementOutbox, SweepReport, Sweeper } from "./index";

type Gateway = MeteringConfig["gateway"];

export const TENANT = "tenant-s";
export const ACCOUNT = "acct-s";
export const KEY = { tenantId: TENANT, accountId: ACCOUNT };
export const UNIT = "IRR_MICROS";
export const PRICE = { currency: "IRR", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 3_000_000, version: "test-v1" };
export const MODELS = { main: { price: PRICE, maxOutputTokens: 1000 } };
/** ۴ بایت ورودی + سربار ۱۰ ⇒ ۱۴؛ خروجی ۱۰۰ ⇒ بدترین‌هزینه = ۱۴ + ۳۰۰ = ۳۱۴. */
export const REQUEST = Object.freeze({ model: "main", messages: Object.freeze([Object.freeze({ role: "user", content: "abcd" })]), maxOutputTokens: 100 });
export const WORST = 314;
export const GRACE = 10_000;
export const TTL = 60_000;

export type MutableClock = Clock & { advance(d: number): void };
export function mutableClock(start = 1_000_000): MutableClock {
  let t = start;
  return { nowMs: () => t, advance: (d) => void (t += d) };
}

export const refOf = (reservationId: string) => ({ ...KEY, reservationId });

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

export async function journal(ledger: Ledger): Promise<readonly JournalEntry[]> {
  const j = await ledger.journal(KEY);
  if (!j.ok) throw new Error(`journal failed: ${j.error.code}`);
  return j.value;
}

/** ناوردای پول روی حالت ماندگار (checkInvariants، بازپخش ژورنال، بقا). */
export async function auditLedger(store: AccountStore): Promise<{ available: number; held: number; charged: number; forfeited: number; granted: number }> {
  const state = await store.read(KEY);
  if (state === null) throw new Error("حساب نیست");
  const violations = checkInvariants(state);
  if (violations.length > 0) throw new Error(`ناوردا شکست: ${violations.join("; ")}`);
  const folded = foldJournal(await store.journal(KEY));
  if (!folded.ok) throw new Error(`بازپخش ژورنال: ${folded.reason}`);
  const f = folded.value;
  if (f.available !== state.available || f.held !== state.held || f.seq !== state.seq || JSON.stringify(f.totals) !== JSON.stringify(state.totals)) throw new Error("بازپخش ژورنال با حالت نمی‌خواند");
  const t = state.totals;
  if (state.available + state.held + t.charged + t.forfeited !== t.granted) throw new Error("بقا شکست");
  return { available: state.available, held: state.held, charged: t.charged, forfeited: t.forfeited, granted: t.granted };
}

// ───────── دروازهٔ ساختگی ─────────
export const completion = (micros: number | null): unknown => ({
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
});
export const okResult = (micros: number | null) => ({ ok: true as const, value: completion(micros) });
export const errResult = (code: string) => ({ ok: false as const, error: { code, message: "m", retryable: false, warnings: [] } });

export type FakeGateway = Gateway & { calls: unknown[] };
export function fakeGateway(steps: readonly unknown[] | ((n: number) => unknown | Promise<unknown>)): FakeGateway {
  const calls: unknown[] = [];
  return {
    calls,
    async complete(input: unknown) {
      calls.push(input);
      const n = calls.length;
      const step = typeof steps === "function" ? await steps(n) : steps[n - 1];
      if (step === undefined) throw new Error("سناریوی fakeGateway تمام شد");
      if (step instanceof Error) throw step;
      return step as never;
    },
    limits: () => ({ maxInputChars: 1000, maxOutputTokens: 1000, priced: true }),
  } as FakeGateway;
}

// ───────── خطای تزریقی ─────────
type Fault = { fail: number; skip?: number; mode?: "result" | "throw" | "garbage"; code?: string };

export function flakyLedger(ledger: Ledger, plan: Partial<Record<"reserve" | "charge" | "close", Fault>>): Ledger & { count: Record<string, number> } {
  const count: Record<string, number> = { reserve: 0, charge: 0, close: 0 };
  const wrap = <K extends "reserve" | "charge" | "close">(name: K) =>
    (async (input: never) => {
      count[name] = (count[name] ?? 0) + 1;
      const p = plan[name];
      const n = count[name] as number;
      if (p !== undefined && n > (p.skip ?? 0) && n <= (p.skip ?? 0) + p.fail) {
        if (p.mode === "throw") throw new Error("boom");
        if (p.mode === "garbage") return undefined;
        return { ok: false, error: { code: p.code ?? "STORE_FAILURE", message: "x" } };
      }
      return (ledger[name] as (i: never) => Promise<unknown>)(input);
    }) as Ledger[K];
  return { ...ledger, reserve: wrap("reserve"), charge: wrap("charge"), close: wrap("close"), count };
}

const OUTBOX_METHODS = ["begin", "recordCharge", "recordClose", "resolveClose", "finish", "recordFailure", "bury", "get", "listDue", "listDead", "counts"] as const;
export type OutboxMethod = (typeof OUTBOX_METHODS)[number];

/** outboxِ ناپایدار: شمار مشخصی فراخوانیِ یک متد (پس از `skip`) شکست می‌خورد، پیش از رسیدن به outboxِ واقعی (بی‌اثر). */
export function flakyOutbox(outbox: SettlementOutbox, plan: Partial<Record<OutboxMethod, Fault>>): SettlementOutbox & { count: Record<string, number>; log: string[] } {
  const count: Record<string, number> = {};
  const log: string[] = [];
  const wrapped: Record<string, unknown> = {};
  for (const name of OUTBOX_METHODS) {
    wrapped[name] = async (...args: unknown[]) => {
      count[name] = (count[name] ?? 0) + 1;
      log.push(`outbox.${name}`);
      const p = plan[name];
      const n = count[name] as number;
      if (p !== undefined && n > (p.skip ?? 0) && n <= (p.skip ?? 0) + p.fail) {
        if (p.mode === "throw") throw new Error("boom: LEAK-CANARY-7f3a");
        if (p.mode === "garbage") return undefined;
        return { ok: false, error: { code: "STORE_FAILURE", message: "LEAK-CANARY-7f3a" } } satisfies OutboxResult<never>;
      }
      return (outbox[name] as (...a: unknown[]) => Promise<unknown>)(...args);
    };
  }
  return Object.assign(wrapped as unknown as SettlementOutbox, { count, log });
}

/** ثبتِ ترتیبِ فراخوانی‌ها روی دفتر و outbox در یک فهرست. */
export function traceLedger(ledger: Ledger, log: string[]): Ledger {
  const t = <K extends keyof Ledger>(name: K) => ((input: never) => (log.push(`ledger.${String(name)}`), (ledger[name] as (i: never) => unknown)(input))) as Ledger[K];
  return { ...ledger, reserve: t("reserve"), charge: t("charge"), close: t("close") };
}

// ───────── سکوی ترکیبی ─────────
export type Rig = Readonly<{
  ledger: Ledger;
  store: AccountStore;
  clock: MutableClock;
  outbox: SettlementOutbox;
  durable: Ledger;
  sweeper: Sweeper;
}>;

export async function rig(o: { funds?: number; policy?: "forfeit" | "release"; grace?: number; maxAttempts?: number; retryDelayMs?: number; limit?: number; store?: AccountStore; base?: { ledger: Ledger; store: AccountStore; clock: MutableClock }; outbox?: SettlementOutbox; ledger?: (l: Ledger) => Ledger } = {}): Promise<Rig> {
  const f = o.base ?? (await fundedLedger(o.funds ?? 5_000, o.store));
  const raw = o.ledger?.(f.ledger) ?? f.ledger;
  const outbox = o.outbox ?? createMemoryOutbox();
  const d = createDurableLedger({ ledger: raw, outbox, clock: f.clock, graceMs: o.grace ?? GRACE, onUnknownCost: o.policy ?? "forfeit" });
  if (!d.ok) throw new Error(`createDurableLedger failed: ${d.error.issues.join("; ")}`);
  const s = createSettlementSweeper({ ledger: raw, outbox, clock: f.clock, ...(o.maxAttempts !== undefined ? { maxAttempts: o.maxAttempts } : {}), ...(o.retryDelayMs !== undefined ? { retryDelayMs: o.retryDelayMs } : {}), ...(o.limit !== undefined ? { limit: o.limit } : {}) });
  if (!s.ok) throw new Error(`createSettlementSweeper failed: ${s.error.issues.join("; ")}`);
  return { ledger: raw, store: f.store, clock: f.clock, outbox, durable: d.value, sweeper: s.value };
}

export const reserveInput = (id: string, amount = WORST, ttlMs = TTL) => ({ ...KEY, reservationId: id, unit: UNIT, amount, ttlMs });
export const chargeInput = (id: string, amount: number, attemptId = "a1") => ({ ...KEY, reservationId: id, attemptId, unit: UNIT, amount });
export const closeInput = (id: string, remainder: "release" | "forfeit") => ({ ...KEY, reservationId: id, remainder });

export function ok<T>(r: LedgerResult<T> | OutboxResult<T>): T {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
}

/** پیکربندی دروازهٔ ماندگار (MeteringConfig + outbox + clock + graceMs). */
export function durableConfig(raw: Ledger, gateway: Gateway, outbox: SettlementOutbox, clock: Clock, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gateway,
    ledger: raw,
    account: KEY,
    currency: "IRR",
    models: MODELS,
    scopeId: "scope-1",
    reservationTtlMs: TTL,
    maxProviderCalls: 1,
    perMessageOverheadTokens: 10,
    onUnknownCost: "forfeit",
    outbox,
    clock,
    graceMs: GRACE,
    ...over,
  };
}

// ───────── زمان‌سنج مجازی و رفتگر ساختگی (م۳‑ج، ADR-0023) ─────────
/** چند دورِ macrotask تا همهٔ ریزتیک‌های زنجیره‌های async (حلقه، رفتگر، مشاهده‌گر) تمام شوند. */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((res) => setImmediate(res));
}

export type ManualTimer = LoopTimer &
  Readonly<{
    clock: Clock;
    now(): number;
    /** زمان را جلو می‌برد و هر تایمرِ سررسیدشده را به ترتیب (زمان، شمارهٔ ثبت) اجرا و پس از هر کدام `flush` می‌کند. */
    advance(ms: number): Promise<void>;
    pending(): number;
    /** هر تأخیری که با `after` خواسته شد (به ترتیب). */
    delays: number[];
    cancelled: number;
    /** `n` فراخوانیِ بعدیِ `after` بپرتابد (پیام حاوی نشانهٔ نشت). */
    failAfter(n: number): void;
    failCancel(on: boolean): void;
    /** همهٔ تایمرهای آویزان را بدون اجرا نگه می‌دارد ولی `fire(id)` دستی را می‌دهد (برای تایمرِ کهنه/دوباره‌صدا). */
    fireAll(): void;
  }>;

export function manualTimer(start = 1_000_000): ManualTimer {
  let t = start;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const st = { throwAfter: 0, throwCancel: false };
  const delays: number[] = [];
  const timer = {
    delays,
    cancelled: 0,
    clock: { nowMs: () => t } as Clock,
    now: () => t,
    pending: () => queue.size,
    failAfter: (n: number) => void (st.throwAfter = n),
    failCancel: (on: boolean) => void (st.throwCancel = on),
    fireAll: () => {
      for (const [id, e] of [...queue]) {
        queue.delete(id);
        e.fn();
      }
    },
    after(fn: () => void, ms: number): unknown {
      delays.push(ms);
      if (st.throwAfter > 0) {
        st.throwAfter -= 1;
        throw new Error("boom: LEAK-CANARY-timer-9c1e");
      }
      seq += 1;
      queue.set(seq, { at: t + ms, fn });
      return seq;
    },
    cancel(h: unknown): void {
      timer.cancelled += 1;
      if (st.throwCancel) throw new Error("boom: LEAK-CANARY-cancel-9c1e");
      queue.delete(h as number);
    },
    async advance(ms: number): Promise<void> {
      const target = t + ms;
      for (let guard = 0; ; guard++) {
        if (guard > 20_000) throw new Error("advance: حلقهٔ بی‌پایان (تایمرِ بی‌وقفه)");
        let pick: number | null = null;
        for (const [id, e] of queue) if (e.at <= target && (pick === null || e.at < (queue.get(pick) as { at: number }).at)) pick = id;
        if (pick === null) break;
        const e = queue.get(pick) as { at: number; fn: () => void };
        queue.delete(pick);
        t = Math.max(t, e.at);
        e.fn();
        await flush();
      }
      t = target;
      await flush();
    },
  };
  return timer as unknown as ManualTimer;
}

export const sweepReport = (over: Partial<{ -readonly [K in keyof SweepReport]: SweepReport[K] }> = {}): SweepReport => ({ examined: 0, settled: 0, retryLater: 0, raced: 0, outboxFailures: 0, buried: [], listFailed: false, ...over });

export type FakeSweeper = Sweeper & Readonly<{ calls(): number; maxActive(): number }>;
/** رفتگر ساختگی: `step(n)` گزارش (یا هر مقدار دلخواه، یا `Error` برای پرتاب، یا Promise) برمی‌گرداند؛ هم‌زمانیِ بیشینه را می‌شمارد. */
export function fakeSweeper(step: (n: number) => unknown): FakeSweeper {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  return {
    async sweep(): Promise<SweepReport> {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const r = await step(calls);
        if (r instanceof Error) throw r;
        return r as SweepReport;
      } finally {
        active -= 1;
      }
    },
    calls: () => calls,
    maxActive: () => maxActive,
  };
}
