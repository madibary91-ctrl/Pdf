/**
 * پیمانِ **بین‌ماژولیِ** قفلِ مشترکِ ساختِ شِما روی PostgreSQL واقعی (م۳‑ه‑۳‑و؛ ADR-0037).
 *
 * چرا؟ کلیدِ `schema:ensure:<شِما>` در سه ماژول (`ledger`، `settlement`، `legal-kb-store`) **جداگانه نوشته شده** (قرارداد عمومیِ ledger عوض نشد).
 * آزمون‌های درونِ ماژول کلیدِ **همان ماژول** را با یک لیترالِ خودشان می‌سنجند؛ پس رانشِ تکی را می‌گیرند، اما اگر کلید و آزمونِ درونِ‌ماژولیِ آن
 * با هم ویرایش شوند (در بازبینیِ همان ماژول کاملاً منطقی به نظر می‌رسد) هیچ آزمونی قرمز نمی‌شود، ولی دو سازندهٔ هم‌زمانِ متفاوتِ یک شِما دوباره
 * `23505` می‌گیرند. این آزمون تنها پلِ این سه است: همه را با **یک** کلیدِ کانونی در یک جا می‌سنجد.
 *
 * روش (قطعی، بی‌زمان‌بندیِ شانسی): یک نگهدارنده قفلِ **کانونیِ** این آزمون را بیرون نگه می‌دارد؛ هر نقطهٔ ساختِ شِما
 * (ledger، settlement، kb-migrate، kb-migrateSearch) جداگانه روی شِمای تازه اجرا می‌شود و باید:
 *   ۱) پشتِ یک قفلِ مشورتیِ نگرفته‌شده بماند و **کلیدِ همان قفل برابرِ کلیدِ کانونی باشد** (از `pg_locks`، نه فقط «یک قفل»)،
 *   ۲) پس از رهاسازی موفق شود و شِما ساخته شده باشد.
 * کنترلِ منفی: با نگهداشتنِ کلیدِ **نامرتبط** هیچ‌کدام نباید بماند؛ وگرنه آشکارساز تهی است.
 * سپس `legal-kb-store` × `settlement` روی **یک** شِما چند دورِ مهاجرتِ هم‌زمانِ واقعی می‌زنند.
 * (ledger و kb هر دو جدولِ `migration_ledger` دارند و هرگز شِمای مشترک ندارند؛ پس آن جفت فقط با آزمونِ کلید پوشش می‌یابد.)
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createKbStore, searchSchemaName } from "@/modules/legal-kb-store";
import { createPgAccountStore } from "@/modules/ledger";
import { createPgSettlementOutbox } from "@/modules/settlement";
import { waitForCanonicalWait } from "./lock-wait";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const HAS_DB = typeof DB_URL === "string" && DB_URL !== "";
const APP = `schema-key-parity-${process.pid}-${randomBytes(3).toString("hex")}`;

/** تنها تعریفِ کانونیِ کلید در این آزمون؛ تغییرِ عمدیِ کلید در کد باید همین‌جا و در آزمونِ ایستا هم‌زمان بیاید. */
const canonicalKey = (schema: string): string => `schema:ensure:${schema}`;

type Outcome = Readonly<{ ok: boolean }>;
type Site = Readonly<{
  label: string;
  /** شِمایی که این نقطه می‌سازد (برای kb-search شِمای `_search`). */
  target: (base: string) => string;
  /** پیش‌نیازِ بی‌قفل روی شِمای پایه (فقط جاهایی که لازم است). */
  prepare?: (c: Client, base: string) => Promise<void>;
  run: (c: Client, base: string) => Promise<Outcome>;
}>;

function kbOf(c: Client, schema: string) {
  const made = createKbStore(drizzle(c), { schema });
  if (!made.ok) throw new Error("ساختِ فروشگاهِ kb شکست خورد");
  return made.value;
}

const SITES: readonly Site[] = [
  {
    label: "ledger.migrate",
    target: (b) => b,
    run: async (c, b) => {
      const s = createPgAccountStore(drizzle(c), { schema: b });
      if (!s.ok) throw new Error("ساختِ فروشگاهِ ledger شکست خورد");
      return s.value.migrate();
    },
  },
  {
    label: "settlement.migrate",
    target: (b) => b,
    run: async (c, b) => {
      const s = createPgSettlementOutbox(drizzle(c), { schema: b });
      if (!s.ok) throw new Error("ساختِ outbox شکست خورد");
      return s.value.migrate();
    },
  },
  { label: "legal-kb-store.migrate", target: (b) => b, run: (c, b) => kbOf(c, b).migrate() },
  {
    label: "legal-kb-store.migrateSearch",
    target: (b) => searchSchemaName(b),
    prepare: async (c, b) => {
      const r = await kbOf(c, b).migrate();
      if (!r.ok) throw new Error("پیش‌نیازِ migrate شکست خورد");
    },
    run: (c, b) => kbOf(c, b).migrateSearch(),
  },
];

async function open(name: string): Promise<Client> {
  const c = new Client({ connectionString: DB_URL, application_name: `${APP}-${name}` });
  await c.connect();
  return c;
}

async function pidOf(c: Client): Promise<number> {
  return ((await c.query("SELECT pg_backend_pid() AS pid")).rows[0] as { pid: number }).pid;
}

