/**
 * اندازه‌گیریِ هزینهٔ خواندنِ دوره‌ایِ پایشِ پسماند روی PostgreSQLِ واقعی (م۳‑ه‑۴‑الف‑۲‑۳، ADR-0044). تحلیل در `backlog-cost.ts` (خالص) است؛
 * این‌جا فقط I/O: ساختنِ شِمای **یک‌بارمصرف**، بذرپاشیِ انبوه، زمان‌گیریِ خودِ `outbox.listUnacknowledgedDead` (همان آداپتورِ تولید،
 * نه یک SQLِ کپی‌شده) و `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` روی **همان SQL و پارامترهایی که آداپتور فرستاد** (با `db`ِ ضبط‌کننده).
 *
 * ایمنی:
 *  - فقط شِمای `backlog_cost_<hex>` ساخته و در `finally` (حتی با خطا) `DROP SCHEMA … CASCADE` می‌شود؛ به شِمای `settlement`/`ledger`/`public` دست نمی‌زند.
 *  - نامِ شِما از `randomBytes` می‌آید و پیش از درج در SQL با فهرستِ سفید سنجیده می‌شود.
 *  - خطاها به کدِ بسته تبدیل می‌شوند؛ متنِ خطا/رشتهٔ اتصال/SQL در خروجی نمی‌آید.
 * بدترین حالتِ خواندن را می‌سازد: مرده‌های تأییدشده **قدیمی‌تر**‌اند (ترتیبِ خواندن `settled_at_ms` است)، پس باید پیش از رسیدن به
 * مرده‌های تأییدنشدهٔ تازه‌تر همه اسکن شوند. (سینتکسِ قابل‌حذف فقط؛ CLI مستقیم با Node اجرا می‌شود.)
 */
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Pool } from "pg";
import type { LedgerDatabase, LedgerExecutor } from "@/modules/ledger";
import { createPgSettlementOutbox } from "@/modules/settlement";
import { buildReport, summarizePlan, summarizeSamples } from "./backlog-cost";
import type { CostArgs, CostReport, MeasuredScenario } from "./backlog-cost";

export type MeasureErrorCode = "DATABASE_UNAVAILABLE" | "SEED_FAILED" | "READ_FAILED" | "PLAN_FAILED" | "BAD_PLAN" | "BAD_SAMPLES" | "CLEANUP_FAILED" | "BAD_BUDGET" | "BAD_MEASURE";
export type MeasureResult = { ok: true; value: CostReport } | { ok: false; error: { code: MeasureErrorCode } };

export type MeasurePorts = Readonly<{
  pool: Pool;
  /** ساعتِ یکنوا بر حسبِ میلی‌ثانیه (پیش‌فرض `performance.now`)؛ تزریق‌پذیر برای آزمون. */
  now?: () => number;
  /** پیشرفت (فقط برچسبِ سناریو)؛ خطای آن نادیده است. */
  onScenario?: (label: string) => void;
  /** درزِ تزریقِ خطا برای آزمون: `db` پیش از ضبط/ساختِ آداپتور از این می‌گذرد (پیش‌فرض: همان). تولید آن را نمی‌دهد. */
  decorate?: (db: LedgerDatabase) => LedgerDatabase;
}>;

const SCHEMA_RE = /^backlog_cost_[0-9a-f]{10}$/;
const dialect = new PgDialect();

const fail = (code: MeasureErrorCode): { ok: false; error: { code: MeasureErrorCode } } => ({ ok: false, error: { code } });

/** `db`ی که هر دستورِ اجراشده (متن + پارامتر) را ضبط و بی‌تغییر به پایگاهِ واقعی می‌دهد. */
export function recordingDatabase(db: LedgerDatabase, log: { text: string; params: unknown[] }[]): LedgerDatabase {
  const wrap = (e: LedgerExecutor): LedgerExecutor => ({
    execute(query: SQL) {
      const compiled = dialect.sqlToQuery(query);
      log.push({ text: compiled.sql, params: [...compiled.params] });
      return e.execute(query);
    },
  });
  return {
    execute: (query: SQL) => wrap(db).execute(query),
    transaction: (run, config) => db.transaction((tx) => run(wrap(tx)), config),
  };
}

/** بذرپاشی در یک شِمای مهاجرت‌شده. زمان‌ها: تأییدشده‌ها قدیمی‌تر، تأییدنشده‌ها تازه‌تر، done مستقل (در ایندکسِ جزئیِ dead نیست). */
export function seedStatements(schema: string, scale: Readonly<{ acked: number; unacked: number; done: number }>): string[] {
  if (!SCHEMA_RE.test(schema)) return [];
  const T = `"${schema}".settlement_outbox`;
  const A = `"${schema}".settlement_dead_ack`;
  const out: string[] = [];
  const cols = "tenant_id, account_id, reservation_id, unit, reserved, created_at_ms, expires_at_ms, due_at_ms, orphan_remainder, state, attempts, dead_reason, settled_at_ms";
  const dead = (prefix: string, count: number, base: number): string =>
    `INSERT INTO ${T} (${cols})
       SELECT 't' || (g % 50), 'a' || (g % 1000), '${prefix}' || g, 'CREDIT', 10, 1000, 2000, 3000, 'release', 'dead', 3, 'ATTEMPTS_EXHAUSTED', ${base} + g
       FROM generate_series(1, ${count}) AS g`;
  if (scale.acked > 0) {
    out.push(dead("k", scale.acked, 1_000_000));
    out.push(`INSERT INTO ${A} (tenant_id, account_id, reservation_id, acked_at_ms) SELECT tenant_id, account_id, reservation_id, 9000000 FROM ${T} WHERE reservation_id LIKE 'k%' AND state = 'dead'`);
  }
  if (scale.unacked > 0) out.push(dead("u", scale.unacked, 2_000_000_000));
  if (scale.done > 0) {
    out.push(
      `INSERT INTO ${T} (tenant_id, account_id, reservation_id, unit, reserved, created_at_ms, expires_at_ms, due_at_ms, orphan_remainder, state, attempts, settled_at_ms, close_remainder, close_origin)
         SELECT 't' || (g % 50), 'a' || (g % 1000), 'd' || g, 'CREDIT', 10, 1000, 2000, 3000, 'release', 'done', 1, 5000, 'release', 'caller'
         FROM generate_series(1, ${scale.done}) AS g`,
    );
  }
  return out;
}

