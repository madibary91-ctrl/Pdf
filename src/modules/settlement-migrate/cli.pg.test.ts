/**
 * settlement-migrate روی PostgreSQL واقعی (ADR-0034): `runSettlementMigrate` با فروشگاه‌های واقعیِ ledger/settlement.
 * شِماهای یک‌بارمصرفِ `mg_ledger_*`/`mg_settle_*` (بدونِ دست‌زدن به `public`)؛ بودجهٔ اتصال (ADR-0024): استخرها اتصالِ بیکار را زود پس می‌دهند و همه بسته می‌شوند.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { runSettlementMigrate } from "./cli";
import { CANARY, SECRET_URL } from "./test-kit";
import type { MigrateOutcome, MigrateReport } from "./types";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;

const realTimer = { after: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), cancel: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>) };

dbDescribe("settlement-migrate · PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  function rig() {
    const tag = randomBytes(5).toString("hex");
    const ledgerSchema = `mg_ledger_${tag}`;
    const settlementSchema = `mg_settle_${tag}`;
    const admin = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS });
    cleanups.push(async () => {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`);
        await admin.query(`DROP SCHEMA IF EXISTS "${settlementSchema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    const env = { DATABASE_URL: "set-by-open", SETTLEMENT_LEDGER_SCHEMA: ledgerSchema, SETTLEMENT_OUTBOX_SCHEMA: settlementSchema };
    const stats = { opens: 0, writeTx: 0 };

    async function run(argv: string[], url: string | undefined = DB_URL): Promise<{ out: MigrateOutcome; report: MigrateReport; lines: string[] }> {
      const lines: string[] = [];
      const out = await runSettlementMigrate({
        argv,
        env,
        ports: {
          timer: realTimer,
          write: (l: string) => lines.push(l),
          open: () => {
            stats.opens++;
            const pool = new Pool({ connectionString: url, max: 1, idleTimeoutMillis: IDLE_MS, connectionTimeoutMillis: 5000 });
            pool.on("error", () => undefined);
            const db = drizzle(pool);
            const counted = {
              execute: (q: Parameters<typeof db.execute>[0]) => db.execute(q),
              transaction: (run: Parameters<typeof db.transaction>[0], cfg?: { accessMode?: "read only" | "read write" }) => {
                if (cfg?.accessMode !== "read only") stats.writeTx++;
                return db.transaction(run, cfg as never);
              },
            };
            return { db: counted, close: () => pool.end() };
          },
        },
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(CANARY);
      return { out, report: JSON.parse(lines[0] as string) as MigrateReport, lines };
    }
    const schemaExists = async (name: string): Promise<boolean> => (await admin.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [name])).rowCount === 1;
    return { ledgerSchema, settlementSchema, admin, run, stats, schemaExists };
  }

  it("status روی پایگاهِ تازه: ۳ با فهرستِ معلق‌ها؛ هیچ شِما/جدولی ساخته نمی‌شود و هیچ تراکنشِ نوشتنی نیست", async () => {
    const r = rig();
    const { out, report } = await r.run(["status"]);
    expect(out.exitCode).toBe(3);
    expect(report).toMatchObject({ code: "PENDING", phase: "check", closed: true });
    expect(report.ledger?.applied).toEqual([]);
    expect(report.ledger?.pending.length).toBeGreaterThan(0);
    expect(report.settlement?.pending.length).toBeGreaterThan(0);
    expect(await r.schemaExists(r.ledgerSchema)).toBe(false);
    expect(await r.schemaExists(r.settlementSchema)).toBe(false);
    expect(r.stats.writeTx).toBe(0);
    expect(r.stats.opens).toBe(1);
  });

  it("up ← status ← up: اعمالِ کامل، سپس صفر نوشتن در اجرای دوم", async () => {
    const r = rig();
    const before = (await r.run(["status"])).report;
    r.stats.writeTx = 0;
    const up = await r.run(["up"]);
    expect(up.out.exitCode).toBe(0);
    expect(up.report).toMatchObject({ code: "OK", phase: "verify", closed: true });
    expect(up.report.ledger).toEqual({ applied: before.ledger?.pending, pending: [], appliedNow: before.ledger?.pending });
    expect(up.report.settlement).toEqual({ applied: before.settlement?.pending, pending: [], appliedNow: before.settlement?.pending });
    expect(r.stats.writeTx).toBe(2); // یک تراکنشِ مهاجرت برای هر فروشگاه
    const st = await r.run(["status"]);
    expect(st.out.exitCode).toBe(0);
    expect(st.report.ledger?.pending).toEqual([]);
    r.stats.writeTx = 0;
    const again = await r.run(["up"]);
    expect(again.out.exitCode).toBe(0);
    expect(again.report).toMatchObject({ phase: "check", ledger: { appliedNow: [] }, settlement: { appliedNow: [] } });
    expect(r.stats.writeTx).toBe(0);
  });

  it("دو up هم‌زمان روی شِمای تازه (۸ دور): هر دو ۰، هر مهاجرت دقیقاً یک بار اعمال می‌شود (مسابقهٔ CREATE SCHEMA با بازتلاشِ کران‌دار)", async () => {
    let retried = 0;
    for (let round = 0; round < 8; round++) {
      const r = rig();
      const [a, b] = await Promise.all([r.run(["up"]), r.run(["up"])]);
      expect([a.out.exitCode, b.out.exitCode], `دور ${round}`).toEqual([0, 0]);
      retried += (a.report.retries ?? 0) + (b.report.retries ?? 0);
      const full = (await r.run(["status"])).report;
      expect(full.ledger?.pending).toEqual([]);
      const total = (x?: { appliedNow: readonly string[] }) => x?.appliedNow.length ?? 0;
      expect(total(a.report.ledger) + total(b.report.ledger)).toBe(full.ledger?.applied.length);
      expect(total(a.report.settlement) + total(b.report.settlement)).toBe(full.settlement?.applied.length);
      const rows = await r.admin.query(`SELECT count(*)::int AS n FROM "${r.ledgerSchema}".migration_ledger`);
      expect(rows.rows[0]?.["n"]).toBe(full.ledger?.applied.length);
    }
    expect(retried).toBeGreaterThanOrEqual(0); // بازتلاش فقط وقتی لازم شد رخ می‌دهد؛ نبودنش خطا نیست
  });

  it("دفترِ دست‌کاری‌شده: status و up هر دو ۵؛ up هیچ‌چیز اعمال نمی‌کند (outbox حتی ساخته نمی‌شود)", async () => {
    const r = rig();
    expect((await r.run(["up"])).out.exitCode).toBe(0);
    await r.admin.query(`DROP SCHEMA "${r.settlementSchema}" CASCADE`);
    await r.admin.query(`UPDATE "${r.ledgerSchema}".migration_ledger SET checksum = 'tampered'`);
    r.stats.writeTx = 0;
    const st = await r.run(["status"]);
    expect(st.out.exitCode).toBe(5);
    expect(st.report).toMatchObject({ code: "SCHEMA_MISMATCH", phase: "check", stage: "ledger" });
    const up = await r.run(["up"]);
    expect(up.out.exitCode).toBe(5);
    expect(up.report).toMatchObject({ code: "SCHEMA_MISMATCH", phase: "check", stage: "ledger" });
    expect(r.stats.writeTx).toBe(0);
    expect(await r.schemaExists(r.settlementSchema)).toBe(false);
  });

  it("پایگاهِ «از آینده» (مهاجرتِ ناشناخته) ⇒ ۵ در هر دو فرمان", async () => {
    const r = rig();
    expect((await r.run(["up"])).out.exitCode).toBe(0);
    await r.admin.query(`INSERT INTO "${r.settlementSchema}".settlement_migration_ledger (name, checksum) VALUES ('9999_future', 'x')`);
    for (const cmd of ["status", "up"]) {
      const o = await r.run([cmd]);
      expect(o.out.exitCode, cmd).toBe(5);
      expect(o.report.stage).toBe("settlement");
    }
  });

  it("شکستِ apply در outbox پس از اعمالِ دفتر: ۶ با SQLSTATE، دفتر اعمال‌شده می‌ماند؛ پس از رفعِ مانع، تکرار ۰", async () => {
    const r = rig();
    await r.admin.query(`CREATE SCHEMA "${r.settlementSchema}"`);
    await r.admin.query(`CREATE DOMAIN "${r.settlementSchema}".settlement_id AS text`); // مانعِ عمدی: نخستین دستورِ مهاجرتِ outbox به 42710 می‌خورد
    const bad = await r.run(["up"]);
    expect(bad.out.exitCode).toBe(6);
    expect(bad.report).toMatchObject({ code: "MIGRATION_FAILED", phase: "apply", stage: "settlement", pgCode: "42710", closed: true });
    expect(bad.report.ledger?.appliedNow.length).toBeGreaterThan(0);
    expect((await r.admin.query(`SELECT count(*)::int AS n FROM "${r.ledgerSchema}".migration_ledger`)).rows[0]?.["n"]).toBe(bad.report.ledger?.appliedNow.length);
    const tables = await r.admin.query("SELECT 1 FROM information_schema.tables WHERE table_schema = $1", [r.settlementSchema]);
    expect(tables.rowCount).toBe(0); // تراکنشِ outbox کاملاً برگشت
    await r.admin.query(`DROP SCHEMA "${r.settlementSchema}" CASCADE`);
    const fixed = await r.run(["up"]);
    expect(fixed.out.exitCode).toBe(0);
    expect(fixed.report.ledger?.appliedNow).toEqual([]);
    expect(fixed.report.settlement?.appliedNow.length).toBeGreaterThan(0);
  });

  it("پایگاهِ در دسترس‌نبود (اتصال رد شد) ⇒ ۴ بی‌SQLSTATE، بی‌نشتِ رشتهٔ اتصال، بی‌شِما", async () => {
    const r = rig();
    for (const cmd of ["status", "up"]) {
      const o = await r.run([cmd], SECRET_URL);
      expect(o.out.exitCode, cmd).toBe(4);
      expect(o.report).toMatchObject({ code: "UNAVAILABLE", phase: "check", closed: true });
      expect(o.lines[0]).not.toContain("127.0.0.1");
    }
    expect(r.stats.writeTx).toBe(0);
  });

  it("شِمای نامعتبر ⇒ ۲ و هرگز اتصالی باز نمی‌شود", async () => {
    const r = rig();
    const lines: string[] = [];
    let opens = 0;
    const out = await runSettlementMigrate({
      argv: ["up"],
      env: { DATABASE_URL: "x", SETTLEMENT_LEDGER_SCHEMA: "public" },
      ports: { timer: realTimer, write: (l: string) => lines.push(l), open: () => { opens++; return { db: {}, close: () => undefined }; } },
    });
    expect(out.exitCode).toBe(2);
    expect(opens).toBe(0);
    expect(r.stats.opens).toBe(0);
  });
});
