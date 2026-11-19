/**
 * اجرای مهاجرت‌ها (داخلی؛ از `createKbStore(...).migrate()` در دسترس است).
 *
 * ضمانت‌ها:
 *  - همه‌چیز در **یک تراکنش** و زیر قفل مشورتی؛ اجرای هم‌زمان دو فرایند امن است (دومی منتظر می‌ماند و چیزی برای اعمال نمی‌بیند).
 *  - checksum مهاجرت‌های اعمال‌شده با کد سنجیده می‌شود (ویرایش مهاجرتِ قدیمی = خطا)؛ پایگاهِ «از آینده» و «حفره» رد می‌شود.
 *  - اگر خطایی رخ دهد هیچ تغییری باقی نمی‌ماند (DDL پستگرس تراکنشی است).
 */
import { sql } from "drizzle-orm";
import { StoreAbort, toStoreError } from "./errors";
import { MIGRATIONS, migrationChecksum, renderStatement, type Migration } from "./migrations";
import { tableRef } from "./naming";
import type { KbDatabase, KbExecutor, MigrationReport, MigrationStatus, StoreResult } from "./types";

export type LedgerRow = Readonly<{ name: string; checksum: string }>;

async function readLedger(ex: KbExecutor, schema: string): Promise<readonly LedgerRow[]> {
  const res = await ex.execute(sql`SELECT name, checksum FROM ${tableRef(schema, "migration_ledger")} ORDER BY name`);
  return res.rows.map((r) => {
    const name = r["name"];
    const checksum = r["checksum"];
    if (typeof name !== "string" || typeof checksum !== "string") {
      throw new StoreAbort({ code: "CORRUPT_DATA", message: "دفتر مهاجرت‌ها (migration_ledger) شکل نادرستی دارد." });
    }
    return { name, checksum };
  });
}

/**
 * دفتر را با فهرست کد مقایسه می‌کند. نتیجه: نام‌های اعمال‌شده و معلق.
 * خطا (پرتاب StoreAbort): ناشناخته، checksum ناهمخوان، یا حفره (مهاجرتِ بعدی اعمال شده ولی قبلی نه).
 */
export function reconcile(ledger: readonly LedgerRow[], migrations: readonly Migration[] = MIGRATIONS): MigrationStatus {
  const known = new Map(migrations.map((m) => [m.name, m]));
  for (const row of ledger) {
    if (!known.has(row.name)) {
      throw new StoreAbort({
        code: "MIGRATION_UNKNOWN",
        message: `پایگاه مهاجرت «${row.name}» را دارد که این نسخهٔ برنامه نمی‌شناسد (پایگاه از نسخهٔ جدیدتری است)؛ برنامه را به‌روز کنید.`,
      });
    }
  }
  const byName = new Map(ledger.map((r) => [r.name, r.checksum]));
  const applied: string[] = [];
  const pending: string[] = [];
  for (const m of migrations) {
    const stored = byName.get(m.name);
    if (stored === undefined) {
      pending.push(m.name);
      continue;
    }
    if (pending.length > 0) {
      throw new StoreAbort({ code: "MIGRATION_TAMPERED", message: `مهاجرت «${m.name}» اعمال شده ولی مهاجرت پیش از آن (${pending[0]}) نه؛ دفتر مهاجرت‌ها دست‌کاری شده است.` });
    }
    if (stored !== migrationChecksum(m)) {
      throw new StoreAbort({ code: "MIGRATION_TAMPERED", message: `محتوای مهاجرت «${m.name}» پس از اعمال تغییر کرده است (checksum ناهمخوان). مهاجرت اعمال‌شده هرگز ویرایش نمی‌شود؛ مهاجرت تازه بسازید.` });
    }
    applied.push(m.name);
  }
  return { applied, pending };
}

/**
 * ساختِ امنِ شِما زیر رقابت (ADR-0036؛ هم‌شکلِ ADR-0035 در `ledger`/`settlement`). داخل تراکنشِ مهاجرت و پس از قفلِ ماژول صدا زده می‌شود:
 *  ۱. قفلِ مشورتیِ **مشترکِ شِما** `schema:ensure:<شِما>` (هم‌کلید با `ledger` و `settlement`؛ ترتیبِ قفل‌ها ثابت: ماژول ← شِما ⇒ بن‌بست ممکن نیست).
 *  ۲. `SELECT` تازه از `pg_catalog.pg_namespace` (عکسِ لحظه‌ایِ READ COMMITTED).
 *  ۳. فقط در نبودِ ردیف `CREATE SCHEMA IF NOT EXISTS`؛ `IF NOT EXISTS` عمداً می‌ماند (دفاع در برابرِ سازندهٔ بیرون از ماژول‌ها).
 * پاسخِ ناشناختهٔ SELECT شکست‌بسته است (`CORRUPT_DATA`)؛ هرگز «پس بسازیم» نیست. خطاها بلعیده نمی‌شوند.
 * (داخلی؛ از `index.ts` صادر نمی‌شود. `search-migrate.ts` هم از همین استفاده می‌کند.)
 */
