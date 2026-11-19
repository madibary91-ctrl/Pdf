/**
 * ابزار مشترک آزمون‌های settlement-runtime (از index صادر نمی‌شود؛ ماژول‌ها کمک‌تستِ یکدیگر را import نمی‌کنند).
 * زمان مجازی است: ساعتِ دفتر = ساعتِ زمان‌سنج ⇒ `timer.advance` هم‌زمان زمانِ دفتر و حلقه را جلو می‌برد.
 */
import { checkInvariants, createLedger, createMemoryStore } from "@/modules/ledger";
import type { Clock, Ledger } from "@/modules/ledger";
import { createDurableLedger, createMemoryOutbox } from "@/modules/settlement";
import type { LoopTimer, SettlementOutbox } from "@/modules/settlement";

export const TENANT = "tenant-r";
export const ACCOUNT = "acct-r";
export const KEY = { tenantId: TENANT, accountId: ACCOUNT };
export const UNIT = "IRR_MICROS";
export const GRACE = 10_000;
export const TTL = 60_000;
export const CANARY = "LEAK-CANARY-runtime-5d2f";
/** رشتهٔ اتصالِ ساختگیِ حاویِ رمز (برای آزمونِ نشت)؛ عمداً تکه‌تکه تا اسکنرِ اسرارِ مخزن آن را رمزِ واقعی نبیند. */
export const FAKE_DSN = ["post", "gres://user:", CANARY, "@host/db"].join("");
export const FUNDS = 200_000;
export const WORST = 314;

export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((res) => setImmediate(res));
}

export type ManualTimer = LoopTimer &
  Readonly<{
    clock: Clock;
    now(): number;
    pending(): number;
    delays: number[];
    cancelled(): number;
    failAfter(n: number): void;
    setNow(t: number): void;
    advance(ms: number): Promise<void>;
  }>;

export function manualTimer(start = 1_000_000): ManualTimer {
  let t = start;
  let seq = 0;
  let cancelled = 0;
  let throwAfter = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const delays: number[] = [];
  const timer = {
    delays,
    clock: { nowMs: () => t } as Clock,
    now: () => t,
    pending: () => queue.size,
    cancelled: () => cancelled,
    failAfter: (n: number) => void (throwAfter = n),
    setNow: (v: number) => void (t = v),
    after(fn: () => void, ms: number): unknown {
      delays.push(ms);
      if (throwAfter > 0) {
        throwAfter -= 1;
        throw new Error(`boom: ${CANARY}-timer`);
      }
      seq += 1;
      queue.set(seq, { at: t + ms, fn });
      return seq;
    },
    cancel(h: unknown): void {
      cancelled += 1;
      queue.delete(h as number);
    },
    async advance(ms: number): Promise<void> {
      const target = t + ms;
      for (let guard = 0; ; guard++) {
        if (guard > 20_000) throw new Error("advance: حلقهٔ بی‌پایان");
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

export function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
}

export type World = Awaited<ReturnType<typeof world>>;

/** دفتر و outbox حافظه‌ای + دفترِ ماندگار (مسیرِ درخواست) روی همان outbox. */
export async function world(opts: { timer?: ManualTimer; outbox?: SettlementOutbox; policy?: "forfeit" | "release" } = {}) {
  const timer = opts.timer ?? manualTimer();
  const store = createMemoryStore();
  const made = createLedger({ store, clock: timer.clock });
  if (!made.ok) throw new Error("createLedger failed");
  const ledger: Ledger = made.value;
  must(await ledger.openAccount({ ...KEY, unit: UNIT }));
  must(await ledger.grant({ ...KEY, grantId: "g0", unit: UNIT, amount: FUNDS, source: "purchase" }));
  const outbox = createMemoryOutbox();
  const used = opts.outbox ?? outbox;
  const d = createDurableLedger({ ledger, outbox: used, clock: timer.clock, graceMs: GRACE, onUnknownCost: opts.policy ?? "forfeit" });
  if (!d.ok) throw new Error(`createDurableLedger failed: ${d.error.issues.join(";")}`);
  return { timer, store, ledger, outbox: used, durable: d.value };
}

export const reserveInput = (id: string, amount = WORST, ttlMs = TTL) => ({ ...KEY, reservationId: id, unit: UNIT, amount, ttlMs });

export async function balance(ledger: Ledger) {
  const b = await ledger.balance(KEY);
  if (!b.ok) throw new Error(`balance failed: ${b.error.code}`);
  return b.value;
}

/** ناوردای پول: بقا و `checkInvariants` روی حالتِ ماندگار. */
export async function audit(store: ReturnType<typeof createMemoryStore>): Promise<void> {
  const state = await store.read(KEY);
  if (state === null) throw new Error("حساب نیست");
  const v = checkInvariants(state);
  if (v.length > 0) throw new Error(`ناوردا شکست: ${v.join("; ")}`);
  const t = state.totals;
  if (state.available + state.held + t.charged + t.forfeited !== t.granted) throw new Error("بقا شکست");
}

export type OutboxPlan = Partial<Record<"claimDue" | "listUnacknowledgedDead" | "acknowledgeDead" | "recordFailure", { fail: number; mode?: "result" | "throw" }>>;

/** پوششِ outbox که ثبتِ فراخوانی می‌کند و برای متدهای نام‌برده شکستِ تزریقی می‌دهد (`fail` فراخوانیِ نخست). */
export function tracedOutbox(real: SettlementOutbox, plan: OutboxPlan = {}) {
  const count: Record<string, number> = {};
  const claims: { nowMs: number; limit: number; leaseMs: number }[] = [];
  const wrapped: Record<string, unknown> = { ...real };
  for (const name of ["claimDue", "listUnacknowledgedDead", "acknowledgeDead", "recordFailure"] as const) {
    wrapped[name] = async (...args: unknown[]) => {
      count[name] = (count[name] ?? 0) + 1;
      if (name === "claimDue") claims.push(args[0] as { nowMs: number; limit: number; leaseMs: number });
      const p = plan[name];
      if (p !== undefined && (count[name] as number) <= p.fail) {
        if (p.mode === "throw") throw new Error(`boom: ${CANARY}-${name}`);
        return { ok: false, error: { code: "STORE_FAILURE", message: CANARY } };
      }
      return (real as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(...args);
    };
  }
  return Object.assign(wrapped as unknown as SettlementOutbox & { claimDue: (q: unknown) => Promise<unknown> }, { count, claims, plan });
}

/** رزروِ یتیمِ فرایندِ مرده: فقط رزرو (بی‌ثبتِ هزینه) و بی‌هیچ `sweep` دستی. */
export async function orphan(w: World, id: string): Promise<void> {
  must(await w.durable.reserve(reserveInput(id)));
}
