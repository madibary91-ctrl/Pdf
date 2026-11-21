/**
 * settlement-pending-migrate روی PostgreSQL واقعی (ADR-0047): همان `runPendingMigrate` با پایگاهِ واقعی. شِمای یک‌بارمصرفِ `pm_<تصادفی>`؛
 * بودجهٔ اتصال (ADR-0024): همه استخرها با `idleTimeoutMillis` کوتاه ساخته و در پایان بسته می‌شوند. به `public` و شِمای واقعیِ `settlement` دست نمی‌زند.
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

const realTimer = {
  after: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  cancel: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
};

dbDescribe("settlement-pending-migrate · PostgreSQL واقعی", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  function rig() {
    const schema = `pm_${randomBytes(5).toString("hex")}`;
    const app = `pm-test-${schema}`;
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
    const migrateSettlement = async (): Promise<PgSettlementOutbox> => {
      const pool = new Pool({ connectionString: DB_URL, max: 3, idleTimeoutMillis: IDLE_MS });
      cleanups.push(() => pool.end());
      const made = createPgSettlementOutbox(drizzle(pool) as unknown as LedgerDatabase, { schema });
      if (!made.ok) throw new Error(`createPgSettlementOutbox: ${made.error.code}`);
      const m = await made.value.migrate();
      if (!m.ok) throw new Error(`settlement migrate: ${m.error.code}`);
      outbox = made.value;
      return made.value;
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

    /** یک اجرای کاملِ CLI با پایگاهِ واقعی (هر اجرا یک استخرِ تک‌اتصالی که پس از اجرا بسته می‌شود). */
    const run = async (argv: string[], env: Record<string, string> = {}): Promise<Readonly<{ exitCode: number; report: PendingMigrateReport; line: string }>> => {
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
    const hasPendingTable = async (): Promise<boolean> => (await q(`SELECT to_regclass('{{s}}.settlement_dead_pending') IS NOT NULL AS present`))[0]?.["present"] === true;
    return { schema, app, admin, q, migrateSettlement, bury, ack, run, hasPendingTable };
  }

  it("پیش‌نیاز: بی‌مهاجرتِ settlement، status ⇒ ۳ و up ⇒ ۸ و هیچ‌چیز ساخته نمی‌شود", async () => {
    const r = rig();
    const s = await r.run(["status"]);
    expect(s.exitCode).toBe(3);
    expect(s.report).toMatchObject({ code: "PENDING", migrations: { applied: [], pending: ["0001_dead_pending"] } });
    const up = await r.run(["up"]);
    expect(up.exitCode).toBe(8);
    expect(up.report).toMatchObject({ code: "PREREQUISITE", phase: "apply", closed: true });
    expect(await r.hasPendingTable()).toBe(false);
    expect((await r.q(`SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = '${r.schema}'`))[0]?.["n"]).toBe(0);
  });

  it("status ← up ← status ← up ← verify: ۳،۰،۰،۰،۰؛ نصب idempotent؛ گزارشِ appliedNow فقط بار اول", async () => {
    const r = rig();
    await r.migrateSettlement();
    expect((await r.run(["status"])).exitCode).toBe(3);
    expect(await r.hasPendingTable()).toBe(false); // status هرگز نمی‌نویسد
    const up = await r.run(["up"]);
    expect(up.exitCode).toBe(0);
    expect(up.report).toMatchObject({ code: "OK", phase: "verify", closed: true, migrations: { applied: ["0001_dead_pending"], pending: [], appliedNow: ["0001_dead_pending"] }, verify: { consistent: true, expected: 0, indexed: 0, missing: 0, stale: 0 } });
    expect(await r.hasPendingTable()).toBe(true);
    const s2 = await r.run(["status"]);
    expect([s2.exitCode, s2.report.phase]).toEqual([0, "check"]);
    const up2 = await r.run(["up"]);
    expect(up2.exitCode).toBe(0);
    expect(up2.report.migrations?.appliedNow).toEqual([]);
    expect(up2.report.verify).toBeUndefined(); // بی‌کاری = سبک
    expect((await r.run(["verify"])).exitCode).toBe(0);
  });

  it("backfill از پایگاهِ دارای داده: up شمارش‌های درست می‌دهد؛ پس از نصب TRIGGERها فعال‌اند (رکوردِ تازه و تأیید در verify می‌آیند)", async () => {
    const r = rig();
    await r.migrateSettlement();
    const a = await r.bury("a", 20_000);
    await r.bury("b", 21_000);
    const c = await r.bury("c", 22_000);
    await r.ack(c);
    const up = await r.run(["up"]);
    expect(up.exitCode).toBe(0);
    expect(up.report.verify).toMatchObject({ consistent: true, expected: 2, indexed: 2 });
    await r.bury("d", 23_000);
    expect((await r.run(["verify"])).report.verify).toMatchObject({ consistent: true, expected: 3, indexed: 3 });
    await r.ack(a);
    expect((await r.run(["verify"])).report.verify).toMatchObject({ consistent: true, expected: 2, indexed: 2 });
  });

  it("ناهمخوانی: TRIGGER خاموش‌شده ⇒ verify ⇒ ۹ با گم‌شده؛ و برعکس، تأییدِ بی‌TRIGGER ⇒ کهنه", async () => {
    const r = rig();
    await r.migrateSettlement();
    expect((await r.run(["up"])).exitCode).toBe(0);
    const keep = await r.bury("keep");
    await r.q(`ALTER TABLE {{s}}.settlement_outbox DISABLE TRIGGER settlement_pending_dead_ins`);
    await r.q(`ALTER TABLE {{s}}.settlement_outbox DISABLE TRIGGER settlement_pending_dead_upd`);
    await r.bury("silent");
    const miss = await r.run(["verify"]);
    expect(miss.exitCode).toBe(9);
    expect(miss.report).toMatchObject({ code: "INCONSISTENT", phase: "verify", verify: { consistent: false, expected: 2, indexed: 1, missing: 1, stale: 0 } });
    await r.q(`ALTER TABLE {{s}}.settlement_dead_ack DISABLE TRIGGER settlement_pending_ack`);
    await r.ack(keep);
    const both = await r.run(["verify"]);
    expect(both.exitCode).toBe(9);
    expect(both.report.verify).toMatchObject({ missing: 1, stale: 1 });
    // up روی نصبِ ناهمخوان «بی‌کاری» است (نصب را تعمیر نمی‌کند)؛ تشخیص با verify است.
    expect((await r.run(["up"])).exitCode).toBe(0);
  });

  it("دفترِ دست‌کاری‌شده ⇒ ۵ برای status/up/verify و up چیزی نمی‌نویسد", async () => {
    const r = rig();
    await r.migrateSettlement();
    expect((await r.run(["up"])).exitCode).toBe(0);
    await r.q(`UPDATE {{s}}.settlement_pending_migration_ledger SET checksum = 'tampered'`);
    for (const cmd of ["status", "up", "verify"]) {
      const out = await r.run([cmd]);
      expect(out.exitCode, cmd).toBe(5);
      expect(out.report).toMatchObject({ code: "SCHEMA_MISMATCH", phase: "check" });
    }
    await r.q(`UPDATE {{s}}.settlement_pending_migration_ledger SET checksum = checksum, name = '0002_from_the_future'`);
    expect((await r.run(["status"])).exitCode).toBe(5);
  });

  it("قفلِ مشغول: نویسندهٔ طولانی ⇒ پس از ۱۵ثانیه ۱۰، برگشتِ کامل، و بازتلاشِ خودکار نیست؛ پس از آزادی up ⇒ ۰", async () => {
    const r = rig();
    await r.migrateSettlement();
    const writer = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS });
    cleanups.push(() => writer.end());
    const client = await writer.connect();
    try {
      await client.query("BEGIN");
      await client.query(`LOCK TABLE "${r.schema}".settlement_outbox IN ROW EXCLUSIVE MODE`); // نویسنده‌ای که تراکنشش باز است
      const started = Date.now();
      const out = await r.run(["up", "--timeout-ms=120000"]);
      const took = Date.now() - started;
      expect(out.exitCode).toBe(10);
      expect(out.report).toMatchObject({ code: "LOCK_BUSY", phase: "apply", pgCode: "55P03", closed: true });
      expect(out.report.retries).toBeUndefined();
      expect(took).toBeGreaterThanOrEqual(14_000);
      expect(took).toBeLessThan(40_000);
      expect(await r.hasPendingTable()).toBe(false); // DDL تراکنشی: هیچ‌چیز باقی نمانده
      expect((await r.q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = '${r.app}'`))[0]?.["n"]).toBe(0);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect((await r.run(["up"])).exitCode).toBe(0);
  }, 90_000);

  it("مهلتِ کل: قفلِ مشورتیِ مهاجرتِ settlement در دستِ دیگری ⇒ ۷ در مهلت، بی‌اعمال، بی‌اتصالِ آویزان", async () => {
    const r = rig();
    await r.migrateSettlement();
    const holder = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS });
    cleanups.push(() => holder.end());
    const client = await holder.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`settlement:migrate:${r.schema}`]);
      const started = Date.now();
      const out = await r.run(["up", "--timeout-ms=2000"]);
      expect(out.exitCode).toBe(7);
      expect(out.report).toMatchObject({ code: "TIMEOUT", phase: "apply" });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await r.hasPendingTable()).toBe(false);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    // (اثباتِ «پس از مرگِ فرایند هیچ‌چیز اعمال نمی‌شود» با فرایندِ واقعی است: process.pg.test.ts؛ درون‌فرایندی، پرسشِ رهاشده تا بستنِ اتصال زنده است.)
    expect((await r.run(["up"])).exitCode).toBe(0);
  }, 60_000);

  it("verify پشتِ قفلِ جدولِ نمایه: ۷ در ≈ مهلت و پرسشِ رهاشده در پایگاه نمی‌ماند (سقفِ سمتِ پایگاه)", async () => {
    const r = rig();
    await r.migrateSettlement();
    expect((await r.run(["up"])).exitCode).toBe(0);
    const holder = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS });
    cleanups.push(() => holder.end());
    const client = await holder.connect();
    try {
      await client.query("BEGIN");
      await client.query(`LOCK TABLE "${r.schema}".settlement_dead_pending IN ACCESS EXCLUSIVE MODE`);
      const started = Date.now();
      const out = await r.run(["verify", "--timeout-ms=1000"]);
      expect(out.exitCode).toBe(7);
      expect(Date.now() - started).toBeLessThan(8_000);
      for (let i = 0; i < 40; i++) {
        const n = (await r.q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = '${r.app}' AND state <> 'idle'`))[0]?.["n"];
        if (n === 0) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      expect((await r.q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = '${r.app}' AND state <> 'idle'`))[0]?.["n"]).toBe(0);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect((await r.run(["verify"])).exitCode).toBe(0);
  }, 60_000);

  it("دو up هم‌زمان: هر دو ۰ و مهاجرت دقیقاً یک بار اعمال می‌شود (قفلِ مشورتی)", async () => {
    for (let round = 0; round < 3; round++) {
      const r = rig();
      await r.migrateSettlement();
      await r.bury("a");
      const [x, y] = await Promise.all([r.run(["up"]), r.run(["up"])]);
      expect([x.exitCode, y.exitCode]).toEqual([0, 0]);
      const applied = [x, y].filter((o) => (o.report.migrations?.appliedNow.length ?? 0) > 0);
      expect(applied).toHaveLength(1);
      expect((await r.q(`SELECT count(*)::int AS n FROM {{s}}.settlement_pending_migration_ledger`))[0]?.["n"]).toBe(1);
      expect((await r.run(["verify"])).report.verify).toMatchObject({ consistent: true, expected: 1 });
    }
  }, 60_000);

  it("پایگاهِ در دسترس‌نبود ⇒ ۴ با بستنِ تمیز؛ نه رشتهٔ اتصال، نه رمز در گزارش", async () => {
    const lines: string[] = [];
    const bad = `postgres://user:${CANARY}@127.0.0.1:1/nodb`;
    const out = await runPendingMigrate({
      argv: ["status"],
      env: { DATABASE_URL: bad },
      ports: {
        open: () => {
          const pool = new Pool({ connectionString: bad, max: 1, idleTimeoutMillis: IDLE_MS, connectionTimeoutMillis: 2000 });
          pool.on("error", () => undefined);
          return { db: drizzle(pool), close: () => pool.end() };
        },
        timer: realTimer,
        write: (l: string) => lines.push(l),
      },
    });
    expect(out.exitCode).toBe(4);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ code: "UNAVAILABLE", phase: "check" });
    expect(lines.join("")).not.toContain(CANARY);
    expect(lines.join("")).not.toContain("127.0.0.1");
  });
});
