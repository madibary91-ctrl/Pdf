/** ابزار مشترکِ آزمون‌های tool-policy-runtime (از index صادر نمی‌شود). */
import type { RefresherStatus } from "@/modules/tool-policy-refresher";
import type { SnapshotResult, SourceHealth } from "@/modules/tool-policy-source";
import type { PreflightResult } from "./types";

export const DEADLINE = 6_000;
export const SECRET = "postgres://user:s3cr3t-pass@db.internal/app";

export type Deferred<T> = { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void };
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** چند چرخهٔ میکروتسک تا وعده‌های معلق جلو بروند. */
export async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

export type FakeTimerOptions = Readonly<{ throwOnAfter?: boolean; throwOnCancel?: boolean }>;
export function fakeTimer(opts: FakeTimerOptions = {}) {
  let now = 0;
  let seq = 0;
  const live = new Map<object, { at: number; fn: () => void }>();
  const log: { ms: number; cancelled: boolean }[] = [];
  const handles = new Map<object, { ms: number; cancelled: boolean }>();
  return {
    timer: {
      after(fn: () => void, ms: number): unknown {
        if (opts.throwOnAfter) throw new Error(SECRET);
        const h = { id: seq++ };
        live.set(h, { at: now + ms, fn });
        const rec = { ms, cancelled: false };
        log.push(rec);
        handles.set(h, rec);
        return h;
      },
      cancel(h: unknown): void {
        if (opts.throwOnCancel) throw new Error(SECRET);
        if (typeof h === "object" && h !== null) {
          const rec = handles.get(h);
          if (rec) rec.cancelled = true;
          live.delete(h);
        }
      },
    },
    log,
    pending: (): number => live.size,
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let best: [object, { at: number; fn: () => void }] | null = null;
        for (const e of live) if (best === null || e[1].at < best[1].at) best = e;
        if (best === null || best[1].at > end) break;
        live.delete(best[0]);
        now = Math.max(now, best[1].at);
        best[1].fn();
      }
      now = end;
    },
  };
}

export const freshSource = (over: Partial<SourceHealth> = {}): SourceHealth => ({
  state: "FRESH",
  version: 3,
  ageMs: 10,
  drift: false,
  consecutiveFailures: 0,
  lastFailure: null,
  lastAttemptAtMs: 1,
  lastSuccessAtMs: 1,
  ...over,
});

export const refresherStatus = (over: Partial<RefresherStatus> = {}): RefresherStatus => ({
  state: "running",
  haltReason: null,
  inFlight: false,
  attempts: 1,
  consecutiveFailures: 0,
  lastOutcome: "ok",
  lastFailure: null,
  ...over,
});

export type PortsOptions = Readonly<{
  timer?: FakeTimerOptions;
  preflight?: () => Promise<unknown>;
}>;

/** پورت‌های ساختگی با رفتارِ قابل‌تنظیم و شمارنده. */
export function makePorts(opts: PortsOptions = {}) {
  const ft = fakeTimer(opts.timer);
  const s = {
    preflightCalls: 0,
    startCalls: 0,
    stopCalls: 0,
    running: false,
    startWhileRunning: 0,
    startResult: (): unknown => ({ started: true }),
    stopResult: (): Promise<unknown> => Promise.resolve({ stopped: true, abandonedInFlight: false }),
    sourceHealth: (): SourceHealth => freshSource(),
    refresherStatus: (): RefresherStatus => refresherStatus(),
    snapshot: (): SnapshotResult => ({ ok: true, value: { version: 3 } as never }),
    preflight: opts.preflight ?? ((): Promise<unknown> => Promise.resolve({ ok: true } as PreflightResult)),
  };
  const ports = {
    preflight: (): Promise<unknown> => {
      s.preflightCalls += 1;
      return s.preflight();
    },
    source: {
      snapshot: (): SnapshotResult => s.snapshot(),
      health: (): SourceHealth => s.sourceHealth(),
    },
    refresher: {
      start: (): unknown => {
        s.startCalls += 1;
        if (s.running) s.startWhileRunning += 1;
        const r = s.startResult();
        if (typeof r === "object" && r !== null && (r as { started?: unknown }).started === true) s.running = true;
        return r;
      },
      stop: (): Promise<unknown> => {
        s.stopCalls += 1;
        s.running = false;
        return s.stopResult();
      },
      status: (): RefresherStatus => s.refresherStatus(),
    },
    timer: ft.timer,
    preflightDeadlineMs: DEADLINE,
  };
  return { ports, s, ft };
}
