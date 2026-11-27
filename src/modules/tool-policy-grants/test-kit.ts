/**
 * ابزار مشترک آزمون‌های tool-policy-grants (از index صادر نمی‌شود): پایگاهِ ساختگیِ اسکریپت‌پذیر (پاسخِ سه پرس‌وجو + ثبتِ فراخوانی)،
 * زمان‌سنجِ مجازی و قناریِ نشت. دنیای ساختگی فقط شکلِ پاسخ را می‌سازد؛ درستیِ SQL را آزمونِ PostgreSQLِ واقعی (tooling) می‌گیرد.
 */
import { CONTRACT_TABLES, RUNTIME_CONTRACT, SCHEMA_PRIVILEGES, TABLE_PRIVILEGES } from "./contract";
import { planStatements, RELATIONS_SQL, ROLE_SQL, SCHEMA_SQL } from "./plan";
import { runToolPolicyGrants } from "./cli";
import type { GrantsOutcome, GrantsPorts } from "./types";

export const CANARY = "LEAK-CANARY-policy-grants-7c1e";
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

type Rows = readonly Record<string, unknown>[];

export const safeRole = { super: false, createrole: false, createdb: false, bypassrls: false, replication: false };

/** ردیف‌های پرس‌وجوی ۲ برای حقوقِ مؤثرِ شِما. */
export function schemaRows(granted: readonly string[] = [...RUNTIME_CONTRACT.schema], owner = false): Rows {
  return SCHEMA_PRIVILEGES.map((p) => ({ privilege: p, granted: granted.includes(p), owner }));
}

/** ردیف‌های پرس‌وجوی ۳؛ `tables` نقشهٔ جدول → حق‌های مؤثر (پیش‌فرض: قرارداد). `extra` رابطه‌های ناشناخته. */
export function relationRows(
  tables: Readonly<Record<string, readonly string[]>> = Object.fromEntries(CONTRACT_TABLES.map((t) => [t, [...RUNTIME_CONTRACT.tables[t]]])),
  opts: Readonly<{ owner?: readonly string[]; kinds?: Readonly<Record<string, string>> }> = {},
): Rows {
  const out: Record<string, unknown>[] = [];
  for (const [name, granted] of Object.entries(tables)) {
    for (const p of TABLE_PRIVILEGES) out.push({ relation: name, kind: opts.kinds?.[name] ?? "r", privilege: p, granted: granted.includes(p), owner: opts.owner?.includes(name) ?? false });
  }
  return out;
}

export type World = {
  role: Rows;
  schema: Rows;
  relations: Rows;
  /** ترتیبِ فراخوانیِ پورت‌ها. */
  calls: string[];
  /** دستورهای هر `transact`. */
  transactions: (readonly string[])[];
  /** نتیجهٔ هر خواندن: اگر تابع باشد جایگزینِ پاسخ می‌شود (برای رد/آویزان/بدشکل). */
  queryHook?: (text: string, params: readonly string[], world: World) => unknown;
  transactHook?: (statements: readonly string[], world: World) => unknown;
  opened: number;
  closed: number;
  openHook?: () => unknown;
  closeHook?: () => unknown;
};

export function newWorld(over: Partial<World> = {}): World {
  return { role: [safeRole], schema: schemaRows(), relations: relationRows(), calls: [], transactions: [], opened: 0, closed: 0, ...over };
}

export const exactWorld = (): Pick<World, "role" | "schema" | "relations"> => ({ role: [safeRole], schema: schemaRows(), relations: relationRows() });

export function portsFor(world: World, timer: ManualTimer, lines: string[] = []): GrantsPorts {
  return {
    open: () => {
      world.opened++;
      if (world.openHook !== undefined) return world.openHook() as never;
      return { db: { tag: "db" }, close: () => (world.closed++, world.closeHook === undefined ? undefined : world.closeHook()) };
    },
    query: (_db, text, params) => {
      const kind = text === ROLE_SQL ? "role" : text === SCHEMA_SQL ? "schema" : text === RELATIONS_SQL ? "relations" : "unknown";
      world.calls.push(`query:${kind}`);
      if (world.queryHook !== undefined) {
        const r = world.queryHook(text, params, world);
        if (r !== undefined) return r;
      }
      return { rows: kind === "role" ? world.role : kind === "schema" ? world.schema : world.relations };
    },
    transact: (_db, statements) => {
      world.calls.push("transact");
      world.transactions.push(statements);
      return world.transactHook === undefined ? undefined : world.transactHook(statements, world);
    },
    timer,
    write: (l) => lines.push(l),
  };
}

export type Run = GrantsOutcome & { lines: string[]; timer: ManualTimer; world: World };

export async function runWith(argv: unknown, env: unknown, world: World = newWorld(), timer: ManualTimer = manualTimer()): Promise<Run> {
  const lines: string[] = [];
  const out = await runToolPolicyGrants({ argv, env, ports: portsFor(world, timer, lines) });
  return { ...out, lines, timer, world };
}

export const ENV = { DATABASE_URL: SECRET_URL, TOOL_POLICY_SCHEMA: "tpg_unit" };
export const ARGV = (cmd: string, role = "policy_runtime"): string[] => [cmd, `--role=${role}`];
export const expectedStatements = (timeoutMs = 60_000): readonly string[] => planStatements("tpg_unit", "policy_runtime", timeoutMs);
