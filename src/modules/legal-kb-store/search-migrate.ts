/**
 * مهاجرت نمایهٔ جست‌وجو (داخلی): همان ضمانت‌های `migrate.ts` با دفتر و شِمای خودش (`<schema>_search`، جدول `search_ledger`).
 * یک تراکنش + قفل مشورتی؛ checksum سنجیده می‌شود؛ پایگاه «از آینده» و «حفره» رد می‌شود. به شِمای دانش دست نمی‌زند.
 */
import { sql } from "drizzle-orm";
import { StoreAbort, toStoreError } from "./errors";
import { ensureSchema, reconcile, type LedgerRow } from "./migrate";
import { migrationChecksum } from "./migrations";
import { searchSchemaName, searchTableRef } from "./naming";
import { SEARCH_MIGRATIONS, renderSearchStatement } from "./search-migrations";
import type { KbDatabase, KbExecutor, MigrationReport, MigrationStatus, StoreResult } from "./types";

async function readSearchLedger(ex: KbExecutor, schema: string): Promise<readonly LedgerRow[]> {
  const res = await ex.execute(sql`SELECT name, checksum FROM ${searchTableRef(schema, "search_ledger")} ORDER BY name`);
  return res.rows.map((r) => {
    const name = r["name"];
    const checksum = r["checksum"];
    if (typeof name !== "string" || typeof checksum !== "string") {
      throw new StoreAbort({ code: "CORRUPT_DATA", message: "دفتر مهاجرت نمایهٔ جست‌وجو (search_ledger) شکل نادرستی دارد." });
    }
    return { name, checksum };
  });
}

export async function migrateSearch(db: KbDatabase, schema: string): Promise<StoreResult<MigrationReport>> {
  try {
    const report = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"legal-kb-store:search-migrate"}, 0))`);
      await ensureSchema(tx, searchSchemaName(schema));
      await tx.execute(sql`CREATE TABLE IF NOT EXISTS ${searchTableRef(schema, "search_ledger")} (
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT search_ledger_pk PRIMARY KEY (name)
      )`);
      const status = reconcile(await readSearchLedger(tx, schema), SEARCH_MIGRATIONS);
      for (const m of SEARCH_MIGRATIONS.filter((x) => status.pending.includes(x.name))) {
        for (const statement of m.statements) await tx.execute(sql.raw(renderSearchStatement(statement, schema)));
        await tx.execute(sql`INSERT INTO ${searchTableRef(schema, "search_ledger")} (name, checksum) VALUES (${m.name}, ${migrationChecksum(m)})`);
      }
      return { applied: status.pending, alreadyApplied: status.applied } satisfies MigrationReport;
    });
    return { ok: true, value: report };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

/** فقط‌خواندنی. شِمای نمایه نبودن = همه معلق (خطا نیست). */
export async function searchMigrationStatus(db: KbDatabase, schema: string): Promise<StoreResult<MigrationStatus>> {
  try {
    const status = await db.transaction(
      async (tx) => {
        const exists = await tx.execute(sql`SELECT to_regclass(${`${JSON.stringify(searchSchemaName(schema))}.search_ledger`}) IS NOT NULL AS present`);
        if (exists.rows[0]?.["present"] !== true) return { applied: [], pending: SEARCH_MIGRATIONS.map((m) => m.name) } satisfies MigrationStatus;
        return reconcile(await readSearchLedger(tx, schema), SEARCH_MIGRATIONS);
      },
      { accessMode: "read only" },
    );
    return { ok: true, value: status };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

/** سپر عملیات جست‌وجو: نمایه فقط روی شِمایی کار می‌کند که دقیقاً با مهاجرت‌های همین کد همخوان است. داخل تراکنشِ خود عملیات. */
export async function assertSearchCurrent(ex: KbExecutor, schema: string): Promise<void> {
  const exists = await ex.execute(sql`SELECT to_regclass(${`${JSON.stringify(searchSchemaName(schema))}.search_ledger`}) IS NOT NULL AS present`);
  if (exists.rows[0]?.["present"] !== true) {
    throw new StoreAbort({ code: "NOT_MIGRATED", message: "نمایهٔ جست‌وجو هنوز مهاجرت نشده است؛ ابتدا migrateSearch() را اجرا کنید." });
  }
  const status = reconcile(await readSearchLedger(ex, schema), SEARCH_MIGRATIONS);
  if (status.pending.length > 0) {
    throw new StoreAbort({ code: "NOT_MIGRATED", message: `مهاجرت معلقِ نمایهٔ جست‌وجو: ${status.pending.join("، ")}؛ ابتدا migrateSearch() را اجرا کنید.` });
  }
}
