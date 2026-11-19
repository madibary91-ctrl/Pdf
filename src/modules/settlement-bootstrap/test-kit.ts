/**
 * ابزار مشترک آزمون‌های settlement-bootstrap (از index صادر نمی‌شود؛ ماژول‌ها کمک‌تستِ یکدیگر را import نمی‌کنند).
 * زمان مجازی؛ سیگنال ساختگی (مگر آزمونِ صریحِ «سیگنالِ واقعی»)؛ پایگاهِ ساختگی که همیشه خراب است یا همیشه نامعتبر.
 */
import type { BootstrapEvent, OpenedDatabase } from "./types";

export const CANARY = "LEAK-CANARY-bootstrap-3d9f";
/** رشتهٔ اتصالِ دارای قناری؛ قطعه‌قطعه ساخته می‌شود تا خودِ آزمون «راز» نباشد (هوکِ بهداشتِ گیت). */
export const SECRET_URL: string = ["postgres", "://user:", CANARY, "@127.0.0.1:1/db"].join("");

export async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((res) => setImmediate(res));
}

export type ManualTimer = Readonly<{
  after(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  delays: number[];
  pending(): number;
  advance(ms: number): Promise<void>;
}>;

export function manualTimer(): ManualTimer {
  let now = 0;
  let seq = 0;
  const delays: number[] = [];
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    after(fn, ms) {
      delays.push(ms);
      const id = ++seq;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(handle) {
      queue.delete(handle as number);
    },
    delays,
    pending: () => queue.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        queue.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await flush(4);
      }
      now = target;
      await flush(4);
    },
  };
}

export type FakeSignals = Readonly<{
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  emit(signal: "SIGTERM" | "SIGINT"): void;
  count(): number;
}>;

export function fakeSignals(): FakeSignals {
  const map = new Map<string, Set<() => void>>();
  const set = (s: string): Set<() => void> => {
    let v = map.get(s);
    if (v === undefined) map.set(s, (v = new Set()));
    return v;
  };
  return {
    on: (s, l) => set(s).add(l),
    off: (s, l) => set(s).delete(l),
    emit: (s) => {
      for (const l of [...set(s)]) l();
    },
    count: () => [...map.values()].reduce((n, v) => n + v.size, 0),
  };
}

/**
 * «پایگاهِ مرده»: ساختارِ drizzle (execute/transaction) که هر پرسش را رد می‌کند ⇒ پیش‌بازرسیِ runtime ⇒ UNAVAILABLE.
 * پیامِ خطا عمداً رشتهٔ اتصالِ دارای قناری است تا نشتش به لاگ/نتیجه دیده شود.
 */
export function deadDatabase(): { opened: OpenedDatabase; closed(): number; executes(): number } {
  let closed = 0;
  let executes = 0;
  const boom = async (): Promise<never> => {
    executes++;
    throw new Error(`connect ECONNREFUSED ${SECRET_URL}`);
  };
  return {
    opened: {
      db: { execute: boom, transaction: boom },
      close: () => {
        closed++;
      },
    },
    closed: () => closed,
    executes: () => executes,
  };
}

export function collector(): { log: (e: BootstrapEvent) => void; events: BootstrapEvent[] } {
  const events: BootstrapEvent[] = [];
  return { log: (e) => void events.push(e), events };
}

export const ON_ENV = Object.freeze({ SETTLEMENT_HOST: "on", SETTLEMENT_GRACE_MS: "300000" });
