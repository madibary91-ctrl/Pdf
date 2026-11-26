/**
 * `status()` روی PostgreSQL واقعی زیرِ سقفِ مهلت (ADR-0074). کنترلِ منفی: پیش از اصلاح، status پشتِ قفل بی‌پایان می‌ماند.
 * برای اینکه رگرسیون آزمون را **آویزان** نکند، قفل خودکار پس از `SAFETY_RELEASE_MS` رها می‌شود و آزمون با شکستِ معنادار تمام می‌شود.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPgPolicyVersionStore } from "./store";
import type { PolicyPgDatabase } from "./types";
import { dbDescribe, openPgPolicyStore, TEST_DB_URL, TEST_POOL_IDLE_MS, type TestPolicyStore } from "./test-db";

const SAFETY_RELEASE_MS = 4_000;
const dialect = new PgDialect();

dbDescribe("tool-policy-store-pg · status() زیرِ سقفِ مهلت (PostgreSQL واقعی)", () => {
  const opened: TestPolicyStore[] = [];
  const pools: Pool[] = [];
  afterAll(async () => {
    for (const h of opened) await h.dispose();
    for (const p of pools) await p.end();
  });
  const open = async (o: Parameters<typeof openPgPolicyStore>[0] = {}): Promise<TestPolicyStore> => {
    const h = await openPgPolicyStore(o);
    opened.push(h);
    return h;
  };

  /** نگه‌دارندهٔ قفلِ انحصاریِ جدولِ نسخه‌ها روی اتصالی جدا؛ `release` idempotent است و خودکار هم رها می‌شود. */
  async function lockVersions(h: TestPolicyStore): Promise<{ release(): Promise<void>; released(): boolean }> {
    const pool = new Pool({ connectionString: TEST_DB_URL, max: 1, idleTimeoutMillis: TEST_POOL_IDLE_MS });
    pools.push(pool);
    const client: PoolClient = await pool.connect();
    await client.query("BEGIN");
    await client.query(`LOCK TABLE "${h.schema}".tool_policy_versions IN ACCESS EXCLUSIVE MODE`);
    let done = false;
    const release = async (): Promise<void> => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      await client.query("ROLLBACK");
      client.release();
    };
    const safety = setTimeout(() => void release(), SAFETY_RELEASE_MS);
    return { release, released: () => done };
  }

  it("پشتِ قفلِ انحصاریِ جدول: status با مهلتِ سمتِ پایگاه قطع می‌شود (DB_ERROR با 57014/55P03) و پس از رهاسازی سالم برمی‌گردد", async () => {
    const h = await open({ store: { statementTimeoutMs: 200 } });
    expect(await h.store.append({ version: 1, overrides: {}, policy: { timing: { graceMs: 90_000 }, model: { timeoutMs: 30_000 } } as never, changes: [], source: { kind: "set" }, actor: "admin:alice", reason: "دلیل آزمون", createdAtMs: 1001 })).toEqual({ ok: true, value: null });
    const lock = await lockVersions(h);
    try {
      const t0 = Date.now();
      const r = await h.store.status();
      const elapsed = Date.now() - t0;
      expect(lock.released(), "قفل باید هنوز نگه‌داشته باشد (مهلت از خودِ پایگاه آمده، نه رهاسازیِ قفل)").toBe(false);
      // statement_timeout و lock_timeout هر دو ۲۰۰ms‌اند؛ هر کدام زودتر برسد (57014 یا 55P03) قطعِ سمتِ پایگاه است.
      expect(r).toMatchObject({ ok: false, error: { code: "DB_ERROR" } });
      expect(["57014", "55P03"]).toContain(r.ok ? "OK" : r.error.pgCode);
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(2_500);
      expect(JSON.stringify(r)).not.toMatch(/SELECT|tool_policy_versions/);
    } finally {
      await lock.release();
    }
    expect(await h.store.status()).toMatchObject({ ok: true, value: { rows: 1, latestVersion: 1, contiguous: true, ready: true } });
  });

  it("در حینِ انتظارِ قفل، پرسشِ status دیگر روی پایگاه نمی‌ماند (اتصال به استخر برمی‌گردد، نه گروگان)", async () => {
    const h = await open({ poolSize: 1, store: { statementTimeoutMs: 200 } });
    const lock = await lockVersions(h);
    try {
      const r = await h.store.status();
      expect(r.ok).toBe(false);
      expect(["57014", "55P03"]).toContain(r.ok ? "OK" : r.error.pgCode);
      const waiting = await h.raw(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT l.granted`,
        [h.schema],
      );
      expect(waiting).toEqual([{ n: 0 }]);
      // استخرِ تک‌اتصالی هنوز زنده است: همان اتصال که status گرفته بود آزاد شده و پرسشِ بعدی می‌گذرد.
      expect(await h.raw("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    } finally {
      await lock.release();
    }
  });

  it("statement_timeout (نه فقط lock_timeout): پرسشِ کُندِ status با 57014 قطع می‌شود", async () => {
    const h = await open({ store: { statementTimeoutMs: 150 } });
    // پرسشِ شمارش را درونِ همان تراکنش با pg_sleep عوض می‌کنیم؛ set_config و بقیهٔ دستورها واقعی‌اند و فقط خودِ پرسشِ کُند ساختگی است.
    const slow: PolicyPgDatabase = {
      execute: (q) => h.db.execute(q),
      transaction: (run, cfg) =>
        h.db.transaction(
          (tx) =>
            run({
              execute: (q: SQL) => (dialect.sqlToQuery(q).sql.includes("count(*)::text AS n") ? tx.execute(sql`SELECT pg_sleep(5)`) : tx.execute(q)),
            }),
          cfg,
        ),
    };
    const made = createPgPolicyVersionStore(slow, { schema: h.schema, statementTimeoutMs: 150 });
    if (!made.ok) throw new Error("make");
    const t0 = Date.now();
    const r = await made.value.status();
    expect(r).toMatchObject({ ok: false, error: { code: "DB_ERROR", pgCode: "57014" } });
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it("مهلت‌های status به اتصالِ استخر نشت نمی‌کنند (چه موفق، چه قطع‌شده)", async () => {
    const h = await open({ poolSize: 1, store: { statementTimeoutMs: 1234 } });
    expect(await h.store.status()).toMatchObject({ ok: true, value: { ready: true } });
    const after = async (): Promise<unknown> => h.raw("SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt");
    expect(await after()).toEqual([{ st: "0", lt: "0" }]);
    const lock = await lockVersions(h);
    try {
      const r = await h.store.status();
      expect(r.ok).toBe(false);
    } finally {
      await lock.release();
    }
    expect(await after()).toEqual([{ st: "0", lt: "0" }]);
  });

  it("status هرگز نمی‌نویسد و تراکنشِ فقط‌خواندنی می‌ماند: پس از status چیزی در جدول‌ها عوض نشده", async () => {
    const h = await open({ store: { statementTimeoutMs: 500 } });
    const before = await h.raw("SELECT (SELECT count(*) FROM {{s}}.tool_policy_versions)::int AS v, (SELECT count(*) FROM {{s}}.tool_policy_migration_ledger)::int AS l");
    for (let i = 0; i < 3; i++) expect(await h.store.status()).toMatchObject({ ok: true });
    expect(await h.raw("SELECT (SELECT count(*) FROM {{s}}.tool_policy_versions)::int AS v, (SELECT count(*) FROM {{s}}.tool_policy_migration_ledger)::int AS l")).toEqual(before);
  });
});
