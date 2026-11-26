/**
 * ابزار مشترک آزمون‌های tool-policy-host (از index صادر نمی‌شود؛ ماژول‌ها کمک‌تستِ یکدیگر را import نمی‌کنند).
 * زمان مجازی است؛ سیگنال و `process` ساختگی‌اند؛ هیچ سیگنالِ واقعی ارسال نمی‌شود.
 */
import type { HostEvent, HostTimer, RuntimePort, SignalSource } from "./types";

export const CANARY = "LEAK-CANARY-policy-host-5d2a";

export async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((res) => setImmediate(res));
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export type ManualTimer = HostTimer &
  Readonly<{
    now(): number;
    pending(): number;
    delays: number[];
    cancelled(): number;
    /** `after`ِ n فراخوانیِ بعدی می‌پرتابد. */
    failAfter(n: number): void;
    advance(ms: number): Promise<void>;
  }>;

export function manualTimer(): ManualTimer {
  let t = 1_000_000;
  let seq = 0;
  let cancelled = 0;
  let throwAfter = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const delays: number[] = [];
  const timer = {
    delays,
    now: () => t,
    pending: () => queue.size,
    cancelled: () => cancelled,
    failAfter: (n: number) => void (throwAfter = n),
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

export type StartValue = unknown;

export type FakeRuntime = RuntimePort &
  Readonly<{
    log: string[];
    calls: { start: number; stop: number; health: number };
    /** هر فراخوانیِ `start` یک عنصر مصرف می‌کند (تابع ⇒ صدا زده می‌شود)؛ پس از تمام‌شدن: موفقیت. */
    startQueue: unknown[];
    impl: { stop: () => unknown; health: () => unknown };
  }>;

export function fakeRuntime(log: string[] = []): FakeRuntime {
  const calls = { start: 0, stop: 0, health: 0 };
  const startQueue: unknown[] = [];
  const impl = {
    stop: (): unknown => ({ stopped: true, abandonedInFlight: false }),
    health: (): unknown => ({ state: "RUNNING", ready: true, reason: null, source: null, refresher: null }),
  };
  const rt = {
    log,
    calls,
    startQueue,
    impl,
    start(): Promise<unknown> {
      calls.start += 1;
      log.push("start");
      const next = startQueue.length > 0 ? startQueue.shift() : { started: true };
      try {
        const v = typeof next === "function" ? (next as () => unknown)() : next;
        return Promise.resolve(v);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    stop(): Promise<unknown> {
      calls.stop += 1;
      log.push("stop");
      try {
        return Promise.resolve(impl.stop());
      } catch (e) {
        return Promise.reject(e);
      }
    },
    health(): unknown {
      calls.health += 1;
      return impl.health();
    },
  };
  return rt as unknown as FakeRuntime;
}

export const unavailable = { started: false, reason: "UNAVAILABLE" };
export const notMigrated = { started: false, reason: "NOT_MIGRATED" };

export type FakeSignals = SignalSource &
  Readonly<{
    count(sig?: string): number;
    emit(sig: string): number;
    /** `on`ِ فراخوانیِ n‌ام (۱-مبنا) می‌پرتابد. */
    failOnNth(n: number): void;
    offCalls(): number;
    breakOff(): void;
  }>;

export function fakeSignals(log: string[] = []): FakeSignals {
  const map = new Map<string, Set<() => void>>();
  let onCalls = 0;
  let failNth = 0;
  let offCalls = 0;
  let offBroken = false;
  const api = {
    count: (sig?: string): number => (sig === undefined ? [...map.values()].reduce((a, s) => a + s.size, 0) : (map.get(sig)?.size ?? 0)),
    emit(sig: string): number {
      const ls = [...(map.get(sig) ?? [])];
      for (const l of ls) l();
      return ls.length;
    },
    failOnNth: (n: number) => void (failNth = n),
    offCalls: () => offCalls,
    breakOff: () => void (offBroken = true),
    on(sig: string, l: () => void): unknown {
      onCalls += 1;
      if (failNth > 0 && onCalls === failNth) throw new Error(`boom: ${CANARY}-on`);
      log.push(`signals.on:${sig}`);
      if (!map.has(sig)) map.set(sig, new Set());
      map.get(sig)?.add(l);
      return undefined;
    },
    off(sig: string, l: () => void): unknown {
      offCalls += 1;
      if (offBroken) throw new Error(`boom: ${CANARY}-off`);
      log.push(`signals.off:${sig}`);
      map.get(sig)?.delete(l);
      return undefined;
    },
  };
  return api as unknown as FakeSignals;
}

export type Rig = ReturnType<typeof rig>;

/** میزبانِ آزمون با همهٔ وابستگی‌های ساختگی؛ `over` هر کلیدِ پیکربندی را بازنویسی می‌کند. */
export function rig(over: Record<string, unknown> = {}) {
  const log: string[] = [];
  const runtime = fakeRuntime(log);
  const timer = manualTimer();
  const signals = fakeSignals(log);
  const exits: number[] = [];
  const events: HostEvent[] = [];
  const closes = { n: 0 };
  const config: Record<string, unknown> = {
    runtime,
    timer,
    signals,
    exit: (code: number) => {
      log.push(`exit:${code}`);
      exits.push(code);
    },
    closeResources: () => {
      closes.n += 1;
      log.push("close");
    },
    observer: (e: HostEvent) => void events.push(e),
    ...over,
  };
  return { log, runtime, timer, signals, exits, events, closes, config };
}

export const KEYS_OF = (o: object): string[] => Object.keys(o).sort();
