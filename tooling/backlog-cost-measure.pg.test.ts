/**
 * tooling/backlog-cost-measure روی PostgreSQLِ واقعی (ADR-0044) — مقیاسِ کوچک (ثانیه‌ای) و **بی‌ادعا دربارهٔ زمان** (زمان روی CI نوسان دارد؛
 * عددِ زمان فقط متناهی و نامنفی بودنش سنجیده می‌شود). آنچه قطعی است: درستیِ بذرپاشی، همانیِ SQLِ EXPLAINشده با SQLِ آداپتور، پاک‌سازیِ شِما
 * در هر مسیر (موفق، شکستِ بذر، شکستِ خواندن، شکستِ پاک‌سازی)، و بی‌نشتِ رشتهٔ اتصال در خطا.
 * شِماهای یک‌بارمصرفِ `backlog_cost_<hex>`؛ بودجهٔ اتصال (ADR-0024): همهٔ استخرها بسته می‌شوند.
 */
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { createPgSettlementOutbox } from "@/modules/settlement";
import { parseCostArgs } from "./backlog-cost";
import { measureBacklogCost, recordingDatabase, seedStatements } from "./backlog-cost-measure";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;

/** پیش‌فرضِ کوچکِ آزمون؛ `over` (مثل `["--scales=10"]`) فلگِ هم‌نام را جایگزین می‌کند. */
const args = (over: string[] = []) => {
  const base = new Map<string, string>([["--scales", "30,90"], ["--unacked", "3"], ["--done", "40"], ["--repeats", "2"]]);
  for (const o of over) base.set(o.slice(0, o.indexOf("=")), o);
  const r = parseCostArgs([...base].map(([k, v]) => (v.startsWith(k) ? v : `${k}=${v}`)));
  if (!r.ok) throw new Error(`${r.error.code}`);
  return r.value;
};

describe("backlog-cost-measure · recordingDatabase (بی‌پایگاه)", () => {
  it("پیکربندیِ تراکنش (فقط‌خواندنی) بی‌تغییر می‌رسد؛ دستورهای درونِ تراکنش و بیرونِ آن ضبط می‌شوند؛ نتیجه دست‌نخورده برمی‌گردد", async () => {
    const seenConfig: unknown[] = [];
    const exec = (rows: Record<string, unknown>[]) => ({ execute: async () => ({ rows }) });
    const db: LedgerDatabase = {
      execute: async () => ({ rows: [{ a: 1 }] }),
      transaction: async (run, config) => {
        seenConfig.push(config);
        return run(exec([{ b: 2 }]));
      },
    };
    const log: { text: string; params: unknown[] }[] = [];
    const rec = recordingDatabase(db, log);
    const q = sql`SELECT ${7}::int`;
    expect(await rec.execute(q)).toEqual({ rows: [{ a: 1 }] });
    const inner = await rec.transaction(async (tx) => tx.execute(sql`SELECT ${8}::int`), { accessMode: "read only" });
    expect(inner).toEqual({ rows: [{ b: 2 }] });
    await rec.transaction(async () => 1);
    expect(seenConfig).toEqual([{ accessMode: "read only" }, undefined]);
    expect(log.map((l) => l.params)).toEqual([[7], [8]]);
    expect(log.every((l) => /^SELECT/.test(l.text))).toBe(true);
  });
});

describe("backlog-cost-measure · seedStatements (بی‌پایگاه)", () => {
  const S = "backlog_cost_0123456789";
  it("فقط برای نامِ شِمای مجاز؛ وگرنه هیچ دستوری (تزریقِ نام ممکن نیست)", () => {
    for (const bad of ["x_backlog_cost_0123456789", "Xbacklog_cost_0123456789", "settlement", "public", 'backlog_cost_0123456789"; DROP SCHEMA x; --', "backlog_cost_XYZ", "", "backlog_cost_0123456789 ", "backlog_cost_01234567890"]) expect(seedStatements(bad, { acked: 1, unacked: 1, done: 1 })).toEqual([]);
    expect(seedStatements(S, { acked: 1, unacked: 0, done: 0 })).not.toEqual([]);
  });
  it("مقدارِ صفر دستورِ همان بخش را نمی‌سازد؛ شمارش‌ها در generate_series می‌آیند", () => {
    expect(seedStatements(S, { acked: 0, unacked: 0, done: 0 })).toEqual([]);
    const all = seedStatements(S, { acked: 11, unacked: 7, done: 5 });
    expect(all).toHaveLength(4); // مرده‌ٔ تأییدشده، تأییدها، مرده‌ٔ تأییدنشده، done
    expect(all[0]).toContain("generate_series(1, 11)");
    expect(all[2]).toContain("generate_series(1, 7)");
    expect(all[3]).toContain("generate_series(1, 5)");
    expect(seedStatements(S, { acked: 0, unacked: 7, done: 0 })).toHaveLength(1);
  });
  it("همهٔ دستورها فقط شِمای نقل‌قول‌شدهٔ خودش را می‌نویسند؛ تأییدشده‌ها قدیمی‌تر از تأییدنشده‌ها (بدترین حالت)", () => {
    for (const st of seedStatements(S, { acked: 2, unacked: 2, done: 2 })) {
      expect(st).toContain(`"${S}".settlement_`);
      expect(st).not.toMatch(/\bpublic\b|"settlement"\.|"ledger"\./);
    }
    const [seedAcked, , seedUnacked] = seedStatements(S, { acked: 2, unacked: 2, done: 0 });
    expect(seedAcked).toContain("1000000 + g");
    expect(seedUnacked).toContain("2000000000 + g");
  });
});

