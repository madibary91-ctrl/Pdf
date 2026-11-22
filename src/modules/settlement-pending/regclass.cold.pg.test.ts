/**
 * settlement-pending · ناپایداریِ «کنترل منفیِ» کشِ کاتالوگ (ADR-0052، بندِ ۲ از ۰۰۵۱) — بازتولیدِ **قطعی** بی‌اتکا به بارِ ماشین.
 *
 * علت: استخرِ آزمون `idleTimeoutMillis`=${POOL_IDLE_MS}ms دارد (بودجهٔ اتصال، ADR-0024). اگر میانِ «گرم‌کردنِ» اتصال و آغازِ تراکنشِ منتظرِ قفل
 * بیش از این مدت بگذرد (زیرِ بارِ موازیِ دروازه رخ می‌دهد)، اتصالِ گرم بسته و اتصالِ **سرد** جایش می‌آید؛ اتصالِ سرد کشِ کهنه ندارد و
 * `to_regclass`ِ خام هم درست می‌گوید ⇒ ادعای «کهنه می‌شود» (`raw=true`) به‌ناحق قرمز می‌شد.
 * اینجا فاصله را **عمداً** ۴ برابرِ مهلتِ بیکاری می‌کنیم: (۱) اتصالِ گرمِ بی‌نگهداری واقعاً سرد می‌شود (pid عوض می‌شود و `raw=false`)؛
 * (۲) گرم‌کردنِ درونِ همان تراکنش (شکلِ اصلاح‌شدهٔ کنترل منفی) با همان فاصله هنوز کهنگی را نشان می‌دهد.
 */
import { sql } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { dbDescribe, openPendingKit, POOL_IDLE_MS, type PendingKit } from "./pg-kit";
import { MIGRATIONS, renderStatement, rollbackStatements } from "./migrations";

const opened: PendingKit[] = [];
afterAll(async () => {
  for (const k of opened) await k.dispose();
});
const first = MIGRATIONS[0] as NonNullable<(typeof MIGRATIONS)[number]>;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LEDGER = "settlement_pending_migration_ledger";
const lockKey = (schema: string): string => `settlement:migrate:${schema}`;

async function waitUntilBlockedOn(k: PendingKit): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const rows = await k.raw(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [lockKey(k.schema)],
    );
    if (Number(rows[0]?.["n"]) > 0) return;
    await sleep(20);
  }
  throw new Error("اتصالِ گرم پشتِ قفلِ مشورتی دیده نشد");
}

type Seen = Readonly<{ raw: unknown; fixed: unknown; pidBefore: unknown; pidInside: unknown }>;

/** کنترل منفی با فاصلهٔ بیکاریِ عمدی؛ `warmInside` ⇒ گرم‌کردن درونِ تراکنش (شکلِ اصلاح‌شده). */
async function controlWithIdleGap(warmInside: boolean): Promise<Seen> {
  const k = await openPendingKit({ migratePending: true });
  opened.push(k);
  const w = k.indexWith({}, 1);
  const target = `"${k.schema}".${LEDGER}`;
  const pidBefore = (await w.db.execute(sql`SELECT pg_backend_pid() AS p`)).rows[0]?.["p"];
  expect(await w.index.status()).toMatchObject({ ok: true }); // گرم‌کردن به‌شیوهٔ آزمونِ اصلی
  await sleep(POOL_IDLE_MS * 4); // اتصالِ بی‌نگهداری بسته می‌شود
  const seen = await k.session(async (q, commit) => {
    await q("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey(k.schema)]);
    const pending = w.db.transaction(async (tx) => {
      // pid پیش از قفل: هر دستورِ تازه‌ای که تابعی را برای نخستین بار در اتصالِ سرد تحلیل کند کاتالوگ را باز می‌کند و کش را تازه می‌کند؛ پس
      // میانِ بیدارشدن از قفل و `raw` نباید دستورِ تازه‌ای باشد (همان چینشِ آزمونِ اصلی).
      const pidInside = (await tx.execute(sql`SELECT pg_backend_pid() AS p`)).rows[0]?.["p"];
      if (warmInside) await tx.execute(sql`SELECT to_regclass(${target}) IS NOT NULL AS p`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(k.schema)}, 0))`);
      const raw = await tx.execute(sql`SELECT to_regclass(${target}) IS NOT NULL AS p`);
      const fixed = await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = to_regclass(${target})) AS p`);
      return { raw: raw.rows[0]?.["p"], fixed: fixed.rows[0]?.["p"], pidBefore, pidInside } satisfies Seen;
    });
    await waitUntilBlockedOn(k);
    for (const statement of rollbackStatements(first.name) ?? []) await q(renderStatement(statement, k.schema));
    await q(`DELETE FROM {{s}}.${LEDGER} WHERE name = $1`, [first.name]);
    await q(`DROP TABLE {{s}}.${LEDGER}`);
    await commit();
    return pending;
  });
  await w.close();
  return seen;
}

dbDescribe("settlement-pending · کنترل منفیِ کشِ کاتالوگ با فاصلهٔ بیکاریِ عمدی (ADR-0052)", () => {
  it("اتصالِ گرمِ بی‌نگهداری پس از مهلتِ بیکاری سرد می‌شود (pid دیگر) و `to_regclass`ِ خام درست می‌گوید ⇒ علتِ ناپایداری اثبات", async () => {
    const seen = await controlWithIdleGap(false);
    expect(seen.pidInside).not.toBe(seen.pidBefore); // اتصالِ گرم بسته شد
    expect(seen.raw).toBe(false); // اتصالِ سرد کهنه نیست؛ همان چیزی که ادعای «کهنه» را به‌ناحق قرمز می‌کرد
    expect(seen.fixed).toBe(false);
  }, 60_000);

  it("گرم‌کردنِ درونِ همان تراکنش با همان فاصله ⇒ هنوز کهنه (raw=true) و شکلِ رفع‌شده درست (fixed=false) ⇒ کنترل منفی به بارِ ماشین وابسته نیست", async () => {
    const seen = await controlWithIdleGap(true);
    expect(seen.raw).toBe(true);
    expect(seen.fixed).toBe(false);
  }, 60_000);
});
