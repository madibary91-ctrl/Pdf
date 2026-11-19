/**
 * بازتولیدِ **قطعی** مسابقهٔ `CREATE SCHEMA` روی PostgreSQL واقعی (ADR-0035)، بدونِ تکیه بر زمان‌بندیِ شانسی.
 * شرطِ شکستِ پیشین (در ADR اندازه‌گیری شده): بازنده (الف) پیش‌تر با `status()` شِما را جست‌وجو کرده، (ب) پس از آن روی همان اتصال
 * یک تراکنشِ DDL اجرا کرده، (ج) پشتِ قفلِ ماژولِ برنده می‌ماند و برنده همان‌جا commit می‌کند. اتصال‌ها `Client`ِ تکیِ سنجاق‌شده‌اند
 * (نه استخر) تا (الف) و (ب) و (ج) حتماً روی یک بک‌اند بمانند؛ پیش‌شرط‌ها در خودِ آزمون سنجیده می‌شود تا آزمون بی‌صدا تهی نشود.
 */
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createPgAccountStore } from "./store";
import { TEST_DB_URL, dbDescribe } from "./test-db";

const APP = `ledger-ensure-${process.pid}-${randomBytes(3).toString("hex")}`;

async function open(name: string): Promise<Client> {
  const c = new Client({ connectionString: TEST_DB_URL, application_name: `${APP}-${name}` });
  await c.connect();
  return c;
}

async function pidOf(c: Client): Promise<number> {
  const r = await c.query("SELECT pg_backend_pid() AS pid");
  return r.rows[0].pid as number;
}

/** صبر تا بک‌اندِ `pid` پشتِ یک قفلِ مشورتیِ نگرفته‌شده بماند؛ در غیر این صورت آزمون شکست می‌خورد (نه سبزِ تهی). */
async function waitUntilBlocked(admin: Client, pid: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const r = await admin.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [pid]);
    if (r.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`بک‌اند ${pid} هیچ‌گاه پشتِ قفلِ مشورتی نماند؛ بازتولید معتبر نیست.`);
}

dbDescribe("ledger/pg · ensureSchema روی PostgreSQL واقعی (بازتولید قطعی)", () => {
  it("بازندهٔ دارای status و DDLِ پیشین، پشتِ برنده‌ای که شِما را ساخته می‌ماند و بی‌خطا مهاجرت می‌کند", async () => {
    const schema = `ledger_ens_${randomBytes(5).toString("hex")}`;
    const decoy = `${schema}_d`;
    const [loser, holder, admin] = await Promise.all([open("loser"), open("holder"), open("admin")]);
    try {
      const made = createPgAccountStore(drizzle(loser), { schema });
      if (!made.ok) throw new Error("ساختِ فروشگاه شکست خورد");
      const store = made.value;
      const pid = await pidOf(loser);

      const before = await store.status(); // (الف)
      expect(before.ok && before.value.applied).toEqual([]);
      await loser.query(`CREATE SCHEMA "${decoy}"`); // (ب)
      await loser.query(`CREATE TABLE "${decoy}".t (a int)`);
      expect(await pidOf(loser)).toBe(pid); // همان بک‌اند

      await holder.query("BEGIN"); // (ج) برنده: قفلِ ماژول + ساختِ شِما، هنوز commit نشده
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ledger:migrate:${schema}`]);
      await holder.query(`CREATE SCHEMA "${schema}"`);

      const run = store.migrate();
      await waitUntilBlocked(admin, pid);
      await holder.query("COMMIT");

      const res = await run;
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const after = await store.status();
      expect(after.ok && after.value.pending).toEqual([]);
      expect(after.ok && after.value.applied.length).toBeGreaterThan(0);
      const rows = await admin.query(`SELECT count(*)::int AS n FROM "${schema}".migration_ledger`);
      expect(rows.rows[0].n).toBe(after.ok ? after.value.applied.length : -1);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS "${decoy}" CASCADE`).catch(() => undefined);
      await Promise.all([loser.end(), holder.end(), admin.end()]);
    }
  });

  it("شِمایی که شخصِ دیگری (مثلاً DBA) پیش‌تر ساخته: migrate جدول‌ها را می‌سازد؛ تکرار بی‌اثر است", async () => {
    const schema = `ledger_ens_${randomBytes(5).toString("hex")}`;
    const [c, admin] = await Promise.all([open("c"), open("admin")]);
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const made = createPgAccountStore(drizzle(c), { schema });
      if (!made.ok) throw new Error("ساختِ فروشگاه شکست خورد");
      const first = await made.value.migrate();
      expect(first.ok && first.value.applied.length).toBeGreaterThan(0);
      const again = await made.value.migrate();
      expect(again.ok && again.value.applied).toEqual([]);
      expect(again.ok && again.value.alreadyApplied.length).toBe(first.ok ? first.value.applied.length : -1);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await Promise.all([c.end(), admin.end()]);
    }
  });

  it("قفلِ مشترکِ شِما: تا وقتی نگه داشته شود migrate پشتِ آن می‌ماند و پس از رهاسازی موفق می‌شود", async () => {
    const schema = `ledger_ens_${randomBytes(5).toString("hex")}`;
    const [c, holder, admin] = await Promise.all([open("c"), open("holder"), open("admin")]);
    try {
      const made = createPgAccountStore(drizzle(c), { schema });
      if (!made.ok) throw new Error("ساختِ فروشگاه شکست خورد");
      const pid = await pidOf(c);
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`schema:ensure:${schema}`]);
      const run = made.value.migrate();
      await waitUntilBlocked(admin, pid);
      await holder.query("COMMIT");
      const res = await run;
      expect(res.ok, JSON.stringify(res)).toBe(true);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await Promise.all([c.end(), holder.end(), admin.end()]);
    }
  });
});