dbDescribe("backlog-cost-measure · PostgreSQL واقعی", () => {
  const pools: Pool[] = [];
  afterEach(async () => {
    while (pools.length > 0) await (pools.pop() as Pool).end().catch(() => undefined);
  });
  const open = (): Pool => {
    const p = new Pool({ connectionString: DB_URL, max: 4, idleTimeoutMillis: IDLE_MS });
    pools.push(p);
    return p;
  };
  const costSchemas = async (p: Pool): Promise<string[]> => (await p.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'backlog_cost\\_%' ORDER BY 1")).rows.map((r) => (r as { schema_name: string }).schema_name);
  /** پس از هر آزمون، شِمای تازه‌ماندهٔ همین آزمون را پاک می‌کند تا آزمونِ بعدی آلوده نشود. */
  async function dropNew(p: Pool, before: string[]): Promise<void> {
    for (const s of await costSchemas(p)) if (!before.includes(s)) await p.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  }
  /** استخرِ پروکسی: `intercept(text)` اگر رشته بدهد، به‌جای دستور خطا می‌پرتابد؛ وگرنه دستور بی‌تغییر می‌رود. */
  function spyPool(real: Pool, hook: (text: string) => Promise<string | null | void>): Pool {
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== "query") {
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        }
        return async (q: unknown, ...rest: unknown[]) => {
          const text = typeof q === "string" ? q : (q as { text: string }).text;
          const fault = await hook(text);
          if (typeof fault === "string") throw new Error(fault);
          return (target.query as (...a: unknown[]) => Promise<unknown>).call(target, q, ...rest);
        };
        void receiver;
      },
    });
  }

  it("اجرای کامل: گزارشِ نسخهٔ ۱، یک سناریو به‌ازای هر مقیاس، برگشتیِ درست (=تأییدنشده‌ها) و شِمای پاک‌شده", async () => {
    const p = open();
    const before = await costSchemas(p);
    const labels: string[] = [];
    const r = await measureBacklogCost({ pool: p, onScenario: (l) => labels.push(l) }, args());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(labels).toEqual(["acked=30", "acked=90"]);
    expect(r.value.version).toBe(1);
    expect(r.value.server).toMatch(/^postgresql \d+/);
    expect(r.value.scenarios.map((s) => s.ackedDead)).toEqual([30, 90]);
    for (const s of r.value.scenarios) {
      expect(s.stats.n).toBe(2);
      for (const v of [s.stats.minMs, s.stats.medianMs, s.stats.p95Ms, s.stats.maxMs, s.plan.executionMs]) expect(Number.isFinite(v) && v >= 0).toBe(true);
      expect(s.plan.returnedRows).toBe(3); // فقط سه مرده‌ٔ تأییدنشده برمی‌گردد، نه تأییدشده‌ها
      expect(s.plan.outboxRowsScanned).toBeGreaterThanOrEqual(3);
      expect(s.plan.ackRowsTouched).toBeGreaterThan(0);
    }
    expect(r.value.fit).not.toBeNull();
    expect(await costSchemas(p)).toEqual(before);
  });

  it("ساعتِ تزریقی: نمونه‌ها دقیقاً اختلافِ ساعت‌اند (آداپتورِ واقعی صدا زده می‌شود، نه شبیه‌ساز)", async () => {
    const p = open();
    let t = 0;
    const r = await measureBacklogCost({ pool: p, now: () => (t += 10) }, args(["--scales=20", "--repeats=3"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // هر خواندن دو بار ساعت را می‌خواند (آغاز و پایان) ⇒ اختلافِ ثابتِ ۱۰.
    expect(r.value.scenarios[0]?.stats).toEqual({ n: 3, minMs: 10, medianMs: 10, p95Ms: 10, maxMs: 10 });
  });

  it("recordingDatabase: همان SQL و پارامترِ آداپتور را ضبط می‌کند و نتیجه را دست‌نخورده می‌دهد؛ EXPLAIN همان پرسش را اجرا می‌کند", async () => {
    const p = open();
    const schema = "backlog_cost_" + "ab".repeat(5);
    const log: { text: string; params: unknown[] }[] = [];
    const real = drizzle(p) as unknown as LedgerDatabase;
    const made = createPgSettlementOutbox(recordingDatabase(real, log), { schema });
    if (!made.ok) throw new Error("outbox");
    try {
      expect((await made.value.migrate()).ok).toBe(true);
      for (const st of seedStatements(schema, { acked: 5, unacked: 4, done: 3 })) await p.query(st);
      log.length = 0;
      const got = await made.value.listUnacknowledgedDead({ limit: 2 });
      expect(got.ok && got.value.length).toBe(2);
      const last = log[log.length - 1];
      expect(last?.text).toMatch(/^\s*SELECT\b/i);
      expect(last?.params).toContain(2); // limit پارامترِ پیوندی است
      const direct = await p.query({ text: last?.text as string, values: last?.params as unknown[] });
      expect(direct.rows).toHaveLength(2);
      const explained = await p.query({ text: `EXPLAIN (ANALYZE, FORMAT JSON) ${last?.text}`, values: last?.params as unknown[] });
      expect(JSON.stringify(explained.rows[0])).toContain("settlement_dead_ack");
    } finally {
      await p.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it("ترتیبِ دستورها: شِما ← بذر (INSERT) ← VACUUM ANALYZE هر دو جدول ← EXPLAIN ← DROP SCHEMA؛ و EXPLAIN فقط یک‌بار به‌ازای هر مقیاس", async () => {
    const real = open();
    const texts: string[] = [];
    const r = await measureBacklogCost({ pool: spyPool(real, async (t) => void texts.push(t.replace(/\s+/g, " ").trim())) }, args(["--scales=15", "--repeats=1"]));
    expect(r.ok).toBe(true);
    const idx = (re: RegExp): number => texts.findIndex((t) => re.test(t));
    const lastInsert = texts.map((t, i) => (/^INSERT INTO/.test(t) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const vOutbox = idx(/^VACUUM \(ANALYZE\) "backlog_cost_[0-9a-f]{10}"\.settlement_outbox$/);
    const vAck = idx(/^VACUUM \(ANALYZE\) "backlog_cost_[0-9a-f]{10}"\.settlement_dead_ack$/);
    const explain = idx(/^EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\) SELECT\b/);
    const drop = idx(/^DROP SCHEMA IF EXISTS "backlog_cost_[0-9a-f]{10}" CASCADE$/);
    expect(lastInsert).toBeGreaterThanOrEqual(0);
    expect([lastInsert < vOutbox, vOutbox >= 0, vOutbox < vAck, vAck < explain, explain < drop]).toEqual([true, true, true, true, true]);
    expect(texts.filter((t) => t.startsWith("EXPLAIN")).length).toBe(1);
    expect(texts.filter((t) => t.startsWith("DROP SCHEMA")).length).toBe(1);
  });

  it("خواندنِ میانیِ ناموفق (سومین خواندنِ فقط‌خواندنی می‌شکند) ⇒ READ_FAILED، نه گزارشِ ناقص با نمونهٔ کمتر؛ شِما پاک می‌شود", async () => {
    const real = open();
    const before = await costSchemas(real);
    let reads = 0;
    const decorate = (db: LedgerDatabase): LedgerDatabase => ({
      execute: (q) => db.execute(q),
      transaction: async (run, config) => {
        if (config?.accessMode === "read only" && ++reads === 3) throw new Error("transient");
        return db.transaction(run, config);
      },
    });
    const r = await measureBacklogCost({ pool: real, decorate }, args(["--scales=10", "--repeats=3"]));
    expect(r).toEqual({ ok: false, error: { code: "READ_FAILED" } });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(await costSchemas(real)).toEqual(before);
  });

  it("شکستِ خواندنِ گرم‌کردن (نخستین خواندن) ⇒ READ_FAILED و هیچ نمونه‌ای ساخته نمی‌شود", async () => {
    const real = open();
    let reads = 0;
    const decorate = (db: LedgerDatabase): LedgerDatabase => ({
      execute: (q) => db.execute(q),
      transaction: async (run, config) => {
        if (config?.accessMode === "read only") {
          reads += 1;
          throw new Error("down");
        }
        return db.transaction(run, config);
      },
    });
    const r = await measureBacklogCost({ pool: real, decorate }, args(["--scales=10", "--repeats=3"]));
    expect(r).toEqual({ ok: false, error: { code: "READ_FAILED" } });
    expect(reads).toBe(1); // پس از شکستِ گرم‌کردن دیگر تلاش نمی‌شود
  });

  it("EXPLAIN می‌پرتابد (پس از بذر) ⇒ READ_FAILED (نه SEED_FAILED) و شِما پاک می‌شود", async () => {
    const real = open();
    const before = await costSchemas(real);
    const r = await measureBacklogCost({ pool: spyPool(real, async (t) => (t.startsWith("EXPLAIN") ? "boom" : null)) }, args(["--scales=10", "--repeats=1"]));
    expect(r).toEqual({ ok: false, error: { code: "READ_FAILED" } });
    expect(await costSchemas(real)).toEqual(before);
  });

  it("شکستِ بذرپاشی ⇒ SEED_FAILED و شِما پاک می‌شود", async () => {
    const real = open();
    const before = await costSchemas(real);
    const r = await measureBacklogCost({ pool: spyPool(real, async (t) => (/^\s*INSERT INTO/i.test(t) ? "boom" : null)) }, args());
    expect(r).toEqual({ ok: false, error: { code: "SEED_FAILED" } });
    expect(await costSchemas(real)).toEqual(before);
  });

  it("شکستِ خواندن (checksumِ دفترِ مهاجرت پس از بذر دست‌کاری می‌شود ⇒ سپرِ آداپتور می‌بندد) ⇒ دقیقاً READ_FAILED و شِما پاک می‌شود", async () => {
    const real = open();
    const before = await costSchemas(real);
    const pool = spyPool(real, async (t) => {
      const m = /^VACUUM \(ANALYZE\) ("backlog_cost_[0-9a-f]+")\.settlement_dead_ack/.exec(t);
      if (m !== null) await real.query(`UPDATE ${m[1]}.settlement_migration_ledger SET checksum = repeat('0', 64)`);
      return null;
    });
    const r = await measureBacklogCost({ pool }, args());
    expect(r).toEqual({ ok: false, error: { code: "READ_FAILED" } });
    expect(await costSchemas(real)).toEqual(before);
  });

  it("شکستِ پاک‌سازی ⇒ CLEANUP_FAILED (شِمای باقی‌مانده نادیده گرفته نمی‌شود)", async () => {
    const real = open();
    const before = await costSchemas(real);
    try {
      const r = await measureBacklogCost({ pool: spyPool(real, async (t) => (/^DROP SCHEMA/i.test(t) ? "no drop" : null)) }, args(["--scales=10"]));
      expect(r).toEqual({ ok: false, error: { code: "CLEANUP_FAILED" } });
      expect((await costSchemas(real)).length).toBe(before.length + 1);
    } finally {
      await dropNew(real, before);
    }
    expect(await costSchemas(real)).toEqual(before);
  });

  it("پایگاهِ در دسترس نیست ⇒ DATABASE_UNAVAILABLE و هیچ بخشی از رشتهٔ اتصال در نتیجه نمی‌آید", async () => {
    const url = ["postgres", "://u:", "s3cr3t", "@127.0.0.1:1/none"].join("");
    const dead = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1500 });
    dead.on("error", () => undefined);
    pools.push(dead);
    const r = await measureBacklogCost({ pool: dead }, args());
    expect(r).toEqual({ ok: false, error: { code: "DATABASE_UNAVAILABLE" } });
    expect(JSON.stringify(r)).not.toMatch(/s3cr3t|127\.0\.0\.1/);
  });

  it("خطای onScenario بلعیده می‌شود (پیشرفت اختیاری است)", async () => {
    const p = open();
    const r = await measureBacklogCost(
      {
        pool: p,
        onScenario: () => {
          throw new Error("ui");
        },
      },
      args(["--scales=10", "--repeats=1"]),
    );
    expect(r.ok).toBe(true);
  });
});
