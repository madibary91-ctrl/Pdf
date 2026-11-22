/**
 * بازتولیدِ **قطعیِ** ناپایداریِ «انتظارِ قفلِ مشورتیِ سراسری» (ADR-0052) روی PostgreSQL واقعی — بی‌اتکا به زمان‌بندیِ فایل‌های دیگر.
 *
 * صحنه: «فایلِ دیگر» (اتصالِ `stranger`) پشتِ قفلِ کلیدِ بیگانه ایستاده؛ آزمونِ ما کلیدِ خودش را دارد.
 *  ۱) پیش‌شرط: پرسشِ قدیم (سراسری) همان لحظه انتظارِ بیگانه را می‌بیند ⇒ ادعای «منتظری نیست» به‌ناحق قرمز می‌شد (باگ بازتولید شد).
 *  ۲) SQLِ دامنه‌دار: برای کلیدِ ما هیچ‌چیز نمی‌بیند؛ برای کلیدِ بیگانه می‌بیند؛ برای فهرستِ هر دو می‌بیند.
 *  ۳) پس از آزادی: دامنه‌دار ⇒ تهی (ادعای «زامبی رفت» درست می‌شود).
 * کلیدهای با هشِ منفی و مثبت هر دو پوشش داده می‌شوند (کلیدِ bigint = classid<<32 | objid؛ بیتِ بالا در هشِ منفی ۱ است).
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { Client } from "pg";
import { afterEach, expect, it } from "vitest";
import { SCOPED_ADVISORY_WAITERS_SQL } from "./advisory-wait-scope";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const HAS_DB = typeof DB_URL === "string" && DB_URL !== "";
const dbIt = HAS_DB ? it : it.skip;
const APP = `adv-scope-${process.pid}-${randomBytes(3).toString("hex")}`;
/** پرسشِ قدیم، عیناً (فقط برای اثباتِ پیش‌شرط). */
const GLOBAL_SQL = "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted";

const clients: Client[] = [];
afterEach(async () => {
  while (clients.length > 0) {
    const c = clients.pop() as Client;
    try {
      await c.query("SELECT pg_advisory_unlock_all()");
    } catch {
      /* اتصال ممکن است پیشتر بسته شده باشد */
    }
    await c.end().catch(() => undefined);
  }
});

async function open(name: string): Promise<Client> {
  const c = new Client({ connectionString: DB_URL, application_name: `${APP}-${name}` });
  clients.push(c);
  await c.connect();
  return c;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const hashOf = async (c: Client, key: string): Promise<bigint> => BigInt(String((await c.query("SELECT hashtextextended($1, 0)::text AS h", [key])).rows[0].h));

/** کلیدی با هشِ منفی/مثبت (تا یافتن؛ احتمالِ ناکامیِ ۶۴ تلاش ≈ 2^-64). */
async function keyWithSign(c: Client, negative: boolean, tag: string): Promise<string> {
  for (let i = 0; i < 64; i++) {
    const key = `adv-scope:${tag}:${i}`;
    if (((await hashOf(c, key)) < BigInt(0)) === negative) return key;
  }
  throw new Error("کلیدِ با علامتِ خواسته پیدا نشد");
}

async function parkOn(admin: Client, key: string): Promise<{ holder: Client; done: Promise<void> }> {
  const holder = await open(`holder-${randomBytes(2).toString("hex")}`);
  await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
  const waiter = await open(`waiter-${randomBytes(2).toString("hex")}`);
  const pid = Number((await waiter.query("SELECT pg_backend_pid() AS p")).rows[0].p);
  const done = waiter.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]).then(() => undefined);
  done.catch(() => undefined);
  // انتظار را از pg_locks (نه sleep) اثبات می‌کنیم.
  for (let i = 0; i < 500; i++) {
    const r = await admin.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [pid]);
    if ((r.rowCount ?? 0) > 0) break;
    if (i === 499) throw new Error("انتظارِ قفل دیده نشد");
    await sleep(10);
  }
  return { holder, done };
}

const scoped = async (c: Client, keys: string[]): Promise<number> => (await c.query(SCOPED_ADVISORY_WAITERS_SQL, [keys])).rowCount ?? 0;
const globalWaiters = async (c: Client): Promise<number> => (await c.query(GLOBAL_SQL)).rowCount ?? 0;

for (const negative of [true, false]) {
  dbIt(`انتظارِ کلیدِ بیگانه (هشِ ${negative ? "منفی" : "مثبت"}): سراسری می‌بیند، دامنه‌دار برای کلیدِ ما نه؛ برای کلیدِ بیگانه و فهرستِ هر دو آری؛ پس از آزادی تهی`, async () => {
    const admin = await open("admin");
    const strangerKey = await keyWithSign(admin, negative, `stranger-${randomBytes(3).toString("hex")}`);
    const ownKey = `adv-scope:own:${randomBytes(4).toString("hex")}`;
    expect(await scoped(admin, [strangerKey])).toBe(0);

    const { holder, done } = await parkOn(admin, strangerKey);

    expect(await globalWaiters(admin)).toBeGreaterThan(0); // پیش‌شرط: پرسشِ قدیم انتظارِ بیگانه را «انتظارِ ما» می‌دید
    expect(await scoped(admin, [ownKey])).toBe(0); // رفع: کلیدِ ما منتظری ندارد
    expect(await scoped(admin, [])).toBe(0); // فهرستِ تهی هرگز چیزی نمی‌بیند
    expect(await scoped(admin, [strangerKey])).toBe(1); // دامنه‌دار واقعاً کار می‌کند (پوچ نیست)
    expect(await scoped(admin, [ownKey, strangerKey])).toBe(1);

    await holder.query("SELECT pg_advisory_unlock_all()");
    await done;
    expect(await scoped(admin, [strangerKey])).toBe(0); // آزاد شد ⇒ «رفت»
  }, 60_000);
}

dbIt("پیشوندِ مشترکِ کلید کافی نیست: کلیدِ ما با نامی شبیهِ بیگانه (یک نویسهٔ کمتر) منتظری نمی‌بیند", async () => {
  const admin = await open("admin");
  const strangerKey = `adv-scope:similar:${randomBytes(3).toString("hex")}`;
  const { holder, done } = await parkOn(admin, strangerKey);
  expect(await scoped(admin, [strangerKey.slice(0, -1)])).toBe(0);
  expect(await scoped(admin, [strangerKey])).toBe(1);
  await holder.query("SELECT pg_advisory_unlock_all()");
  await done;
}, 60_000);
