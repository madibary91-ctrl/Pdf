/**
 * settlement-pending · «اتصالِ گرم و کشِ کاتالوگِ کهنه» روی PostgreSQL واقعی (ADR-0050).
 *
 * مشکل: `to_regclass` (جست‌وجوی بی‌قفل) از کشِ کاتالوگِ اتصال جواب می‌دهد و **انتظار برای قفلِ مشورتی** کش را تازه نمی‌کند. اتصالی که پیش‌تر
 * (مثلاً با `status()`) نامِ جدول را دیده، پس از انتظارِ پشتِ یک `migrate()`/`down()` ی که میانِ همان مدت commit شد، پاسخِ کهنه می‌گرفت.
 *
 * شیوهٔ قطعی (بی‌زمان‌بندیِ شانسی): نشستِ دستیِ «U» قفلِ مشورتیِ مشترکِ مهاجرت را نگه می‌دارد؛ اتصالِ گرمِ «W» (استخرِ یک‌اتصالی که پیش‌تر وضعیت را خوانده)
 * `down()`/`migrate()` را شروع می‌کند و روی همان قفل می‌ماند (با `pg_locks` اثبات می‌شود، نه با sleep)؛ سپس U تغییرِ کاتالوگ را commit می‌کند.
 * آزمون‌های اول تا سوم پیش از رفع قرمز بودند (نتیجهٔ ثبت‌شده در تحویل ۰۰۵۰)؛ آزمونِ پنجم خطِ پایه است و کهنگیِ `to_regclass`ِ خام را زنده نشان می‌دهد.
 */
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { dbDescribe, openPendingKit, type PendingKit, type Raw } from "./pg-kit";
import { MIGRATIONS, migrationChecksum, renderStatement, rollbackStatements } from "./migrations";

const opened: PendingKit[] = [];
afterAll(async () => {
  for (const k of opened) await k.dispose();
});
async function fresh(opts: Parameters<typeof openPendingKit>[0] = {}): Promise<PendingKit> {
  const k = await openPendingKit(opts);
  opened.push(k);
  return k;
}
const first = MIGRATIONS[0] as NonNullable<(typeof MIGRATIONS)[number]>;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LEDGER = "settlement_pending_migration_ledger";
const lockKey = (schema: string): string => `settlement:migrate:${schema}`;

const present = async (raw: Raw, name: string): Promise<boolean> => (await raw(`SELECT to_regclass('{{s}}.${name}') IS NOT NULL AS p`))[0]?.["p"] === true;

/** منتظر می‌ماند تا **دقیقاً** قفلِ مشورتیِ این کلید یک منتظرِ اعطانشده داشته باشد (کلیدِ bigint = classid<<32 | objid). */
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

