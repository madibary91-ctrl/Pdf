/**
 * ابزار مشترک آزمون‌های settlement-migrate (از index صادر نمی‌شود؛ ماژول‌ها کمک‌تستِ یکدیگر را import نمی‌کنند).
 * فروشگاهِ ساختگیِ اسکریپت‌پذیر (با ثبتِ ترتیبِ فراخوانی)، زمان‌سنجِ مجازی و قناریِ نشت.
 */
import type { LedgerDatabase } from "@/modules/ledger";
import { runSettlementMigrate } from "./cli";
import type { MigratableStore, MigrateOutcome, MigratePorts, MigrateStage, StoresResult } from "./types";

export const CANARY = "LEAK-CANARY-migrate-7c1e";
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

export const okStatus = (applied: readonly string[], pending: readonly string[]) => ({ ok: true as const, value: { applied, pending } });
export const okMigrate = (applied: readonly string[]) => ({ ok: true as const, value: { applied, alreadyApplied: [] as string[] } });
/** خطای فروشگاه؛ `message` عمداً قناری دارد تا هر نشت دیده شود. */
export const storeErr = (code: string, pgCode?: string) => ({ ok: false as const, error: { code, message: CANARY, ...(pgCode === undefined ? {} : { pgCode }) } });

type Step = unknown | (() => unknown);
export type Script = Readonly<{ status?: readonly Step[]; migrate?: readonly Step[]; touchDb?: boolean }>;

/** فروشگاهِ ساختگی: گام‌ها به ترتیب مصرف می‌شوند و آخری تکرار می‌شود؛ تابع‌بودنِ گام = اجرا (می‌تواند بپرتابد یا آویزان بماند). */
export function fakeStore(stage: MigrateStage, calls: string[], script: Script, db: LedgerDatabase): MigratableStore {
  const counters = { status: 0, migrate: 0 };
  const next = async (kind: "status" | "migrate", steps: readonly Step[] | undefined, fallback: unknown): Promise<unknown> => {
    calls.push(`${stage}.${kind}`);
    if (script.touchDb === true) await db.execute({} as never);
    const list = steps ?? [fallback];
    const step = list[Math.min(counters[kind]++, list.length - 1)];
    return typeof step === "function" ? (step as () => unknown)() : step;
  };
  return {
    status: () => next("status", script.status, okStatus(["0001_init"], [])) as never,
    migrate: () => next("migrate", script.migrate, okMigrate([])) as never,
  };
}

export type World = Readonly<{
  calls: string[];
  lines: string[];
  timer: ManualTimer;
  opened: { count: number; closed: number };
  ports: MigratePorts;
  run(argv: unknown, env?: unknown): Promise<MigrateOutcome>;
}>;

export const BASE_ENV: Readonly<Record<string, string>> = Object.freeze({ DATABASE_URL: SECRET_URL });

export function world(scripts: Partial<Record<MigrateStage, Script>> = {}, opts: { open?: MigratePorts["open"]; closeHangs?: boolean } = {}): World {
  const calls: string[] = [];
  const lines: string[] = [];
  const timer = manualTimer();
  const opened = { count: 0, closed: 0 };
  const open: MigratePorts["open"] =
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
  const createStores = (db: LedgerDatabase): StoresResult => ({
    ok: true,
    ledger: fakeStore("ledger", calls, scripts.ledger ?? {}, db),
    settlement: fakeStore("settlement", calls, scripts.settlement ?? {}, db),
  });
  const ports: MigratePorts = { open, timer, write: (l) => lines.push(l), createStores };
  return { calls, lines, timer, opened, ports, run: (argv, env = BASE_ENV) => runSettlementMigrate({ argv, env, ports }) };
}
