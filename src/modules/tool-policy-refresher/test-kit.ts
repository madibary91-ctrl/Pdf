/** ابزار مشترکِ آزمون‌های tool-policy-refresher (از index صادر نمی‌شود). */
import type { RefreshableSource, RefresherOptions, RefreshTimer } from "./types";

export const INTERVAL = 10_000;
export const RETRY = 2_000;
export const DEADLINE = 6_000;
export const REFRESH_TIMEOUT = 5_000;
export const MAX_STALE = 60_000;

export type FakeTimerOptions = Readonly<{ throwOnAfter?: (ms: number, call: number) => boolean; leakyCancel?: boolean; throwOnCancel?: boolean }>;

/** زمان‌سنجِ مجازی: `advance` رویدادها را به ترتیبِ زمان (و تازه‌ساخته‌ها را هم) اجرا می‌کند. */
export function fakeTimer(opts: FakeTimerOptions = {}) {
  let now = 0;
  let seq = 0;
  let calls = 0;
  const q = new Map<object, { at: number; fn: () => void; seq: number }>();
  const timer: RefreshTimer = {
    after(fn, ms) {
      calls += 1;
      if (opts.throwOnAfter?.(ms, calls)) throw new Error("secret-timer-failure");
      const h = { id: seq };
      q.set(h, { at: now + ms, fn, seq: seq++ });
      return h;
    },
    cancel(h) {
      if (opts.throwOnCancel) throw new Error("secret-cancel-failure");
      if (opts.leakyCancel) return;
      if (typeof h === "object" && h !== null) q.delete(h);
    },
  };
  const nextDue = (): [object, { at: number; fn: () => void; seq: number }] | null => {
    let best: [object, { at: number; fn: () => void; seq: number }] | null = null;
    for (const e of q) if (best === null || e[1].at < best[1].at || (e[1].at === best[1].at && e[1].seq < best[1].seq)) best = e;
    return best;
  };
  return {
    timer,
    now: (): number => now,
    pending: (): number => q.size,
    delays: (): number[] => [...q.values()].map((e) => e.at - now).sort((a, b) => a - b),
    afterCalls: (): number => calls,
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const e = nextDue();
        if (e === null || e[1].at > end) break;
        q.delete(e[0]);
        now = Math.max(now, e[1].at);
        e[1].fn();
      }
      now = end;
    },
    /** همهٔ زمان‌سنج‌های باقی‌مانده را (حتی اگر cancel نشت کرده باشد) فوراً اجرا می‌کند (برای آزمونِ تیک‌های کهنه). */
    fireAll(): void {
      for (const [h, e] of [...q]) {
        q.delete(h);
        e.fn();
      }
    },
  };
}

type Call = { id: number; resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** منبعی که هر `refresh` را یک وعدهٔ دستی می‌دهد. */
export function controlledSource() {
  const pending: Call[] = [];
  let calls = 0;
  const source: RefreshableSource = {
    refresh: () =>
      new Promise<unknown>((resolve, reject) => {
        calls += 1;
        pending.push({ id: calls, resolve, reject });
      }),
  };
  return {
    source,
    calls: (): number => calls,
    pending,
    last: (): Call => pending[pending.length - 1]!,
  };
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

export const okResult = { ok: true, value: { outcome: "updated", version: 1 } } as const;
export const failResult = (code: string): unknown => ({ ok: false, error: { code, message: "x" } });

export function goodOptions(source: RefreshableSource, timer: RefreshTimer, extra: Partial<Record<keyof RefresherOptions, unknown>> = {}): RefresherOptions {
  return { source, timer, intervalMs: INTERVAL, retryMs: RETRY, attemptDeadlineMs: DEADLINE, refreshTimeoutMs: REFRESH_TIMEOUT, maxStaleMs: MAX_STALE, ...extra } as RefresherOptions;
}

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
