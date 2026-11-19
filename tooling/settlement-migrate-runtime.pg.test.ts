/**
 * پذیرشِ سرتاسریِ م۳‑ه‑۳‑ج روی PostgreSQL واقعی (ADR-0034): CLIِ مهاجرت ≡ `createPgSettlementRuntime` که برنامه با آن بوت می‌شود.
 *  - پیش از `up`: runtime `start` ⇒ NOT_MIGRATED؛ پس از `up`: ⇒ started. (مهاجرت‌دهنده دقیقاً همان چیزی را آماده می‌کند که بوتِ برنامه می‌خواهد.)
 *  - تفاضلی: applied هر دو (CLI و `runtime.migrate()`) روی شِماهای جدا یکی است.
 *  - `status` ≡ پیش‌بازرسیِ runtime: معلق ⇔ NOT_MIGRATED؛ دست‌کاری ⇔ SCHEMA_MISMATCH.
 * شِماهای یک‌بارمصرفِ `mr_ledger_*`/`mr_settle_*`؛ بودجهٔ اتصال (ADR-0024).
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { runSettlementMigrate } from "@/modules/settlement-migrate";
import type { MigrateReport } from "@/modules/settlement-migrate";
import { createNodeTimer, createPgSettlementRuntime } from "@/modules/settlement-runtime";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;

dbDescribe("tooling · settlement-migrate ≡ settlement-runtime (PostgreSQL)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  function rig() {
    const tag = randomBytes(5).toString("hex");
    const schemas = { ledgerSchema: `mr_ledger_${tag}`, settlementSchema: `mr_settle_${tag}` };
    const pool = new Pool({ connectionString: DB_URL, max: 4, idleTimeoutMillis: IDLE_MS });
    const db = drizzle(pool);
    cleanups.push(async () => {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schemas.ledgerSchema}" CASCADE`);
        await pool.query(`DROP SCHEMA IF EXISTS "${schemas.settlementSchema}" CASCADE`);
      } finally {
        await pool.end();
      }
    });
    const runtime = () => {
      const rt = createPgSettlementRuntime({ db, graceMs: 60_000, deadLetters: false, ...schemas });
      if (!rt.ok) throw new Error("runtime نامعتبر");
      return rt.value;
    };
    const cli = async (argv: string[]): Promise<MigrateReport> => {
      const lines: string[] = [];
      await runSettlementMigrate({
        argv,
        env: { DATABASE_URL: "x", SETTLEMENT_LEDGER_SCHEMA: schemas.ledgerSchema, SETTLEMENT_OUTBOX_SCHEMA: schemas.settlementSchema },
        ports: { open: () => ({ db, close: () => undefined }), timer: createNodeTimer(), write: (l: string) => lines.push(l) },
      });
      return JSON.parse(lines[0] as string) as MigrateReport;
    };
    return { schemas, pool, db, runtime, cli };
  }

  it("پیش از up بوتِ runtime ⇒ NOT_MIGRATED و status ⇒ ۳؛ پس از up بوت موفق و status ⇒ ۰", async () => {
    const r = rig();
    const before = await r.runtime().start();
    expect(before).toMatchObject({ started: false, reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED" });
    expect((await r.cli(["status"])).exitCode).toBe(3);
    expect((await r.cli(["up"])).exitCode).toBe(0);
    expect((await r.cli(["status"])).exitCode).toBe(0);
    const rt = r.runtime();
    const started = await rt.start();
    expect(started.started).toBe(true);
    await rt.stop();
  });

  it("تفاضلی: applied و ترتیبِ CLI ≡ runtime.migrate() روی شِماهای جدا", async () => {
    const a = rig();
    const b = rig();
    const viaCli = await a.cli(["up"]);
    const viaRuntime = await b.runtime().migrate();
    expect(viaRuntime.ok).toBe(true);
    if (!viaRuntime.ok) return;
    expect(viaCli.ledger?.appliedNow).toEqual(viaRuntime.applied.ledger);
    expect(viaCli.settlement?.appliedNow).toEqual(viaRuntime.applied.settlement);
  });

  it("دست‌کاریِ دفتر: status ⇒ ۵ و بوتِ runtime ⇒ SCHEMA_MISMATCH (هر دو یک حکم)", async () => {
    const r = rig();
    expect((await r.cli(["up"])).exitCode).toBe(0);
    await r.pool.query(`UPDATE "${r.schemas.settlementSchema}".settlement_migration_ledger SET checksum = 'tampered'`);
    const st = await r.cli(["status"]);
    expect([st.exitCode, st.stage]).toEqual([5, "settlement"]);
    expect(await r.runtime().start()).toMatchObject({ started: false, reason: "PREFLIGHT_FAILED", code: "SCHEMA_MISMATCH" });
  });

  it("مهاجرتِ ناقص (فقط دفتر): status ⇒ ۳ و بوتِ runtime ⇒ NOT_MIGRATED؛ up تکمیل می‌کند", async () => {
    const r = rig();
    const pre = r.runtime();
    // فقط دفتر را با فروشگاهِ خودش مهاجرت می‌دهیم (outbox معلق می‌ماند): همان حالتِ «نیمه‌کارهٔ» شکستِ میانهٔ up.
    const { createPgAccountStore } = await import("@/modules/ledger");
    const store = createPgAccountStore(r.db, { schema: r.schemas.ledgerSchema });
    if (!store.ok) throw new Error("store");
    expect((await store.value.migrate()).ok).toBe(true);
    const st = await r.cli(["status"]);
    expect([st.exitCode, st.ledger?.pending, st.settlement?.pending.length]).toEqual([3, [], 2]);
    expect(await pre.start()).toMatchObject({ started: false, code: "NOT_MIGRATED" });
    const up = await r.cli(["up"]);
    expect([up.exitCode, up.ledger?.appliedNow]).toEqual([0, []]);
    expect(up.settlement?.appliedNow.length).toBe(2);
    const rt = r.runtime();
    expect((await rt.start()).started).toBe(true);
    await rt.stop();
  });
});
