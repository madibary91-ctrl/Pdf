/**
 * بازتولیدِ **قطعی** مسابقهٔ `CREATE SCHEMA` در `legal-kb-store` روی PostgreSQL واقعی (ADR-0036؛ هم‌شکلِ ADR-0035).
 * شرطِ شکست (اندازه‌گیری‌شده برای ledger/settlement): بازنده (الف) پیش‌تر با `*Status()` شِما را جست‌وجو کرده، (ب) پس از آن
 * روی همان اتصال یک تراکنشِ DDL اجرا کرده، (ج) پشتِ قفلِ مشورتیِ برنده می‌ماند و برنده همان‌جا commit می‌کند.
 * اتصال‌ها `Client`ِ تکیِ سنجاق‌شده‌اند (نه استخر) تا (الف) و (ب) و (ج) حتماً روی یک بک‌اند بمانند؛ پیش‌شرط‌ها در خودِ آزمون
 * سنجیده می‌شود تا آزمون بی‌صدا تهی نشود. هر دو جای ساختِ شِما (دانش و نمایهٔ جست‌وجو) جداگانه آزموده می‌شوند.
 */
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";
import { searchSchemaName } from "./naming";
import { createKbStore, type KbStore } from "./store";
import type { MigrationReport, MigrationStatus, StoreResult } from "./types";
import { TEST_DB_URL, dbDescribe } from "./test-db";

const APP = `kb-ensure-${process.pid}-${randomBytes(3).toString("hex")}`;

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

function makeStore(c: Client, schema: string): KbStore {
  const made = createKbStore(drizzle(c), { schema });
  if (!made.ok) throw new Error("ساختِ فروشگاه شکست خورد");
  return made.value;
}

type Site = Readonly<{
  label: string;
  /** کلیدِ قفلِ مشورتیِ ماژول (همان که در کد است). */
  lockKey: string;
  /** شِمایی که این جا ساخته می‌شود. */
  target: (kbSchema: string) => string;
  status: (s: KbStore) => Promise<StoreResult<MigrationStatus>>;
  migrate: (s: KbStore) => Promise<StoreResult<MigrationReport>>;
  /** جدولِ دفترِ همان شِما (برای سنجشِ پایان). */
  ledgerTable: string;
}>;

const SITES: readonly Site[] = [
  { label: "شِمای دانش (migrate)", lockKey: "legal-kb-store:migrate", target: (k) => k, status: (s) => s.migrationStatus(), migrate: (s) => s.migrate(), ledgerTable: "migration_ledger" },
  {
    label: "شِمای نمایهٔ جست‌وجو (migrateSearch)",
    lockKey: "legal-kb-store:search-migrate",
    target: (k) => searchSchemaName(k),
    status: (s) => s.searchMigrationStatus(),
    migrate: (s) => s.migrateSearch(),
    ledgerTable: "search_ledger",
  },
];

function freshSchema(): string {
  return `legal_kb_test_${randomBytes(5).toString("hex")}`;
}

async function dropAll(admin: Client, kb: string): Promise<void> {
  for (const s of [kb, `${kb}_audit`, `${kb}_search`, `${kb}_d`]) {
    if (!s.startsWith("legal_kb_test_")) throw new Error("امتناع از حذف شِمایی که آزمونی نیست.");
    await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => undefined);
  }
}