/** برای هر قفلِ مشورتیِ نگرفته‌شدهٔ بک‌اندِ `pid`: «کلیدش برابرِ کلیدِ کانونی است؟» (بازسازیِ bigint از classid/objid). */
async function waitingKeys(admin: Client, pid: number, key: string): Promise<readonly boolean[]> {
  const r = await admin.query(
    `SELECT (((classid::text::bigint) << 32) | (objid::text::bigint)) = hashtextextended($2, 0) AS is_canonical
       FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
    [pid, key],
  );
  return r.rows.map((x: { is_canonical: boolean }) => x.is_canonical);
}

/**
 * صبر تا بک‌اند پشتِ **قفلِ کانونی** بماند؛ در غیر این صورت `null` (آزمون باید شکست بخورد، نه سبزِ تهی).
 * انتظارِ گذرا پشتِ قفلِ سراسریِ ماژول (فایلِ آزمونِ دیگری هم‌زمان مهاجرت می‌زند) تحمل می‌شود؛ منطق و دلیل: `tooling/lock-wait.ts` (ADR-0040).
 * اگر هیچ‌گاه کانونی نشد، آخرین مشاهدهٔ غیرِ تهی برمی‌گردد و ادعای «دقیقاً [true]» همچنان قرمز می‌شود.
 */
function waitUntilBlocked(admin: Client, pid: number, key: string): Promise<readonly boolean[] | null> {
  return waitForCanonicalWait({
    probe: () => waitingKeys(admin, pid, key),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs: 10,
    idlePolls: 500, // ≈۵ث بدونِ هیچ انتظاری ⇒ null (همان کرانِ پیشین)
    transientPolls: 2000, // ≈۲۰ث تحملِ انتظارِ گذرا پشتِ کلیدِ دیگر (زیرِ مهلتِ ۶۰ث آزمون)
  });
}

async function dropAll(admin: Client, base: string): Promise<void> {
  for (const s of [base, `${base}_audit`, searchSchemaName(base)]) await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
}

async function exists(admin: Client, schema: string): Promise<boolean> {
  return (await admin.query("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1", [schema])).rowCount === 1;
}

const dbIt = HAS_DB ? it : it.skip;

for (const site of SITES) {
  dbIt(`${site.label}: پشتِ قفلِ کانونیِ «schema:ensure:<شِما>» می‌ماند و پس از رهاسازی موفق می‌شود`, async () => {
    const base = `ske_${randomBytes(5).toString("hex")}`;
    const [runner, holder, admin] = await Promise.all([open("runner"), open("holder"), open("admin")]);
    try {
      if (site.prepare) await site.prepare(runner, base);
      const target = site.target(base);
      const key = canonicalKey(target);
      const pid = await pidOf(runner);

      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      const running = site.run(runner, base);
      const waiting = await waitUntilBlocked(admin, pid, key);
      expect(waiting, `${site.label} هیچ‌گاه پشتِ قفلِ مشورتی نماند؛ آزمون معتبر نیست`).not.toBeNull();
      // دقیقاً یک قفلِ در انتظار و آن همان کلیدِ کانونی است (نه قفلِ ماژولیِ دیگر).
      expect(waiting, `${site.label} پشتِ کلیدی غیر از «${key}» مانده است`).toEqual([true]);

      await holder.query("COMMIT");
      const result = await running;
      expect(result.ok, `${site.label} پس از رهاسازیِ قفل باید موفق شود`).toBe(true);
      expect(await exists(admin, target), `${site.label}: شِمای هدف ساخته نشد`).toBe(true);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await dropAll(admin, base);
      await Promise.all([runner.end(), holder.end(), admin.end()]);
    }
  }, 60_000);

  dbIt(`${site.label}: کنترلِ منفی — با قفلِ نامرتبط نمی‌ماند (آشکارساز تهی نیست)`, async () => {
    const base = `ske_${randomBytes(5).toString("hex")}`;
    const [runner, holder, admin] = await Promise.all([open("runner"), open("holder"), open("admin")]);
    try {
      if (site.prepare) await site.prepare(runner, base);
      const target = site.target(base);
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${canonicalKey(target)}-unrelated`]);
      const result = await site.run(runner, base);
      expect(result.ok, `${site.label} نباید پشتِ کلیدِ نامرتبط بماند`).toBe(true);
      expect(await exists(admin, target)).toBe(true);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await dropAll(admin, base);
      await Promise.all([runner.end(), holder.end(), admin.end()]);
    }
  }, 60_000);
}

const ROUNDS = 8;

dbIt(`legal-kb-store × settlement روی یک شِما: ${ROUNDS} دور مهاجرتِ هم‌زمانِ واقعی (با status پیش از DDL) هر دو موفق‌اند`, async () => {
  const admin = await open("admin");
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const base = `ske_${randomBytes(5).toString("hex")}`;
      const [ck, cs] = await Promise.all([open(`kb-${round}`), open(`st-${round}`)]);
      try {
        const kb = kbOf(ck, base);
        const outbox = createPgSettlementOutbox(drizzle(cs), { schema: base });
        if (!outbox.ok) throw new Error("ساختِ outbox شکست خورد");
        // هر دو پیش‌تر شِما را «نبود» دیده‌اند (شرطِ بازتولیدِ ADR-0035) و سپس هم‌زمان DDL می‌زنند.
        await Promise.all([kb.migrationStatus(), outbox.value.status()]);
        const [a, b] = await Promise.all([kb.migrate(), outbox.value.migrate()]);
        expect(a.ok, `دور ${round}: kb ${JSON.stringify(a)}`).toBe(true);
        expect(b.ok, `دور ${round}: settlement ${JSON.stringify(b)}`).toBe(true);
        expect(await exists(admin, base)).toBe(true);
      } finally {
        await dropAll(admin, base);
        await Promise.all([ck.end(), cs.end()]);
      }
    }
  } finally {
    await admin.end();
  }
}, 120_000);
