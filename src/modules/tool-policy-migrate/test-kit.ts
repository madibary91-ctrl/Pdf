/**
 * ابزار مشترک آزمون‌های tool-policy-migrate (از index صادر نمی‌شود؛ ماژول‌ها کمک‌تستِ یکدیگر را import نمی‌کنند).
 * فروشگاهِ ساختگیِ اسکریپت‌پذیر (با ثبتِ ترتیبِ فراخوانی)، زمان‌سنجِ مجازی و قناریِ نشت.
 */
import { runToolPolicyMigrate } from "./cli";
import type { MigratableStore, MigrateOutcome, MigratePorts, StoreResult } from "./types";

export const CANARY = "LEAK-CANARY-policy-migrate-5d2a";
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

type StatusValue = Readonly<{
  schemaExists: boolean;
  applied: readonly string[];
  pending: readonly string[];
  problems: readonly string[];
  rows: number;
  latestVersion: number | null;
  contiguous: boolean;
  ready: boolean;
}>;

const READY_VALUE: StatusValue = { schemaExists: true, applied: ["0001_init"], pending: [], problems: [], rows: 0, latestVersion: null, contiguous: true, ready: true };
export const statusOk = (over: Partial<StatusValue> = {}) => ({ ok: true as const, value: { ...READY_VALUE, ...over } });
export const READY = statusOk();
export const NO_SCHEMA = statusOk({ schemaExists: false, applied: [], pending: ["0001_init"], ready: false });
export const NO_TABLES = statusOk({ applied: [], pending: ["0001_init"], ready: false });
export const BAD_GUARD = statusOk({ problems: ["trigger_missing_or_disabled:x"], ready: false });
export const GAPPY = statusOk({ rows: 3, latestVersion: 5, contiguous: false, ready: false });
export const migrateOk = (applied: readonly string[] = ["0001_init"]) => ({ ok: true as const, value: { applied, alreadyApplied: [] as string[] } });
export const schemaOk = { ok: true as const, value: null };
/** خطای فروشگاه؛ `message` عمداً قناری دارد تا هر نشت دیده شود. */
export const storeErr = (code: string, pgCode?: string) => ({ ok: false as const, error: { code, message: CANARY, ...(pgCode === undefined ? {} : { pgCode }) } });

type Step = unknown | (() => unknown);
export type Script = Readonly<{ status?: readonly Step[]; migrate?: readonly Step[]; createSchema?: readonly Step[]; touchDb?: boolean }>;

/** فروشگاهِ ساختگی: گام‌ها به ترتیب مصرف می‌شوند و آخری تکرار می‌شود؛ تابع‌بودنِ گام = اجرا (می‌تواند بپرتابد یا آویزان بماند). */
export function fakeStore(calls: string[], script: Script, db: { execute(q: unknown): unknown }): MigratableStore {
  const counters = { status: 0, migrate: 0, createSchema: 0 };
  const next = async (kind: keyof typeof counters, steps: readonly Step[] | undefined, fallback: unknown): Promise<unknown> => {
    calls.push(kind);
    if (script.touchDb === true) await db.execute({});
    const list = steps ?? [fallback];
    const step = list[Math.min(counters[kind]++, list.length - 1)];
    return typeof step === "function" ? (step as () => unknown)() : step;
  };
  return {
    status: () => next("status", script.status, READY) as never,
    migrate: () => next("migrate", script.migrate, migrateOk([])) as never,
    createSchema: () => next("createSchema", script.createSchema, schemaOk) as never,
  };
}

export type World = Readonly<{
  calls: string[];
  lines: string[];
  timer: ManualTimer;
  opened: { count: number; closed: number };
  ports: MigratePorts;
  schemas: (string | null)[];
  run(argv: unknown, env?: unknown): Promise<MigrateOutcome>;
}>;

export const BASE_ENV: Readonly<Record<string, string>> = Object.freeze({ DATABASE_URL: SECRET_URL });

export function world(script: Script = {}, opts: { open?: MigratePorts["open"]; closeHangs?: boolean } = {}): World {
  const calls: string[] = [];
  const lines: string[] = [];
  const schemas: (string | null)[] = [];
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
  const createStore = (db: unknown, schema: string | null): StoreResult => {
    schemas.push(schema);
    return { ok: true, store: fakeStore(calls, script, db as { execute(q: unknown): unknown }) };
  };
  const ports: MigratePorts = { open, timer, write: (l) => lines.push(l), createStore };
  return { calls, lines, timer, opened, ports, schemas, run: (argv, env = BASE_ENV) => runToolPolicyMigrate({ argv, env, ports }) };
}