dbDescribe("legal-kb-store · ensureSchema روی PostgreSQL واقعی (بازتولید قطعی)", () => {
  for (const site of SITES) {
    it(`${site.label}: بازندهٔ دارای status و DDLِ پیشین، پشتِ برنده‌ای که شِما را ساخته می‌ماند و بی‌خطا مهاجرت می‌کند`, async () => {
      const kb = freshSchema();
      const target = site.target(kb);
      const decoy = `${kb}_d`;
      const [loser, holder, admin] = await Promise.all([open("loser"), open("holder"), open("admin")]);
      try {
        const store = makeStore(loser, kb);
        const pid = await pidOf(loser);

        const before = await site.status(store); // (الف)
        expect(before.ok && before.value.applied).toEqual([]);
        await loser.query(`CREATE SCHEMA "${decoy}"`); // (ب)
        await loser.query(`CREATE TABLE "${decoy}".t (a int)`);
        expect(await pidOf(loser)).toBe(pid); // همان بک‌اند

        await holder.query("BEGIN"); // (ج) برنده: قفلِ ماژول + ساختِ شِما، هنوز commit نشده
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [site.lockKey]);
        await holder.query(`CREATE SCHEMA "${target}"`);

        const run = site.migrate(store);
        await waitUntilBlocked(admin, pid);
        await holder.query("COMMIT");

        const res = await run;
        expect(res.ok, JSON.stringify(res)).toBe(true);
        const after = await site.status(store);
        expect(after.ok && after.value.pending).toEqual([]);
        expect(after.ok && after.value.applied.length).toBeGreaterThan(0);
        const rows = await admin.query(`SELECT count(*)::int AS n FROM "${target}".${site.ledgerTable}`);
        expect(rows.rows[0].n).toBe(after.ok ? after.value.applied.length : -1);
      } finally {
        await dropAll(admin, kb);
        await Promise.all([loser.end(), holder.end(), admin.end()]);
      }
    });

    it(`${site.label}: برنده شِما و جدولِ دفتر را ساخته؛ بازندهٔ (الف+ب) بی‌خطا مهاجرت می‌کند (سطحِ جدول)`, async () => {
      const kb = freshSchema();
      const target = site.target(kb);
      const [loser, holder, admin] = await Promise.all([open("loser"), open("holder"), open("admin")]);
      try {
        const store = makeStore(loser, kb);
        const pid = await pidOf(loser);
        await site.status(store); // (الف)
        await loser.query(`CREATE SCHEMA "${kb}_d"`); // (ب)
        await loser.query(`CREATE TABLE "${kb}_d".t (a int)`);
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [site.lockKey]);
        await holder.query(`CREATE SCHEMA "${target}"`);
        await holder.query(
          `CREATE TABLE "${target}".${site.ledgerTable} (name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT ${site.ledgerTable}_pk PRIMARY KEY (name))`,
        );
        const run = site.migrate(store);
        await waitUntilBlocked(admin, pid);
        await holder.query("COMMIT");
        const res = await run;
        expect(res.ok, JSON.stringify(res)).toBe(true);
        const after = await site.status(store);
        expect(after.ok && after.value.pending).toEqual([]);
      } finally {
        await dropAll(admin, kb);
        await Promise.all([loser.end(), holder.end(), admin.end()]);
      }
    });

    it(`${site.label}: قفلِ مشترکِ شِما (schema:ensure:<شِما>، هم‌کلید با ledger/settlement): تا وقتی نگه داشته شود migrate پشتِ آن می‌ماند و پس از رهاسازی موفق می‌شود`, async () => {
      const kb = freshSchema();
      const target = site.target(kb);
      const [c, holder, admin] = await Promise.all([open("c"), open("holder"), open("admin")]);
      try {
        const store = makeStore(c, kb);
        const pid = await pidOf(c);
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`schema:ensure:${target}`]);
        const run = site.migrate(store);
        await waitUntilBlocked(admin, pid);
        await holder.query("COMMIT");
        const res = await run;
        expect(res.ok, JSON.stringify(res)).toBe(true);
      } finally {
        await dropAll(admin, kb);
        await Promise.all([c.end(), holder.end(), admin.end()]);
      }
    });

    it(`${site.label}: شِمایی که شخصِ دیگری (مثلاً DBA) پیش‌تر ساخته؛ migrate جدول‌ها را می‌سازد و تکرار بی‌اثر است`, async () => {
      const kb = freshSchema();
      const target = site.target(kb);
      const [c, admin] = await Promise.all([open("c"), open("admin")]);
      try {
        await admin.query(`CREATE SCHEMA "${target}"`);
        const store = makeStore(c, kb);
        const first = await site.migrate(store);
        expect(first.ok, JSON.stringify(first)).toBe(true);
        expect(first.ok && first.value.applied.length).toBeGreaterThan(0);
        const again = await site.migrate(store);
        expect(again.ok && again.value.applied).toEqual([]);
        expect(again.ok && again.value.alreadyApplied.length).toBe(first.ok ? first.value.applied.length : -1);
      } finally {
        await dropAll(admin, kb);
        await Promise.all([c.end(), admin.end()]);
      }
    });
  }

  it("دو مهاجرِ هم‌زمانِ واقعی (status ← migrate ← migrateSearch) روی شِمای تازه، ۱۲ دور: همه موفق، هر مهاجرت دقیقاً یک بار اعمال می‌شود", async () => {
    const admin = await open("admin");
    try {
      for (let round = 0; round < 12; round++) {
        const kb = freshSchema();
        const [a, b] = await Promise.all([open("a"), open("b")]);
        try {
          const go = async (c: Client): Promise<{ migrate: StoreResult<MigrationReport>; search: StoreResult<MigrationReport> }> => {
            const s = makeStore(c, kb);
            await s.migrationStatus();
            await s.searchMigrationStatus();
            const migrate = await s.migrate();
            const search = await s.migrateSearch();
            return { migrate, search };
          };
          const [ra, rb] = await Promise.all([go(a), go(b)]);
          for (const r of [ra, rb]) {
            expect(r.migrate.ok, JSON.stringify(r.migrate)).toBe(true);
            expect(r.search.ok, JSON.stringify(r.search)).toBe(true);
          }
          const appliedOf = (r: StoreResult<MigrationReport>): number => (r.ok ? r.value.applied.length : -1);
          const rows = await admin.query(`SELECT count(*)::int AS n FROM "${kb}".migration_ledger`);
          expect(appliedOf(ra.migrate) + appliedOf(rb.migrate)).toBe(rows.rows[0].n);
          const srows = await admin.query(`SELECT count(*)::int AS n FROM "${searchSchemaName(kb)}".search_ledger`);
          expect(appliedOf(ra.search) + appliedOf(rb.search)).toBe(srows.rows[0].n);
        } finally {
          await dropAll(admin, kb);
          await Promise.all([a.end(), b.end()]);
        }
      }
    } finally {
      await admin.end();
    }
  }, 60_000);
});
