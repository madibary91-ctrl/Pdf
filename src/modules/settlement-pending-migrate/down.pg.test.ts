/**
 * `settlement-pending-migrate down --yes` روی PostgreSQL واقعی (ADR-0049): همان `runPendingMigrate` با پایگاهِ واقعی. شِمای یک‌بارمصرفِ `pd_<تصادفی>`؛
 * بودجهٔ اتصال (ADR-0024): همه استخرها با `idleTimeoutMillis` کوتاه ساخته و در پایان بسته می‌شوند. به `public` و شِمای واقعیِ `settlement` دست نمی‌زند.
 * آزمون‌های قفل‌شدهٔ ۰۰۴۷ دست‌نخورده‌اند؛ این فایل فقط افزوده شده است.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { createPgSettlementOutbox } from "@/modules/settlement";
import type { PgSettlementOutbox, ReservationRef } from "@/modules/settlement";
import { runPendingMigrate } from "./cli";
import { CANARY } from "./test-kit";
import type { PendingMigrateReport } from "./types";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;
const FACTS = { unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const };
const MIGRATION = "0001_dead_pending";

const realTimer = {
  after: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  cancel: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type Out = Readonly<{ exitCode: number; report: PendingMigrateReport; line: string }>;

dbDescribe("settlement-pending-migrate down · PostgreSQL واقعی", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  function rig() {
    const schema = `pd_${randomBytes(5).toString("hex")}`;
    const app = `pd-test-${schema}`;
    const admin = new Pool({ connectionString: DB_URL, max: 3, idleTimeoutMillis: IDLE_MS });
    cleanups.push(async () => {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    const q = async (sqlText: string): Promise<Record<string, unknown>[]> => (await admin.query(sqlText.split("{{s}}").join(`"${schema}"`))).rows as Record<string, unknown>[];

    let outbox: PgSettlementOutbox | null = null;
    const migrateSettlement = async (): Promise<void> => {
      const pool = new Pool({ connectionString: DB_URL, max: 3, idleTimeoutMillis: IDLE_MS });
      cleanups.push(() => pool.end());
      const made = createPgSettlementOutbox(drizzle(pool) as unknown as LedgerDatabase, { schema });
      if (!made.ok) throw new Error(`createPgSettlementOutbox: ${made.error.code}`);
      const m = await made.value.migrate();
      if (!m.ok) throw new Error(`settlement migrate: ${m.error.code}`);
      outbox = made.value;
    };
    const bury = async (id: string, atMs = 20_000): Promise<ReservationRef> => {
      const o = outbox as PgSettlementOutbox;
      const r: ReservationRef = { tenantId: "t1", accountId: "a1", reservationId: id };
      const b = await o.begin({ ...r, ...FACTS });
      const d = await o.bury(r, { reason: "LEDGER_REJECTED", errorCode: null, atMs });
      if (!b.ok || !d.ok) throw new Error("seed failed");
      return r;
    };
    const ack = async (r: ReservationRef): Promise<void> => {
      const a = await (outbox as PgSettlementOutbox).acknowledgeDead(r, { atMs: 99 });
      if (!a.ok) throw new Error("ack failed");
    };

    const run = async (argv: string[], env: Record<string, string> = {}): Promise<Out> => {
      const lines: string[] = [];
      const out = await runPendingMigrate({
        argv,
        env: { DATABASE_URL: DB_URL ?? "", SETTLEMENT_OUTBOX_SCHEMA: schema, ...env },
        ports: {
          open: () => {
            const pool = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS, application_name: app });
            pool.on("error", () => undefined);
            return { db: drizzle(pool), close: () => pool.end() };
          },
          timer: realTimer,
          write: (l: string) => lines.push(l),
        },
      });
      expect(lines).toHaveLength(1);
      return { exitCode: out.exitCode, report: JSON.parse(lines[0] as string) as PendingMigrateReport, line: lines[0] as string };
    };
    const down = (extra: string[] = []): Promise<Out> => run(["down", "--yes", ...extra]);
    const hasPendingTable = async (): Promise<boolean> => (await q(`SELECT to_regclass('{{s}}.settlement_dead_pending') IS NOT NULL AS present`))[0]?.["present"] === true;
    const hasLedger = async (): Promise<boolean> => (await q(`SELECT to_regclass('{{s}}.settlement_pending_migration_ledger') IS NOT NULL AS present`))[0]?.["present"] === true;
    /** کاتالوگِ شِما: رابطه‌ها، TRIGGERهای غیرداخلی و توابع (مرتب). */
    const catalog = async (): Promise<string[]> =>
      (
        await admin.query(
          `SELECT k FROM (
             SELECT 'rel:' || c.relname || ':' || c.relkind::text AS k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
             UNION ALL SELECT 'trg:' || c.relname || ':' || t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal
             UNION ALL SELECT 'fn:' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1
           ) x ORDER BY k`,
          [schema],
        )
      ).rows.map((r) => String((r as { k: unknown }).k));
    /** رکوردهای حقیقت (outbox و تأیید) بایت‌به‌بایت. */
    const truth = async (): Promise<string> =>
      JSON.stringify([
        await q(`SELECT to_jsonb(o) AS j FROM {{s}}.settlement_outbox o ORDER BY to_jsonb(o)::text`),
        await q(`SELECT to_jsonb(a) AS j FROM {{s}}.settlement_dead_ack a ORDER BY to_jsonb(a)::text`),
      ]);
    const activeBackends = async (): Promise<number> => Number((await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = '${app}'`))[0]?.["n"]);
    return { schema, app, admin, q, migrateSettlement, bury, ack, run, down, hasPendingTable, hasLedger, catalog, truth, activeBackends };
  }

  it("رفت‌وبرگشتِ کامل با داده: up ← down ⇒ کاتالوگ ≡ پیش از نصب؛ رکوردهای outbox/تأیید بی‌تغییر؛ status ⇒ ۳ و verify ⇒ ۳؛ نویسنده پس از down کار می‌کند؛ up دوباره سازگار", async () => {
    const r = rig();
    await r.migrateSettlement();
    const before = await r.catalog();
    expect((await r.run(["up"])).exitCode).toBe(0);
    const installed = await r.catalog();
    expect(installed).not.toEqual(before);
    await r.bury("a");
    const b = await r.bury("b");
    await r.bury("c");
    await r.ack(b);
    const truthBefore = await r.truth();

    const d = await r.down();
    expect(d.exitCode).toBe(0);
    expect(d.report).toMatchObject({ tool: "settlement-pending-migrate", command: "down", ok: true, code: "OK", exitCode: 0, phase: "verify", closed: true });
    expect(d.report.migrations).toEqual({ applied: [], pending: [MIGRATION], appliedNow: [], revertedNow: [MIGRATION] });
    expect(d.report.verify).toBeUndefined();
    expect(d.line).not.toContain(DB_URL ?? "<none>");
    expect(await r.catalog()).toEqual(before);
    expect(await r.truth()).toBe(truthBefore);
    expect(await r.activeBackends()).toBe(0);

    const s = await r.run(["status"]);
    expect([s.exitCode, s.report.code]).toEqual([3, "PENDING"]);
    const v = await r.run(["verify"]);
    expect([v.exitCode, v.report.code]).toEqual([3, "PENDING"]);

    await r.bury("after-down"); // TRIGGER/تابعِ آویزان نمانده؛ نویسنده بی‌خطا
    const up = await r.run(["up"]);
    expect(up.exitCode).toBe(0);
    expect(up.report.verify).toEqual({ consistent: true, expected: 3, indexed: 3, missing: 0, stale: 0 });
    expect(await r.catalog()).toEqual(installed);
  }, 60_000);

  it("down دوباره = بی‌کار (۰، فاز check، بی‌نوشتن)؛ هرگز نصب‌شده نبود: کاتالوگ بی‌تغییر و دفتر ساخته نمی‌شود", async () => {
    const r = rig();
    await r.migrateSettlement();
    const before = await r.catalog();
    const never = await r.down();
    expect([never.exitCode, never.report.phase]).toEqual([0, "check"]);
    expect(never.report.migrations).toEqual({ applied: [], pending: [MIGRATION], appliedNow: [] });
    expect(await r.catalog()).toEqual(before);
    expect(await r.hasLedger()).toBe(false);

    expect((await r.run(["up"])).exitCode).toBe(0);
    expect((await r.down()).exitCode).toBe(0);
    const again = await r.down();
    expect([again.exitCode, again.report.phase]).toEqual([0, "check"]);
    expect(await r.catalog()).toEqual(before);
  }, 60_000);

  it("بی‌مهاجرتِ settlement (شِما اصلاً نیست): down ⇒ ۰ بی‌کار و شِما ساخته نمی‌شود", async () => {
    const r = rig();
    const out = await r.down();
    expect([out.exitCode, out.report.phase]).toEqual([0, "check"]);
    expect((await r.q(`SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = '${r.schema}'`))[0]?.["n"]).toBe(0);
  });

  it("بی‌--yes ⇒ ۲ و نصب دست‌نخورده می‌ماند (بی‌اتصال)", async () => {
    const r = rig();
    await r.migrateSettlement();
    expect((await r.run(["up"])).exitCode).toBe(0);
    const installed = await r.catalog();
    const out = await r.run(["down"]);
    expect([out.exitCode, out.report.code]).toEqual([2, "USAGE"]);
    expect(await r.catalog()).toEqual(installed);
    expect((await r.run(["verify"])).exitCode).toBe(0);
    expect(await r.activeBackends()).toBe(0);
  });

  it("دفترِ دست‌کاری‌شده/ناشناخته ⇒ ۵ شکست‌بسته: هیچ DDL ی زده نمی‌شود و رکوردها بی‌تغییرند", async () => {
    const r = rig();
    await r.migrateSettlement();
    expect((await r.run(["up"])).exitCode).toBe(0);
    await r.bury("keep");
    const installed = await r.catalog();
    const truth = await r.truth();
    await r.q(`UPDATE {{s}}.settlement_pending_migration_ledger SET checksum = 'tampered'`);
    const t = await r.down();
    expect(t.exitCode).toBe(5);
    expect(t.report).toMatchObject({ code: "SCHEMA_MISMATCH", phase: "check", closed: true });
    await r.q(`UPDATE {{s}}.settlement_pending_migration_ledger SET checksum = checksum, name = '0002_from_the_future'`);
    expect((await r.down()).exitCode).toBe(5);
    expect(await r.catalog()).toEqual(installed);
    expect(await r.truth()).toBe(truth);
    expect(await r.hasPendingTable()).toBe(true);
  }, 60_000);

  it("شیءِ بیرونیِ وابسته به جدولِ نمایه (view) ⇒ ۶ با 2BP01، برگشتِ کامل: نصب هنوز سالم و verify ⇒ ۰؛ پس از برداشتنِ view، down ⇒ ۰", async () => {
    const r = rig();
    await r.migrateSettlement();
    expect((await r.run(["up"])).exitCode).toBe(0);
    await r.bury("x");
    await r.q(`CREATE VIEW {{s}}.external_dep AS SELECT * FROM {{s}}.settlement_dead_pending`);
    const installed = await r.catalog();
    const d = await r.down();
    expect(d.exitCode).toBe(6);
    expect(d.report).toMatchObject({ code: "MIGRATION_FAILED", phase: "apply", pgCode: "2BP01", closed: true });
    expect(d.report.retries).toBeUndefined();
    expect(d.line).not.toMatch(/external_dep/); // نامِ شیءِ بیرونی/متنِ خطا نشت نمی‌کند
    expect(await r.catalog()).toEqual(installed);
    const v = await r.run(["verify"]);
    expect([v.exitCode, v.report.verify?.consistent]).toEqual([0, true]);
    await r.q(`DROP VIEW {{s}}.external_dep`);
    expect((await r.down()).exitCode).toBe(0);
    expect(await r.hasPendingTable()).toBe(false);
  }, 60_000);

  it("down‖down هم‌زمان: هر دو ۰ و نصب برداشته می‌شود (قفلِ مشورتی)", async () => {
    const r = rig();
    await r.migrateSettlement();
    const before = await r.catalog();
    expect((await r.run(["up"])).exitCode).toBe(0);
    const [a, b] = await Promise.all([r.down(), r.down()]);
    expect([a.exitCode, b.exitCode]).toEqual([0, 0]);
    expect(await r.catalog()).toEqual(before);
  }, 60_000);

  it("سه دورِ down‖up‖down: هرگز نصبِ نیمه؛ حالتِ نهایی دقیقاً «نصب‌نشده» یا «نصبِ کاملِ سازگار»", async () => {
    const r = rig();
    await r.migrateSettlement();
    const before = await r.catalog();
    expect((await r.run(["up"])).exitCode).toBe(0);
    const installed = await r.catalog();
    for (let round = 0; round < 3; round++) {
      const outs = await Promise.all([r.down(), r.run(["up"]), r.down()]);
      for (const o of outs) expect([0, 6], JSON.stringify(o.report)).toContain(o.exitCode);
      const cat = await r.catalog();
      expect([JSON.stringify(before), JSON.stringify(installed)]).toContain(JSON.stringify(cat));
      if (JSON.stringify(cat) === JSON.stringify(installed)) expect((await r.run(["verify"])).exitCode).toBe(0);
      else expect((await r.run(["status"])).exitCode).toBe(3);
      if (round < 2) await r.run(["up"]);
    }
  }, 90_000);

  it("مهلتِ کل: قفلِ مشورتیِ مهاجرتِ نمایه در دستِ دیگری ⇒ ۷ در مهلت و نصب تا آن لحظه دست‌نخورده (اثباتِ «پس از مرگِ فرایند» در down.process.pg.test.ts)", async () => {
    const r = rig();
    await r.migrateSettlement();
    expect((await r.run(["up"])).exitCode).toBe(0);
    const installed = await r.catalog();
    const holder = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS });
    cleanups.push(() => holder.end());
    const client = await holder.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`settlement-pending:migrate:${r.schema}`]);
      const started = Date.now();
      const out = await r.down(["--timeout-ms=2000"]);
      expect(out.exitCode).toBe(7);
      expect(out.report).toMatchObject({ code: "TIMEOUT", phase: "apply" });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await r.catalog()).toEqual(installed);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    // درون‌فرایندی، پرسشِ رهاشده تا بستنِ اتصال زنده است و پس از آزادیِ قفل می‌تواند ادامه دهد؛ در فرایندِ واقعی اتصال با مرگِ فرایند قطع می‌شود. پس فقط همگرایی را می‌سنجیم.
    for (let i = 0; i < 100 && (await r.activeBackends()) > 0; i++) await new Promise((res) => setTimeout(res, 100));
    expect((await r.down()).exitCode).toBe(0);
    expect(await r.hasPendingTable()).toBe(false);
  }, 60_000);

  it("قفلِ مشغول: نویسندهٔ طولانی ⇒ پس از ۱۵ثانیه ۱۰، برگشتِ کامل (نصب سالم) و بازتلاشِ خودکار نیست؛ پس از آزادی down ⇒ ۰", async () => {
    const r = rig();
    await r.migrateSettlement();
    expect((await r.run(["up"])).exitCode).toBe(0);
    await r.bury("pre");
    const installed = await r.catalog();
    const writer = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS });
    cleanups.push(() => writer.end());
    const client = await writer.connect();
    try {
      await client.query("BEGIN");
      await client.query(`LOCK TABLE "${r.schema}".settlement_outbox IN ROW EXCLUSIVE MODE`); // نویسنده‌ای که تراکنشش باز است
      const started = Date.now();
      const out = await r.down(["--timeout-ms=120000"]);
      const took = Date.now() - started;
      expect(out.exitCode).toBe(10);
      expect(out.report).toMatchObject({ code: "LOCK_BUSY", phase: "apply", pgCode: "55P03", closed: true });
      expect(out.report.retries).toBeUndefined();
      expect(took).toBeGreaterThanOrEqual(14_000);
      expect(took).toBeLessThan(40_000);
      expect(out.line).not.toContain(CANARY);
      expect(await r.catalog()).toEqual(installed); // DDL تراکنشی: هیچ‌چیز برداشته نشده
      expect(await r.activeBackends()).toBe(0);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const v = await r.run(["verify"]);
    expect([v.exitCode, v.report.verify?.expected]).toEqual([0, 1]);
    expect((await r.down()).exitCode).toBe(0);
    expect(await r.hasPendingTable()).toBe(false);
  }, 90_000);

  it("بی‌جدول‌های settlement ولی دفترِ نمایه هست (دست‌کاریِ بیرونی) ⇒ ۸ و چیزی عوض نمی‌شود", async () => {
    const r = rig();
    await r.migrateSettlement();
    expect((await r.run(["up"])).exitCode).toBe(0);
    await r.q(`DROP TABLE {{s}}.settlement_dead_ack CASCADE`); // TRIGGERهای نمایه هم با جدول می‌روند
    const ledgerRows = await r.q(`SELECT name FROM {{s}}.settlement_pending_migration_ledger`);
    const out = await r.down();
    expect(out.exitCode).toBe(8);
    expect(out.report).toMatchObject({ code: "PREREQUISITE", phase: "apply", closed: true });
    expect(await r.q(`SELECT name FROM {{s}}.settlement_pending_migration_ledger`)).toEqual(ledgerRows);
    expect(await r.hasPendingTable()).toBe(true);
  }, 60_000);
});
