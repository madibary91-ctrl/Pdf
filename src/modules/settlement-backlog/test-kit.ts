/**
 * کمک‌تستِ settlement-backlog (فقط برای تست‌ها؛ از index صادر نمی‌شود): ساعت و زمان‌سنجِ دستی، رکوردِ مردهٔ ساختگی، outboxهای خراب و آستانه‌های نمونه.
 */
import type { DeadReason, LoopTimer, OutboxEntry, OutboxResult, SettlementOutbox } from "@/modules/settlement";
import { createMemoryOutbox } from "@/modules/settlement";
import type { BacklogClock, BacklogMonitor, BacklogMonitorConfig } from "./types";
import { createDeadLetterBacklogMonitor } from "./index";

export const T0 = 1_000_000;

export type ManualClock = BacklogClock & { now: number; advance(ms: number): void };
export function manualClock(start = T0): ManualClock {
  const c = {
    now: start,
    nowMs: () => c.now,
    advance(ms: number) {
      c.now += ms;
    },
  };
  return c;
}

export type ManualTimer = LoopTimer & { scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean; fired: boolean }>; cancels: number; fireAll(): void };
export function manualTimer(): ManualTimer {
  const t: ManualTimer = {
    scheduled: [],
    cancels: 0,
    after(fn, ms) {
      const rec = { fn, ms, cancelled: false, fired: false };
      t.scheduled.push(rec);
      return rec;
    },
    cancel(h) {
      t.cancels += 1;
      (h as { cancelled: boolean }).cancelled = true;
    },
    fireAll() {
      for (const r of t.scheduled) {
        if (!r.cancelled && !r.fired) {
          r.fired = true;
          r.fn();
        }
      }
    },
  };
  return t;
}

/** آستانه‌های نمونه: شمار ۳/۵، سن ۱۰۰۰/۵۰۰۰ میلی‌ثانیه، نمونه تا ۲۰۰۰ تازه است، سقفِ خواندن ۱۰. */
export const TH = Object.freeze({ degradedCount: 3, downCount: 5, degradedAfterMs: 1_000, downAfterMs: 5_000, sampleMaxAgeMs: 2_000, sampleLimit: 10 });

export function must<T>(r: { ok: true; value: T } | { ok: false; error: { issues?: readonly string[]; code: string } }): T {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code} ${(r.error.issues ?? []).join("; ")}`);
  return r.value;
}

export function monitorOf(over: Record<string, unknown> = {}, outbox: unknown = createMemoryOutbox(), clock: BacklogClock = manualClock()): BacklogMonitor {
  return must(createDeadLetterBacklogMonitor({ outbox, clock, ...TH, ...over }));
}

export const ok = <T>(value: T): OutboxResult<T> => ({ ok: true, value });

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

/** outboxی که فقط `listUnacknowledgedDead` دارد و هر بار خروجیِ `answer` را برمی‌گرداند (می‌تواند بپرتابد). */
export function listOutbox(answer: (query: { limit: number }) => unknown): { listUnacknowledgedDead: (q: { limit: number }) => Promise<OutboxResult<readonly OutboxEntry[]>>; calls: Array<{ limit: number }> } {
  const calls: Array<{ limit: number }> = [];
  return {
    calls,
    listUnacknowledgedDead: (q) => {
      calls.push({ ...q });
      return answer(q) as Promise<OutboxResult<readonly OutboxEntry[]>>;
    },
  };
}

export const REF = (n: number) => ({ tenantId: "t1", accountId: "a1", reservationId: `r${n}` });

/** در outbox حافظه‌ای `n` رکورد باز می‌کند و همه را در زمانِ `atMs(i)` می‌میراند. */
export async function buryMany(outbox: SettlementOutbox, n: number, atMs: (i: number) => number = () => T0 - 100, reason: DeadReason = "ATTEMPTS_EXHAUSTED"): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const b = await outbox.begin({ ...REF(i), unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" });
    if (!b.ok) throw new Error(`begin: ${b.error.code}`);
    const d = await outbox.bury(REF(i), { reason, errorCode: null, atMs: atMs(i) });
    if (!d.ok) throw new Error(`bury: ${d.error.code}`);
  }
}

export type { BacklogMonitorConfig };
