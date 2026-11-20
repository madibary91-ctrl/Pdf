/**
 * کمک‌تستِ settlement-backlog-watch (فقط برای تست‌ها؛ از index صادر نمی‌شود): ساعت و زمان‌سنجِ مجازی، outboxهای ساختگی، رکوردِ مردهٔ معتبر.
 * زمان مجازی است ⇒ هیچ آزمونی به ساعتِ دیوار یا حاشیهٔ زمانیِ واقعی تکیه نمی‌کند (درسِ ADR-0041).
 */
import { createMemoryOutbox } from "@/modules/settlement";
import type { DeadReason, LoopTimer, OutboxEntry, OutboxResult, SettlementOutbox } from "@/modules/settlement";
import { createBacklogWatch } from "./index";
import type { BacklogWatch } from "./index";

export const T0 = 10_000_000;
export const HOUR = 3_600_000;

export type ManualClock = { now: number; nowMs(): number };
export function manualClock(start = T0): ManualClock {
  const c: ManualClock = { now: start, nowMs: () => c.now };
  return c;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

type Rec = { at: number; fn: () => void; cancelled: boolean };
export type Virtual = {
  clock: ManualClock;
  timer: LoopTimer;
  /** شمارِ زمان‌سنج‌های ساخته‌شده / لغوشده (برای آزمونِ نشتِ تایمر). */
  stats: { created: number; cancelled: number };
  pending(): number;
  advance(ms: number): Promise<void>;
  settle(): Promise<void>;
};
export function virtual(start = T0): Virtual {
  const clock = manualClock(start);
  const q: Rec[] = [];
  const stats = { created: 0, cancelled: 0 };
  const timer: LoopTimer = {
    after(fn, ms) {
      stats.created += 1;
      const rec: Rec = { at: clock.now + ms, fn, cancelled: false };
      q.push(rec);
      return rec;
    },
    cancel(h) {
      stats.cancelled += 1;
      (h as Rec).cancelled = true;
    },
  };
  return {
    clock,
    timer,
    stats,
    pending: () => q.filter((r) => !r.cancelled).length,
    settle: flush,
    async advance(ms) {
      const target = clock.now + ms;
      await flush();
      for (;;) {
        const live = q.filter((r) => !r.cancelled).sort((a, b) => a.at - b.at);
        const next = live[0];
        if (next === undefined || next.at > target) break;
        q.splice(q.indexOf(next), 1);
        clock.now = Math.max(clock.now, next.at);
        next.fn();
        await flush();
      }
      clock.now = target;
      await flush();
    },
  };
}

export const REF = (n: number) => ({ tenantId: "t1", accountId: "a1", reservationId: `r${n}` });

/** رکوردِ مردهٔ معتبر (شکلِ OutboxEntry)؛ `over` برای ساختنِ انحراف. */
export function deadEntry(n: number, over: Record<string, unknown> = {}): OutboxEntry {
  return {
    tenantId: "t1",
    accountId: "a1",
    reservationId: `r${n}`,
    unit: "IRR_MICROS",
    reserved: 500,
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
    dueAtMs: 11_000,
    orphanRemainder: "forfeit",
    state: "dead",
    charge: null,
    close: null,
    attempts: 3,
    lastErrorCode: null,
    deadReason: "ATTEMPTS_EXHAUSTED" as DeadReason,
    settledAtMs: T0 - 100,
    ...over,
  } as OutboxEntry;
}

export const okList = (entries: readonly OutboxEntry[]): OutboxResult<readonly OutboxEntry[]> => ({ ok: true, value: entries });

/** outboxی که فقط `listUnacknowledgedDead` دارد و هر بار `answer` را صدا می‌زند (می‌تواند بپرتابد، رد کند یا هرگز تمام نشود). */
export function listOutbox(answer: (query: { limit: number }) => unknown): {
  listUnacknowledgedDead: (q: { limit: number }) => Promise<OutboxResult<readonly OutboxEntry[]>>;
  calls: Array<{ limit: number }>;
} {
  const calls: Array<{ limit: number }> = [];
  return {
    calls,
    listUnacknowledgedDead: (q) => {
      calls.push({ ...q });
      return answer(q) as Promise<OutboxResult<readonly OutboxEntry[]>>;
    },
  };
}

/** outboxِ قابل‌تنظیم: `state.list` را هر لحظه می‌شود عوض کرد؛ `state.mode` رفتارِ پاسخ را. */
export function scriptedOutbox(): {
  outbox: ReturnType<typeof listOutbox>;
  state: { list: OutboxEntry[]; mode: "ok" | "fail" | "reject" | "hang" | "bad" };
} {
  const state: { list: OutboxEntry[]; mode: "ok" | "fail" | "reject" | "hang" | "bad" } = { list: [], mode: "ok" };
  const outbox = listOutbox(() => {
    if (state.mode === "fail") return Promise.resolve({ ok: false, error: { code: "STORE_UNAVAILABLE" } });
    if (state.mode === "reject") return Promise.reject(new Error("SECRET-DB-DOWN postgres://u:p@127.0.0.1/db"));
    if (state.mode === "hang") return new Promise(() => undefined);
    if (state.mode === "bad") return Promise.resolve({ ok: true, value: "nope" });
    return Promise.resolve(okList([...state.list]));
  });
  return { outbox, state };
}

export function must<T>(r: { ok: true; value: T } | { ok: false; error: { issues?: readonly string[]; code: string } }): T {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code} ${(r.error.issues ?? []).join("; ")}`);
  return r.value;
}

/** مقیاسِ آزمونی: فاصله ۱۰۰۰، مهلت ۵۰۰ ⇒ کهنگیِ پیش‌فرض ۴۰۰۰. آستانه‌های پیش‌فرضِ ماژول (۱/۱۰/۱ساعت/۲۴ساعت) دست‌نخورده‌اند. */
export const FAST = Object.freeze({ intervalMs: 1_000, timeoutMs: 500 });

export type World = Virtual & { watch: BacklogWatch; outbox: unknown };
export function world(over: Record<string, unknown> = {}, outbox: unknown = createMemoryOutbox(), start = T0): World {
  const v = virtual(start);
  const watch = must(createBacklogWatch({ outbox, clock: v.clock, timer: v.timer, ...FAST, ...over }));
  return { ...v, watch, outbox };
}

/** در outbox حافظه‌ای `n` رکورد باز می‌کند و همه را در زمانِ `atMs(i)` می‌میراند. */
export async function buryMany(outbox: SettlementOutbox, n: number, atMs: (i: number) => number = () => T0 - 100): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const b = await outbox.begin({ ...REF(i), unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" });
    if (!b.ok) throw new Error(`begin: ${b.error.code}`);
    const d = await outbox.bury(REF(i), { reason: "ATTEMPTS_EXHAUSTED", errorCode: null, atMs: atMs(i) });
    if (!d.ok) throw new Error(`bury: ${d.error.code}`);
  }
}

export async function ackMany(outbox: SettlementOutbox, n: number, atMs: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const a = await outbox.acknowledgeDead(REF(i), { atMs });
    if (!a.ok) throw new Error(`ack: ${a.error.code}`);
  }
}
