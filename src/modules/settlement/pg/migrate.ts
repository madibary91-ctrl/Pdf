/**
 * اجرای مهاجرت‌ها (داخلی؛ از `createPgSettlementOutbox(...).migrate()` در دسترس است). ضمانت‌ها مثل ledger/pg/migrate.ts:
 *  - همه‌چیز در **یک تراکنش** و زیر قفل مشورتی؛ اجرای هم‌زمان دو فرایند امن است.
 *  - checksum مهاجرت‌های اعمال‌شده با کد سنجیده می‌شود؛ پایگاهِ «از آینده» و «حفره» رد می‌شود.
 *  - اگر خطایی رخ دهد هیچ تغییری باقی نمی‌ماند (DDL پستگرس تراکنشی است).
 * دفتر مهاجرتِ این ماژول جداست (`settlement_migration_ledger`)، پس با دفتر مهاجرتِ ledger (حتی در همان شِما) نمی‌آمیزد.
 */
import { sql } from "drizzle-orm";
import type { LedgerDatabase, LedgerExecutor, PgMigrationReport, PgMigrationStatus, PgStoreResult } from "@/modules/ledger";
import { SettlementStoreError, toStoreError } from "./errors";
import { MIGRATIONS, migrationChecksum, renderStatement, type Migration } from "./migrations";
import { tableRef } from "./naming";

export type LedgerRow = Readonly<{ name: string; checksum: string }>;

async function readLedger(ex: LedgerExecutor, schema: string): Promise<readonly LedgerRow[]> {
  const res = await ex.execute(sql`SELECT name, checksum FROM ${tableRef(schema, "settlement_migration_ledger")} ORDER BY name`);
  return res.rows.map((r) => {
    const name = r["name"];
    const checksum = r["checksum"];
    if (typeof name !== "string" || typeof checksum !== "string") {
      throw new SettlementStoreError({ code: "CORRUPT_DATA", message: "دفتر مهاجرت‌های outbox (settlement_migration_ledger) شکل نادرستی دارد." });
    }
    return { name, checksum };
  });
}

/** دفتر را با فهرست کد مقایسه می‌کند؛ خطا (پرتاب): ناشناخته، checksum ناهمخوان، یا حفره. */
export function reconcile(ledger: readonly LedgerRow[], migrations: readonly Migration[] = MIGRATIONS): PgMigrationStatus {
  const known = new Map(migrations.map((m) => [m.name, m]));
  for (const row of ledger) {
    if (!known.has(row.name)) {
      throw new SettlementStoreError({
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
      throw new SettlementStoreError({ code: "MIGRATION_TAMPERED", message: `مهاجرت «${m.name}» اعمال شده ولی مهاجرت پیش از آن (${pending[0]}) نه؛ دفتر مهاجرت‌ها دست‌کاری شده است.` });
    }
    if (stored !== migrationChecksum(m)) {
      throw new SettlementStoreError({ code: "MIGRATION_TAMPERED", message: `محتوای مهاجرت «${m.name}» پس از اعمال تغییر کرده است (checksum ناهمخوان). مهاجرت اعمال‌شده هرگز ویرایش نمی‌شود؛ مهاجرت تازه بسازید.` });
    }
    applied.push(m.name);
  }
  return { applied, pending };
}

export async function migrate(db: LedgerDatabase, schema: string): Promise<PgStoreResult<PgMigrationReport>> {
  try {
    const report = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:migrate:${schema}`}, 0))`);
      await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);
      await tx.execute(sql`CREATE TABLE IF NOT EXISTS ${tableRef(schema, "settlement_migration_ledger")} (
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT settlement_migration_ledger_pk PRIMARY KEY (name)
      )`);

      const status = reconcile(await readLedger(tx, schema));
      for (const m of MIGRATIONS.filter((x) => status.pending.includes(x.name))) {
        for (const statement of m.statements) await tx.execute(sql.raw(renderStatement(statement, schema)));
        await tx.execute(sql`INSERT INTO ${tableRef(schema, "settlement_migration_ledger")} (name, checksum) VALUES (${m.name}, ${migrationChecksum(m)})`);
      }
      return { applied: status.pending, alreadyApplied: status.applied } satisfies PgMigrationReport;
    });
    return { ok: true, value: report };
  } catch (e) {
    return { ok: false, error: toStoreError(e).error };
  }
}

/** فقط‌خواندنی: چه چیزی اعمال شده و چه چیزی معلق است. شِمای ناموجود = همه معلق (خطا نیست). */
export async function migrationStatus(db: LedgerDatabase, schema: string): Promise<PgStoreResult<PgMigrationStatus>> {
  try {
    const status = await db.transaction(
      async (tx) => {
        const exists = await tx.execute(sql`SELECT to_regclass(${`${JSON.stringify(schema)}.settlement_migration_ledger`}) IS NOT NULL AS present`);
        if (exists.rows[0]?.["present"] !== true) return { applied: [], pending: MIGRATIONS.map((m) => m.name) } satisfies PgMigrationStatus;
        return reconcile(await readLedger(tx, schema));
      },
      { accessMode: "read only" },
    );
    return { ok: true, value: status };
  } catch (e) {
    return { ok: false, error: toStoreError(e).error };
  }
}

/**
 * سپر هر عملیات: outbox فقط روی پایگاهی کار می‌کند که **دقیقاً** با مهاجرت‌های همین کد همخوان است (وگرنه کوئری‌ها ممکن است بی‌صدا
 * روی شِمای ناسازگار اجرا شوند). داخل تراکنشِ خودِ عملیات صدا زده می‌شود؛ شِما/جدولِ ناموجود (42P01/3F000) در `toStoreError` به `NOT_MIGRATED` نگاشت می‌شود.
 */
export async function assertCurrent(ex: LedgerExecutor, schema: string): Promise<void> {
  const status = reconcile(await readLedger(ex, schema));
  if (status.pending.length > 0) {
    throw new SettlementStoreError({ code: "NOT_MIGRATED", message: `مهاجرت معلق: ${status.pending.join("، ")}؛ ابتدا migrate() را اجرا کنید.` });
  }
}
