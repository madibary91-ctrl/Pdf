/**
 * اجرای مهاجرت‌های نمایه (داخلی؛ از `createPendingDeadIndex(...).migrate()` در دسترس است). ضمانت‌ها مثل settlement/pg/migrate.ts:
 *  - همه‌چیز در **یک تراکنش** و زیر قفل‌های مشورتی؛ اجرای هم‌زمانِ دو فرایند امن است.
 *  - checksum مهاجرت‌های اعمال‌شده با کد سنجیده می‌شود؛ پایگاهِ «از آینده» و «حفره» رد می‌شود.
 *  - اگر خطایی رخ دهد (از جمله `lock_timeout` هنگام backfill) هیچ تغییری باقی نمی‌ماند.
 * دفتر مهاجرتِ این ماژول جداست (`settlement_pending_migration_ledger`)، پس با دفترِ settlement و ledger نمی‌آمیزد.
 *
 * **پیش‌نیاز:** جدول‌های outbox و تأییدِ settlement باید باشند (این ماژول شِما نمی‌سازد و مهاجرتِ settlement را اجرا نمی‌کند)؛ وگرنه `NOT_MIGRATED`.
 * قفلِ مشورتیِ مهاجرتِ settlement (`settlement:migrate:<شِما>`) **پیش** از قفلِ خودِ این ماژول گرفته می‌شود تا مهاجرتِ هم‌زمانِ آن دو سریال شوند؛ ترتیبِ
 * ثابت (settlement ← pending) بن‌بست را ناممکن می‌کند. آزمونِ PostgreSQL برابریِ این کلید با کلیدِ settlement را قفل می‌کند.
 */
import { sql } from "drizzle-orm";
import type { LedgerDatabase, LedgerExecutor, PgMigrationReport, PgMigrationStatus, PgStoreResult } from "@/modules/ledger";
import { PendingStoreError, toStoreError } from "./errors";
import { MIGRATIONS, migrationChecksum, renderStatement, type Migration } from "./migrations";
import { tableRef } from "./naming";

export type LedgerRow = Readonly<{ name: string; checksum: string }>;

const LEDGER = "settlement_pending_migration_ledger";

async function readLedger(ex: LedgerExecutor, schema: string): Promise<readonly LedgerRow[]> {
  const res = await ex.execute(sql`SELECT name, checksum FROM ${tableRef(schema, LEDGER)} ORDER BY name`);
  return res.rows.map((r) => {
    const name = r["name"];
    const checksum = r["checksum"];
    if (typeof name !== "string" || typeof checksum !== "string") {
      throw new PendingStoreError({ code: "CORRUPT_DATA", message: "دفتر مهاجرت‌های نمایه (settlement_pending_migration_ledger) شکل نادرستی دارد." });
    }
    return { name, checksum };
  });
}

/** دفتر را با فهرست کد مقایسه می‌کند؛ خطا (پرتاب): ناشناخته، checksum ناهمخوان، یا حفره. */
export function reconcile(ledger: readonly LedgerRow[], migrations: readonly Migration[] = MIGRATIONS): PgMigrationStatus {
  const known = new Map(migrations.map((m) => [m.name, m]));
  for (const row of ledger) {
    if (!known.has(row.name)) {
      throw new PendingStoreError({
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
      throw new PendingStoreError({ code: "MIGRATION_TAMPERED", message: `مهاجرت «${m.name}» اعمال شده ولی مهاجرت پیش از آن (${pending[0]}) نه؛ دفتر مهاجرت‌ها دست‌کاری شده است.` });
    }
    if (stored !== migrationChecksum(m)) {
      throw new PendingStoreError({ code: "MIGRATION_TAMPERED", message: `محتوای مهاجرت «${m.name}» پس از اعمال تغییر کرده است (checksum ناهمخوان). مهاجرت اعمال‌شده هرگز ویرایش نمی‌شود.` });
    }
    applied.push(m.name);
  }
  return { applied, pending };
}

/** پیش‌نیاز: جدول‌های outbox و تأیید موجودند (مهاجرتِ settlement اعمال شده). `to_regclass` خطا نمی‌دهد؛ نبودن ⇒ `NOT_MIGRATED`. */
async function assertSettlementTables(ex: LedgerExecutor, schema: string): Promise<void> {
  const res = await ex.execute(
    sql`SELECT to_regclass(${`${JSON.stringify(schema)}.settlement_outbox`}) IS NOT NULL AS outbox, to_regclass(${`${JSON.stringify(schema)}.settlement_dead_ack`}) IS NOT NULL AS ack`,
  );
  const row = res.rows[0];
  if (row?.["outbox"] !== true || row["ack"] !== true) {
    throw new PendingStoreError({ code: "NOT_MIGRATED", message: "جدول‌های outbox و تأییدِ settlement وجود ندارند؛ ابتدا مهاجرتِ settlement را اجرا کنید." });
  }
}

export async function migrate(db: LedgerDatabase, schema: string): Promise<PgStoreResult<PgMigrationReport>> {
  try {
    const report = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:migrate:${schema}`}, 0))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement-pending:migrate:${schema}`}, 0))`);
      await assertSettlementTables(tx, schema);
      await tx.execute(sql`CREATE TABLE IF NOT EXISTS ${tableRef(schema, LEDGER)} (
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT settlement_pending_migration_ledger_pk PRIMARY KEY (name)
      )`);

      const status = reconcile(await readLedger(tx, schema));
      for (const m of MIGRATIONS.filter((x) => status.pending.includes(x.name))) {
        for (const statement of m.statements) await tx.execute(sql.raw(renderStatement(statement, schema)));
        await tx.execute(sql`INSERT INTO ${tableRef(schema, LEDGER)} (name, checksum) VALUES (${m.name}, ${migrationChecksum(m)})`);
      }
      return { applied: status.pending, alreadyApplied: status.applied } satisfies PgMigrationReport;
    });
    return { ok: true, value: report };
  } catch (e) {
    return { ok: false, error: toStoreError(e).error };
  }
}

/** فقط‌خواندنی: چه چیزی اعمال شده و چه چیزی معلق است. شِما/دفترِ ناموجود = همه معلق (خطا نیست). */
export async function migrationStatus(db: LedgerDatabase, schema: string): Promise<PgStoreResult<PgMigrationStatus>> {
  try {
    const status = await db.transaction(
      async (tx) => {
        const exists = await tx.execute(sql`SELECT to_regclass(${`${JSON.stringify(schema)}.${LEDGER}`}) IS NOT NULL AS present`);
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
 * سپرِ خواندن: نمایه فقط روی پایگاهی کار می‌کند که **دقیقاً** با مهاجرت‌های همین کد همخوان است. داخل تراکنشِ خودِ عملیات صدا زده می‌شود؛
 * دفتر/جدولِ ناموجود (42P01/3F000) در `toStoreError` به `NOT_MIGRATED` نگاشت می‌شود.
 */
export async function assertCurrent(ex: LedgerExecutor, schema: string): Promise<void> {
  const status = reconcile(await readLedger(ex, schema));
  if (status.pending.length > 0) {
    throw new PendingStoreError({ code: "NOT_MIGRATED", message: `مهاجرتِ نمایه معلق است: ${status.pending.join("، ")}؛ ابتدا migrate() را اجرا کنید.` });
  }
}
