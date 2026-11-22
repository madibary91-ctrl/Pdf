/**
 * ابزار مشترک آزمون‌های settlement-pending-migrate (از index صادر نمی‌شود؛ ماژول‌ها کمک‌تستِ یکدیگر را import نمی‌کنند).
 * نمایهٔ ساختگیِ اسکریپت‌پذیر (با ثبتِ ترتیبِ فراخوانی)، زمان‌سنجِ مجازی و قناریِ نشت.
 */
import type { LedgerDatabase } from "@/modules/ledger";
import type { PendingVerifyReport } from "@/modules/settlement-pending";
import { runPendingMigrate } from "./cli";
import type { IndexResult, PendingMigratable, PendingMigrateOutcome, PendingMigratePorts } from "./types";

export const CANARY = "LEAK-CANARY-pending-migrate-3f9a";
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
      now += ms;
      for (const [id, t] of [...queue].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && queue.delete(id)) t.fn();
      }
      await flush();
    },
  };
}

export const MIGRATION = "0001_dead_pending";
export const okStatus = (applied: readonly string[], pending: readonly string[]) => ({ ok: true as const, value: { applied, pending } });
export const okMigrate = (applied: readonly string[]) => ({ ok: true as const, value: { applied, alreadyApplied: [] as string[] } });
export const okDown = (reverted: readonly string[]) => ({ ok: true as const, value: { reverted } });
export const okVerify = (o: Partial<PendingVerifyReport> = {}) => {
  const base = { expected: 3, indexed: 3, missing: 0, stale: 0, ...o };
  return { ok: true as const, value: { consistent: base.missing === 0 && base.stale === 0, ...base } };
};
/** خطای فروشگاه؛ `message` عمداً قناری دارد تا هر نشت دیده شود. */
export const storeErr = (code: string, pgCode?: string) => ({ ok: false as const, error: { code, message: CANARY, ...(pgCode === undefined ? {} : { pgCode }) } });

type Step = unknown | (() => unknown);
export type Script = Readonly<{ status?: readonly Step[]; migrate?: readonly Step[]; verify?: readonly Step[]; down?: readonly Step[]; touchDb?: boolean }>;

/** نمایهٔ ساختگی: گام‌ها به ترتیب مصرف می‌شوند و آخری تکرار می‌شود؛ تابع‌بودنِ گام = اجرا (می‌تواند بپرتابد یا آویزان بماند). */
export function fakeIndex(calls: string[], script: Script, db: LedgerDatabase): PendingMigratable {
  const counters = { status: 0, migrate: 0, verify: 0, down: 0 };
  const next = async (kind: "status" | "migrate" | "verify" | "down", steps: readonly Step[] | undefined, fallback: unknown): Promise<unknown> => {
    calls.push(kind);
    if (script.touchDb !== false) await db.execute({} as never);
    const list = steps ?? [fallback];
    const step = list[Math.min(counters[kind]++, list.length - 1)];
    return typeof step === "function" ? (step as () => unknown)() : step;
  };
  return {
    status: () => next("status", script.status, okStatus([MIGRATION], [])) as never,
    migrate: () => next("migrate", script.migrate, okMigrate([])) as never,
    verify: () => next("verify", script.verify, okVerify()) as never,
    down: () => next("down", script.down, okDown([MIGRATION])) as never,
  };
}

export type World = Readonly<{
  calls: string[];
  lines: string[];
  timer: ManualTimer;
  opened: { count: number; closed: number };
  created: Array<Readonly<{ schema: string | null; readStatementTimeoutMs: number }>>;
  ports: PendingMigratePorts;
  run(argv: unknown, env?: unknown): Promise<PendingMigrateOutcome>;
}>;

export const BASE_ENV: Readonly<Record<string, string>> = Object.freeze({ DATABASE_URL: SECRET_URL });

export function world(script: Script = {}, opts: { open?: PendingMigratePorts["open"]; closeHangs?: boolean; createIndex?: PendingMigratePorts["createIndex"] } = {}): World {
  const calls: string[] = [];
  const lines: string[] = [];
  const timer = manualTimer();
  const opened = { count: 0, closed: 0 };
  const created: Array<Readonly<{ schema: string | null; readStatementTimeoutMs: number }>> = [];
  const open: PendingMigratePorts["open"] =
    opts.open ??
    (() => {
      opened.count++;
      return {
        db: { execute: () => Promise.resolve({ rows: [] }), transaction: () => Promise.resolve(undefined) },
        close: () => {
          opened.closed++;
          return opts.closeHangs === true ? new Promise<void>(() => undefined) : undefined;
        },
      };
    });
  const createIndex =
    opts.createIndex ??
    ((db: LedgerDatabase, options: Readonly<{ schema: string | null; readStatementTimeoutMs: number }>): IndexResult => {
      created.push(options);
      return { ok: true, index: fakeIndex(calls, script, db) };
    });
  const ports: PendingMigratePorts = { open, timer, write: (l) => lines.push(l), createIndex };
  return { calls, lines, timer, opened, created, ports, run: (argv, env = BASE_ENV) => runPendingMigrate({ argv, env, ports }) };
}
