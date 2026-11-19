/**
 * قفلِ مشترکِ شِما بینِ `ledger` و `settlement` (ADR-0035 تصمیم ۱ و ۲): دو ماژول می‌توانند یک شِما داشته باشند ولی قفل‌های ماژولی‌شان
 * جداست؛ بدونِ قفلِ مشترک، دو سازندهٔ هم‌زمانِ **متفاوتِ** یک شِما `23505` می‌گرفتند (در ADR قطعی ۳ از ۳ اندازه‌گیری شد).
 * کلیدِ قفل در هر ماژول جداگانه نوشته شده (رابطِ عمومیِ ledger عمداً تغییر نکرد)؛ این آزمون برابریِ آن دو را قفل می‌کند:
 * قفل را بیرون نگه می‌داریم، هر دو `migrate()` روی **یک** شِما می‌زنیم و می‌سنجیم هر دو پشتِ همان قفل می‌مانند.
 */
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createPgAccountStore } from "@/modules/ledger";
import { createPgSettlementOutbox } from "./store";
import { TEST_DB_URL, dbDescribe } from "./test-db";

const APP = `shared-ensure-${process.pid}-${randomBytes(3).toString("hex")}`;

async function open(name: string): Promise<Client> {
  const c = new Client({ connectionString: TEST_DB_URL, application_name: `${APP}-${name}` });
  await c.connect();
  return c;
}

async function blockedOnAdvisory(admin: Client, pid: number): Promise<boolean> {
  for (let i = 0; i < 500; i++) {
    const r = await admin.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [pid]);
    if (r.rowCount === 1) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

dbDescribe("ledger + settlement · قفلِ مشترکِ شِما روی PostgreSQL واقعی", () => {
  it("هر دو ماژول روی یک شِما پشتِ قفلِ «schema:ensure:<شِما>» می‌مانند و پس از رهاسازی هر دو موفق‌اند", async () => {
    const schema = `shared_ens_${randomBytes(5).toString("hex")}`;
    const [cl, cs, holder, admin] = await Promise.all([open("ledger"), open("settlement"), open("holder"), open("admin")]);
    try {
      const ledger = createPgAccountStore(drizzle(cl), { schema });
      const outbox = createPgSettlementOutbox(drizzle(cs), { schema });
      if (!ledger.ok || !outbox.ok) throw new Error("ساختِ فروشگاه شکست خورد");
      const pidL = ((await cl.query("SELECT pg_backend_pid() AS pid")).rows[0] as { pid: number }).pid;
      const pidS = ((await cs.query("SELECT pg_backend_pid() AS pid")).rows[0] as { pid: number }).pid;

      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`schema:ensure:${schema}`]);
      const runL = ledger.value.migrate();
      const runS = outbox.value.migrate();
      expect(await blockedOnAdvisory(admin, pidL), "ledger باید پشتِ قفلِ مشترکِ شِما بماند").toBe(true);
      expect(await blockedOnAdvisory(admin, pidS), "settlement باید پشتِ قفلِ مشترکِ شِما بماند").toBe(true);
      // هنوز هیچ‌چیز ساخته نشده (قفل پیش از CREATE SCHEMA گرفته می‌شود)
      expect((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rowCount).toBe(0);

      await holder.query("COMMIT");
      const [rl, rs] = await Promise.all([runL, runS]);
      expect(rl.ok, JSON.stringify(rl)).toBe(true);
      expect(rs.ok, JSON.stringify(rs)).toBe(true);
      const tables = await admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('migration_ledger', 'settlement_migration_ledger') ORDER BY 1", [schema]);
      expect(tables.rows.map((r: { table_name: string }) => r.table_name)).toEqual(["migration_ledger", "settlement_migration_ledger"]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await Promise.all([cl.end(), cs.end(), holder.end(), admin.end()]);
    }
  });

  it("۲۰ دورِ هم‌زمانیِ آزاد (بی‌زمان‌بندیِ کنترل‌شده) روی شِمای مشترکِ تازه: هیچ‌کدام نمی‌شکند", async () => {
    for (let round = 0; round < 20; round++) {
      const schema = `shared_ens_${randomBytes(5).toString("hex")}`;
      const [cl, cs, admin] = await Promise.all([open("ledger"), open("settlement"), open("admin")]);
      try {
        const ledger = createPgAccountStore(drizzle(cl), { schema });
        const outbox = createPgSettlementOutbox(drizzle(cs), { schema });
        if (!ledger.ok || !outbox.ok) throw new Error("ساختِ فروشگاه شکست خورد");
        const [rl, rs] = await Promise.all([ledger.value.migrate(), outbox.value.migrate()]);
        expect(rl.ok, `دور ${round}: ${JSON.stringify(rl)}`).toBe(true);
        expect(rs.ok, `دور ${round}: ${JSON.stringify(rs)}`).toBe(true);
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await Promise.all([cl.end(), cs.end(), admin.end()]);
      }
    }
  });
});