async function measureOne(ports: MeasurePorts, args: CostArgs, acked: number): Promise<{ ok: true; value: MeasuredScenario } | { ok: false; error: { code: MeasureErrorCode } }> {
  const now = ports.now ?? ((): number => performance.now());
  const schema = `backlog_cost_${randomBytes(5).toString("hex")}`;
  if (!SCHEMA_RE.test(schema)) return fail("SEED_FAILED");
  const log: { text: string; params: unknown[] }[] = [];
  let created = false;
  let phase: "seed" | "read" = "seed";
  let result: { ok: true; value: MeasuredScenario } | { ok: false; error: { code: MeasureErrorCode } };
  try {
    const base = drizzle(ports.pool) as unknown as LedgerDatabase;
    const real = ports.decorate === undefined ? base : ports.decorate(base);
    const made = createPgSettlementOutbox(recordingDatabase(real, log), { schema });
    if (!made.ok) return fail("SEED_FAILED");
    const outbox = made.value;
    created = true; // پس از این نقطه هر خروج باید شِما را پاک کند
    const migrated = await outbox.migrate();
    if (!migrated.ok) {
      result = fail("SEED_FAILED");
    } else {
      for (const statement of seedStatements(schema, { acked, unacked: args.unacked, done: args.done })) await ports.pool.query(statement);
      await ports.pool.query(`VACUUM (ANALYZE) "${schema}".settlement_outbox`);
      await ports.pool.query(`VACUUM (ANALYZE) "${schema}".settlement_dead_ack`);
      phase = "read";

      const read = async (): Promise<number | null> => {
        const t0 = now();
        const r = await outbox.listUnacknowledgedDead({ limit: args.limit });
        const dt = now() - t0;
        return r.ok ? dt : null;
      };
      let readFailed = (await read()) === null; // گرم‌کردن (کش، پلن)؛ شکستش هم شکست است
      const samples: number[] = [];
      for (let i = 0; i < args.repeats && !readFailed; i++) {
        const dt = await read();
        if (dt === null) readFailed = true;
        else samples.push(dt);
      }
      if (readFailed) {
        result = fail("READ_FAILED");
      } else {
        // آخرین دستورِ ضبط‌شده، پرسشِ دادهٔ همان خواندنِ آخر است (سپرِ مهاجرت پیش از آن اجرا می‌شود).
        const last = log[log.length - 1];
        const stats = summarizeSamples(samples);
        if (last === undefined) {
          result = fail("PLAN_FAILED");
        } else if (!stats.ok) {
          result = fail("BAD_SAMPLES");
        } else {
          // EXPLAIN ANALYZE واقعاً اجرا می‌کند؛ پرسش فقط‌خواندنی است، پس بی‌اثرِ جانبی. فقط SELECT مجاز است.
          if (!/^\s*SELECT\b/i.test(last.text)) {
            result = fail("PLAN_FAILED");
          } else {
            const plan = await ports.pool.query({ text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${last.text}`, values: last.params });
            const row = plan.rows[0] as Record<string, unknown> | undefined;
            const summary = summarizePlan(row?.["QUERY PLAN"]);
            result = summary.ok ? { ok: true, value: Object.freeze({ label: `acked=${acked}`, ackedDead: acked, stats: stats.value, plan: summary.value }) } : fail("BAD_PLAN");
          }
        }
      }
    }
  } catch {
    result = fail(!created ? "DATABASE_UNAVAILABLE" : phase === "seed" ? "SEED_FAILED" : "READ_FAILED");
  }
  if (created) {
    try {
      await ports.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      return fail("CLEANUP_FAILED");
    }
  }
  return result;
}

/** همهٔ سناریوها را پشت‌سرهم اجرا و گزارش می‌سازد؛ نخستین خطا اجرا را می‌بُرَد (پس از پاک‌سازیِ شِمای همان سناریو). */
export async function measureBacklogCost(ports: MeasurePorts, args: CostArgs): Promise<MeasureResult> {
  let server = "unknown";
  try {
    const v = await ports.pool.query("SHOW server_version");
    const s = (v.rows[0] as Record<string, unknown> | undefined)?.["server_version"];
    if (typeof s === "string" && /^[0-9][0-9.]{0,15}/.test(s)) server = `postgresql ${s.split(" ")[0]}`;
  } catch {
    return fail("DATABASE_UNAVAILABLE");
  }
  const scenarios: MeasuredScenario[] = [];
  for (const acked of args.scales) {
    try {
      ports.onScenario?.(`acked=${acked}`);
    } catch {
      // پیشرفت اختیاری است.
    }
    const one = await measureOne(ports, args, acked);
    if (!one.ok) return one;
    scenarios.push(one.value);
  }
  const report = buildReport({ server, args, scenarios });
  return report.ok ? { ok: true, value: report.value } : fail(report.error.code);
}