export async function ensureSchema(ex: KbExecutor, schema: string): Promise<void> {
  await ex.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`schema:ensure:${schema}`}, 0))`);
  const found = await ex.execute(sql`SELECT 1 AS present FROM pg_catalog.pg_namespace WHERE nspname = ${schema}`);
  const rows: unknown = (found as { rows?: unknown } | undefined)?.rows;
  if (!Array.isArray(rows)) {
    throw new StoreAbort({ code: "CORRUPT_DATA", message: "پاسخِ بررسیِ وجودِ شِما شکل نادرستی دارد؛ شِما ساخته نشد." });
  }
  if (rows.length === 0) await ex.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);
}

export async function migrate(db: KbDatabase, schema: string): Promise<StoreResult<MigrationReport>> {
  try {
    const report = await db.transaction(async (tx) => {
      // قفل سراسری فقط برای راه‌اندازی/مهاجرت: CREATE EXTENSION هم‌زمان در پستگرس مسابقه دارد.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"legal-kb-store:migrate"}, 0))`);
      // btree_gist برای قید EXCLUDE روی (متن = ، بازه &&). از پایگاه‌های «trusted» است (مالک پایگاه کافی است).
      await tx.execute(sql`CREATE EXTENSION IF NOT EXISTS btree_gist`);
      await ensureSchema(tx, schema);
      await tx.execute(sql`CREATE TABLE IF NOT EXISTS ${tableRef(schema, "migration_ledger")} (
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT migration_ledger_pk PRIMARY KEY (name)
      )`);

      const status = reconcile(await readLedger(tx, schema));
      for (const m of MIGRATIONS.filter((x) => status.pending.includes(x.name))) {
        for (const statement of m.statements) await tx.execute(sql.raw(renderStatement(statement, schema)));
        await tx.execute(sql`INSERT INTO ${tableRef(schema, "migration_ledger")} (name, checksum) VALUES (${m.name}, ${migrationChecksum(m)})`);
      }
      return { applied: status.pending, alreadyApplied: status.applied } satisfies MigrationReport;
    });
    return { ok: true, value: report };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

/** فقط‌خواندنی: چه چیزی اعمال شده و چه چیزی معلق است. شِمای ناموجود = همه معلق (خطا نیست). */
export async function migrationStatus(db: KbDatabase, schema: string): Promise<StoreResult<MigrationStatus>> {
  try {
    const status = await db.transaction(
      async (tx) => {
        const exists = await tx.execute(sql`SELECT to_regclass(${`${JSON.stringify(schema)}.migration_ledger`}) IS NOT NULL AS present`);
        if (exists.rows[0]?.["present"] !== true) return { applied: [], pending: MIGRATIONS.map((m) => m.name) } satisfies MigrationStatus;
        return reconcile(await readLedger(tx, schema));
      },
      { accessMode: "read only" },
    );
    return { ok: true, value: status };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

/**
 * سپر هر عملیات: برنامه فقط روی پایگاهی کار می‌کند که **دقیقاً** با مهاجرت‌های همین کد همخوان است.
 * (وگرنه کوئری‌ها ممکن است بی‌صدا روی شمای قدیمی/ناسازگار اجرا شوند.) داخل تراکنشِ خود عملیات صدا زده می‌شود.
 */
export async function assertCurrent(ex: KbExecutor, schema: string): Promise<void> {
  const exists = await ex.execute(sql`SELECT to_regclass(${`${JSON.stringify(schema)}.migration_ledger`}) IS NOT NULL AS present`);
  if (exists.rows[0]?.["present"] !== true) {
    throw new StoreAbort({ code: "NOT_MIGRATED", message: "پایگاه دانش هنوز مهاجرت نشده است؛ ابتدا migrate() را اجرا کنید." });
  }
  const status = reconcile(await readLedger(ex, schema));
  if (status.pending.length > 0) {
    throw new StoreAbort({ code: "NOT_MIGRATED", message: `مهاجرت معلق: ${status.pending.join("، ")}؛ ابتدا migrate() را اجرا کنید.` });
  }
}
