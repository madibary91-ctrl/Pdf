/**
 * بازتولیدِ **قطعیِ** ناپایداریِ دروازه (تحویل ۰۰۳۹ بند ۶‑۱؛ ADR-0040) روی PostgreSQL واقعی — بی‌اتکا به زمان‌بندیِ فایل‌ها.
 *
 * صحنه: runner یک مهاجرتِ `legal-kb-store` می‌زند؛ «فایلِ دیگر» (اتصالِ `other`) قفلِ **سراسریِ** ماژول را نگه داشته و نگهدارندهٔ
 * آزمونِ بین‌ماژولی (`holder`) قفلِ **کانونیِ** `schema:ensure:<شِما>` را. پس runner نخست پشتِ کلیدِ سراسری (غیرِ کانونی) می‌ماند.
 *  ۱) پیش‌شرط: همان لحظه مشاهدهٔ ساده (روشِ قدیم: «تا اولین انتظار») دقیقاً `[false]` است ⇒ باگِ قدیم واقعاً بازتولید می‌شود.
 *  ۲) گذرا: `other` آزاد می‌شود ⇒ `waitForCanonicalWait` باید `[true]` برگرداند (روشِ قدیم اینجا قرمز بود).
 *  ۳) دائمی (شکستِ بسته): `other` هرگز آزاد نمی‌شود ⇒ با بودجهٔ کوچک `[false]` برمی‌گردد، نه `[true]` و نه `null`.
 * هر دو قفلِ سراسری (`migrate` و `search-migrate`) پوشش داده می‌شوند. اتصال‌ها با `application_name` یکتا و همیشه بسته می‌شوند.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createKbStore, searchSchemaName } from "@/modules/legal-kb-store";
import { waitForCanonicalWait } from "./lock-wait";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const HAS_DB = typeof DB_URL === "string" && DB_URL !== "";
const APP = `lock-wait-${process.pid}-${randomBytes(3).toString("hex")}`;
const dbIt = HAS_DB ? it : it.skip;

type Site = Readonly<{ label: string; globalKey: string; target: (base: string) => string; prepare: boolean; run: (c: Client, base: string) => Promise<{ ok: boolean }> }>;

function kbOf(c: Client, schema: string) {
  const made = createKbStore(drizzle(c), { schema });
  if (!made.ok) throw new Error("ساختِ فروشگاهِ kb شکست خورد");
  return made.value;
}

const SITES: readonly Site[] = [
  { label: "migrate ← قفلِ سراسریِ legal-kb-store:migrate", globalKey: "legal-kb-store:migrate", target: (b) => b, prepare: false, run: (c, b) => kbOf(c, b).migrate() },
  { label: "migrateSearch ← قفلِ سراسریِ legal-kb-store:search-migrate", globalKey: "legal-kb-store:search-migrate", target: (b) => searchSchemaName(b), prepare: true, run: (c, b) => kbOf(c, b).migrateSearch() },
];

async function open(name: string): Promise<Client> {
  const c = new Client({ connectionString: DB_URL, application_name: `${APP}-${name}` });
  await c.connect();
  return c;
}

async function waitingKeys(admin: Client, pid: number, key: string): Promise<readonly boolean[]> {
  const r = await admin.query(
    `SELECT (((classid::text::bigint) << 32) | (objid::text::bigint)) = hashtextextended($2, 0) AS is_canonical
       FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
    [pid, key],
  );
  return r.rows.map((x: { is_canonical: boolean }) => x.is_canonical);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** روشِ قدیم، عیناً: تا اولین انتظارِ هر کلیدی (فقط برای اثباتِ پیش‌شرط). */
async function firstObservedWait(admin: Client, pid: number, key: string): Promise<readonly boolean[] | null> {
  for (let i = 0; i < 500; i++) {
    const w = await waitingKeys(admin, pid, key);
    if (w.length > 0) return w;
    await sleep(10);
  }
  return null;
}