const takeLock = (q: Raw, k: PendingKit): Promise<unknown> => q("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey(k.schema)]);

/** همان کاری که `migrate()` در یک تراکنش می‌کند، ولی با SQLِ خام در نشستِ دستیِ U. */
async function installRaw(q: Raw, schema: string): Promise<void> {
  await q(`CREATE TABLE IF NOT EXISTS {{s}}.${LEDGER} (name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT settlement_pending_migration_ledger_pk PRIMARY KEY (name))`);
  for (const m of MIGRATIONS) {
    for (const statement of m.statements) await q(renderStatement(statement, schema));
    await q(`INSERT INTO {{s}}.${LEDGER} (name, checksum) VALUES ($1, $2)`, [m.name, migrationChecksum(m)]);
  }
}
/** برگشتِ دستیِ نصب (همان `down()`) در نشستِ U. */
async function uninstallRaw(q: Raw, schema: string): Promise<void> {
  for (const statement of rollbackStatements(first.name) ?? []) await q(renderStatement(statement, schema));
  await q(`DELETE FROM {{s}}.${LEDGER} WHERE name = $1`, [first.name]);
  await q(`DROP TABLE {{s}}.${LEDGER}`);
}

dbDescribe("settlement-pending · اتصالِ گرم و کشِ کاتالوگِ کهنه (to_regclass)", () => {
  it("down() روی اتصالِ گرم، وقتی برگشتِ دیگری میانِ انتظار commit شد ⇒ ok و بی‌کار (نه NOT_MIGRATED/۸ی گمراه‌کننده)", async () => {
    const k = await fresh({ migratePending: true });
    const w = k.indexWith({}, 1); // یک اتصال: همان که گرم می‌شود و همان که down() را می‌زند
    expect(await w.index.status()).toMatchObject({ ok: true, value: { applied: [first.name] } }); // گرم‌کردن: «دفتر هست» در کش

    const result = await k.session(async (q, commit) => {
      await takeLock(q, k);
      const pending = w.index.down();
      await waitUntilBlockedOn(k);
      await uninstallRaw(q, k.schema);
      await commit();
      return pending;
    });

    expect(result).toEqual({ ok: true, value: { reverted: [] } });
    expect(await present(k.raw, "settlement_dead_pending")).toBe(false);
    expect(await present(k.raw, LEDGER)).toBe(false);
    await w.close();
  }, 60_000);

  it("down() روی اتصالِ گرم، وقتی نصبِ دیگری میانِ انتظار commit شد ⇒ **نصب را برمی‌دارد** (نه «بی‌کار» با نصبِ سرِ جا)", async () => {
    const k = await fresh(); // نصب‌نشده
    const w = k.indexWith({}, 1);
    expect(await w.index.status()).toMatchObject({ ok: true, value: { applied: [], pending: [first.name] } }); // گرم‌کردن: «دفتر نیست» در کش

    const result = await k.session(async (q, commit) => {
      await takeLock(q, k);
      const pending = w.index.down();
      await waitUntilBlockedOn(k);
      await installRaw(q, k.schema);
      await commit();
      return pending;
    });

    expect(result).toEqual({ ok: true, value: { reverted: [first.name] } });
    expect(await present(k.raw, "settlement_dead_pending")).toBe(false);
    expect(await present(k.raw, LEDGER)).toBe(false);
    expect(await k.index.status()).toMatchObject({ ok: true, value: { applied: [], pending: [first.name] } });
    await w.close();
  }, 60_000);

  it("migrate() روی اتصالِ گرم، وقتی جدول‌های settlement میانِ انتظار حذف شدند ⇒ پیش‌نیازِ شفاف (پیامِ settlement) پیش از هر DDL", async () => {
    const k = await fresh(); // settlement نصب است، نمایه نه
    const w = k.indexWith({}, 1);
    expect(await present(w.raw, "settlement_outbox")).toBe(true); // گرم‌کردنِ همان اتصال: «outbox هست» در کش
    expect(await present(w.raw, "settlement_dead_ack")).toBe(true);

    const result = await k.session(async (q, commit) => {
      await takeLock(q, k);
      const pending = w.index.migrate();
      await waitUntilBlockedOn(k);
      await q("DROP TABLE {{s}}.settlement_dead_ack");
      await q("DROP TABLE {{s}}.settlement_outbox CASCADE");
      await commit();
      return pending;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_MIGRATED");
      // پیامِ پیش‌نیازِ settlement است، نه پیامِ عمومیِ 42P01 که پس از شروعِ DDL از دلِ pg می‌آید
      expect(result.error.message).toContain("outbox و تأییدِ settlement");
      expect(result.error).not.toHaveProperty("pgCode");
    }
    expect(await present(k.raw, LEDGER)).toBe(false);
    await w.close();
  }, 60_000);

  it("status() روی اتصالِ گرم پس از هر دو جهتِ تغییر درست است (قفلِ رفتار)", async () => {
    const k = await fresh({ migratePending: true });
    const w = k.indexWith({}, 1);
    expect(await w.index.status()).toMatchObject({ ok: true, value: { applied: [first.name] } });
    expect((await k.index.down()).ok).toBe(true);
    expect(await w.index.status()).toMatchObject({ ok: true, value: { applied: [], pending: [first.name] } });
    expect((await k.index.migrate()).ok).toBe(true);
    expect(await w.index.status()).toMatchObject({ ok: true, value: { applied: [first.name], pending: [] } });
    await w.close();
  }, 60_000);

  it("خطِ پایه (کنترل منفی): `to_regclass`ِ خام روی همان چینش واقعاً کهنه می‌شود و شکلِ رفع‌شده نه ⇒ آزمون‌های بالا پوچ نیستند", async () => {
    const k = await fresh({ migratePending: true });
    const w = k.indexWith({}, 1);
    const target = `"${k.schema}".${LEDGER}`;
    expect(await w.index.status()).toMatchObject({ ok: true }); // گرم‌کردنِ همان اتصال (تراکنشِ فقط‌خواندنیِ status)

    const seen = await k.session(async (q, commit) => {
      await takeLock(q, k);
      const pending = w.db.transaction(async (tx) => {
        // گرم‌کردنِ **درونِ همین تراکنش/اتصال** (ADR-0052): استخرِ آزمون `idleTimeoutMillis`=۵۰ms دارد و زیرِ بارِ دروازه ممکن است اتصالِ گرمِ `status()` پیش از رسیدن به این‌جا بسته شود ⇒ اتصالِ سرد ⇒ `raw=false` (ناپایداریِ ثبت‌شده در ۰۰۵۱)
        await tx.execute(sql`SELECT to_regclass(${target}) IS NOT NULL AS p`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(k.schema)}, 0))`);
        const raw = await tx.execute(sql`SELECT to_regclass(${target}) IS NOT NULL AS p`);
        const fixed = await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = to_regclass(${target})) AS p`);
        return { raw: raw.rows[0]?.["p"], fixed: fixed.rows[0]?.["p"] };
      });
      await waitUntilBlockedOn(k);
      await uninstallRaw(q, k.schema);
      await commit();
      return pending;
    });

    expect(seen.fixed).toBe(false); // درست
    expect(seen.raw).toBe(true); // کهنه: همان باگی که `relationExists` برطرف می‌کند
    await w.close();
  }, 60_000);
});