async function dropAll(admin: Client, base: string): Promise<void> {
  for (const s of [base, `${base}_audit`, searchSchemaName(base)]) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
}

async function exists(admin: Client, schema: string): Promise<boolean> {
  return (await admin.query("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1", [schema])).rowCount === 1;
}

type Scene = Readonly<{ base: string; target: string; canonical: string; pid: number; admin: Client; other: Client; holder: Client; running: Promise<{ ok: boolean }> }>;

/** صحنه را می‌چیند و runner را پشتِ قفلِ سراسریِ `other` و کانونیِ `holder` می‌اندازد؛ تا دیدنِ انتظارِ غیرِ کانونی صبر می‌کند. */
async function withScene(site: Site, body: (s: Scene) => Promise<void>): Promise<void> {
  const base = `lw_${randomBytes(5).toString("hex")}`;
  const [runner, holder, other, admin] = await Promise.all([open("runner"), open("holder"), open("other"), open("admin")]);
  try {
    if (site.prepare) {
      const prepared = await kbOf(runner, base).migrate();
      if (!prepared.ok) throw new Error("پیش‌نیازِ migrate شکست خورد");
    }
    const target = site.target(base);
    const canonical = `schema:ensure:${target}`;
    const pid = ((await runner.query("SELECT pg_backend_pid() AS pid")).rows[0] as { pid: number }).pid;
    await other.query("BEGIN");
    await other.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [site.globalKey]);
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [canonical]);
    const running = site.run(runner, base);
    // پیش‌شرطِ بازتولید: روشِ قدیم همین‌جا `[false]` می‌بیند (پشتِ کلیدِ سراسری، نه کانونی).
    expect(await firstObservedWait(admin, pid, canonical), `${site.label}: runner باید نخست پشتِ کلیدِ سراسری بماند`).toEqual([false]);
    await body({ base, target, canonical, pid, admin, other, holder, running });
  } finally {
    await other.query("ROLLBACK").catch(() => undefined);
    await holder.query("ROLLBACK").catch(() => undefined);
    await dropAll(admin, base);
    await Promise.all([runner.end(), holder.end(), other.end(), admin.end()]);
  }
}

for (const site of SITES) {
  dbIt(`${site.label}: انتظارِ گذرا پشتِ قفلِ سراسری تحمل می‌شود و به انتظارِ کانونی [true] می‌رسد`, async () => {
    await withScene(site, async ({ target, canonical, pid, admin, other, holder, running }) => {
      const waiting = waitForCanonicalWait({ probe: () => waitingKeys(admin, pid, canonical), sleep, pollMs: 10, idlePolls: 500, transientPolls: 2000 });
      await sleep(150); // چند پرسشِ [false] واقعی می‌گذرد
      await other.query("COMMIT"); // «فایلِ دیگر» قفلِ سراسری را رها می‌کند ⇒ runner به قفلِ کانونی می‌رسد
      expect(await waiting, `${site.label}: باید [true] شود`).toEqual([true]);
      await holder.query("COMMIT");
      expect((await running).ok, `${site.label}: پس از رهاسازی باید موفق شود`).toBe(true);
      expect(await exists(admin, target)).toBe(true);
    });
  }, 60_000);

  dbIt(`${site.label}: شکستِ بسته — اگر قفلِ سراسری هرگز آزاد نشود [false] برمی‌گردد (نه [true]، نه null)`, async () => {
    await withScene(site, async ({ target, canonical, pid, admin, other, holder, running }) => {
      const result = await waitForCanonicalWait({ probe: () => waitingKeys(admin, pid, canonical), sleep, pollMs: 5, idlePolls: 20, transientPolls: 40 });
      expect(result).toEqual([false]);
      // پاک‌سازیِ مرتب: همه رها می‌شوند و مهاجرت بی‌خطا تمام می‌شود.
      await other.query("COMMIT");
      await holder.query("COMMIT");
      expect((await running).ok).toBe(true);
      expect(await exists(admin, target)).toBe(true);
    });
  }, 60_000);
}
