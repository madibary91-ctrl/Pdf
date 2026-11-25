/**
 * اجرای مهاجرت‌ها، وضعیت و نگهبان‌ها (داخلی). ضمانت‌ها مثل settlement/pg/migrate.ts:
 *  - همه‌چیز در **یک تراکنش** و زیر قفلِ مشورتیِ ماژولی؛ اجرای هم‌زمانِ دو فرایند امن است. خطا ⇒ هیچ تغییری نمی‌ماند.
 *  - checksumِ مهاجرت‌های اعمال‌شده با کد سنجیده می‌شود؛ پایگاهِ «از آینده» و «حفره» رد می‌شود.
 *  - **شِما ساخته نمی‌شود** (ADR-0070 بند ۳): نبودنِ شِما `NOT_MIGRATED` است، نه `CREATE SCHEMA`.
 */
import { sql } from "drizzle-orm";
import { PolicyPgError, toPolicyError, unexpectedDb } from "./errors";
import { EXPECTED_CONSTRAINTS, EXPECTED_TRIGGERS, MIGRATIONS, migrationChecksum, renderStatement, type Migration } from "./migrations";
import { LEDGER_TABLE, VERSIONS_TABLE, regclassName, tableRef } from "./naming";
import type { PgPolicyMigrationReport, PgPolicyResult, PgPolicyStoreStatus, PolicyPgDatabase, PolicyPgExecutor } from "./types";

export type LedgerRow = Readonly<{ name: string; checksum: string }>;
type Status = Readonly<{ applied: readonly string[]; pending: readonly string[] }>;

async function readLedger(ex: PolicyPgExecutor, schema: string): Promise<readonly LedgerRow[]> {
  const res = await ex.execute(sql`SELECT name, checksum FROM ${tableRef(schema, LEDGER_TABLE)} ORDER BY name`);
  return res.rows.map((r) => {
    const name = r["name"];
    const checksum = r["checksum"];
    if (typeof name !== "string" || typeof checksum !== "string") throw new PolicyPgError({ code: "MIGRATION_TAMPERED", message: "دفتر مهاجرت‌های نسخه‌های سیاست شکل نادرستی دارد." });
    return { name, checksum };
  });
}

/** دفتر را با فهرستِ کد مقایسه می‌کند؛ پرتاب: ناشناخته، checksum ناهمخوان، یا حفره. */
export function reconcile(ledger: readonly LedgerRow[], migrations: readonly Migration[] = MIGRATIONS): Status {
  const known = new Map(migrations.map((m) => [m.name, m]));
  for (const row of ledger) {
    if (!known.has(row.name)) {
      throw new PolicyPgError({ code: "MIGRATION_UNKNOWN", message: `پایگاه مهاجرت «${row.name}» را دارد که این نسخهٔ برنامه نمی‌شناسد (پایگاه از نسخهٔ جدیدتری است)؛ برنامه را به‌روز کنید.` });
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
      throw new PolicyPgError({ code: "MIGRATION_TAMPERED", message: `مهاجرت «${m.name}» اعمال شده ولی مهاجرت پیش از آن (${pending[0]}) نه؛ دفتر مهاجرت‌ها دست‌کاری شده است.` });
    }
    if (stored !== migrationChecksum(m)) {
      throw new PolicyPgError({ code: "MIGRATION_TAMPERED", message: `محتوای مهاجرت «${m.name}» پس از اعمال تغییر کرده است (checksum ناهمخوان). مهاجرتِ اعمال‌شده هرگز ویرایش نمی‌شود؛ مهاجرتِ تازه بسازید.` });
    }
    applied.push(m.name);
  }
  return { applied, pending };
}

async function schemaExists(ex: PolicyPgExecutor, schema: string): Promise<boolean> {
  const found = await ex.execute(sql`SELECT 1 AS present FROM pg_catalog.pg_namespace WHERE nspname = ${schema}`);
  const rows: unknown = (found as { rows?: unknown } | undefined)?.rows;
  if (!Array.isArray(rows)) throw unexpectedDb("پاسخِ بررسیِ وجودِ شِما شکل نادرستی دارد.");
  return rows.length > 0;
}

export async function migrate(db: PolicyPgDatabase, schema: string): Promise<PgPolicyResult<PgPolicyMigrationReport>> {
  try {
    const report = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tool-policy-store:migrate:${schema}`}, 0))`);
      if (!(await schemaExists(tx, schema))) {
        throw new PolicyPgError({ code: "NOT_MIGRATED", message: `شِمای «${schema}» وجود ندارد؛ این ماژول شِما نمی‌سازد. ابتدا آن را با دسترسیِ مدیر بسازید.` });
      }
      await tx.execute(sql`CREATE TABLE IF NOT EXISTS ${tableRef(schema, LEDGER_TABLE)} (
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT tool_policy_migration_ledger_pk PRIMARY KEY (name)
      )`);
      const status = reconcile(await readLedger(tx, schema));
      for (const m of MIGRATIONS.filter((x) => status.pending.includes(x.name))) {
        for (const statement of m.statements) await tx.execute(sql.raw(renderStatement(statement, schema)));
        await tx.execute(sql`INSERT INTO ${tableRef(schema, LEDGER_TABLE)} (name, checksum) VALUES (${m.name}, ${migrationChecksum(m)})`);
      }
      return { applied: status.pending, alreadyApplied: status.applied } satisfies PgPolicyMigrationReport;
    });
    return { ok: true, value: report };
  } catch (e) {
    return { ok: false, error: toPolicyError(e).error };
  }
}

/**
 * سپرِ هر عملیات: ذخیره‌ساز فقط روی پایگاهی کار می‌کند که **دقیقاً** با مهاجرت‌های همین کد همخوان است.
 * داخل تراکنشِ خودِ عملیات صدا زده می‌شود؛ شِما/جدولِ ناموجود (42P01/3F000) در `toPolicyError` به `NOT_MIGRATED` نگاشت می‌شود.
 */
export async function assertCurrent(ex: PolicyPgExecutor, schema: string): Promise<void> {
  const status = reconcile(await readLedger(ex, schema));
  if (status.pending.length > 0) {
    throw new PolicyPgError({ code: "NOT_MIGRATED", message: `مهاجرت معلق: ${status.pending.join("، ")}؛ ابتدا migrate() را اجرا کنید.` });
  }
}

/**
 * سپرِ نوشتن: «فقط‌افزودنی» را تریگرها اجرا می‌کنند؛ اگر تریگری برداشته/خاموش شده یا جلسه `session_replication_role≠origin` است
 * (تریگرها اجرا نمی‌شوند) نوشتن **بسته می‌شود**، نه بی‌صدا ادامه می‌یابد.
 */
export async function assertWritable(ex: PolicyPgExecutor, schema: string): Promise<void> {
  const res = await ex.execute(sql`SELECT current_setting('session_replication_role') AS role,
    (SELECT count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = to_regclass(${regclassName(schema, VERSIONS_TABLE)}) AND NOT t.tgisinternal AND t.tgenabled = 'O'
         AND t.tgname IN (${sql.join(EXPECTED_TRIGGERS.map((n) => sql`${n}`), sql`, `)}))::text AS active`);
  const row = res.rows[0];
  if (row?.["role"] !== "origin" || row["active"] !== String(EXPECTED_TRIGGERS.length)) {
    throw new PolicyPgError({ code: "UNSAFE_SESSION", message: "نگهبان‌های فقط‌افزودنیِ پایگاه فعال نیستند (تریگر خاموش یا session_replication_role)؛ نوشتن رد شد." });
  }
}

/** فقط‌خواندنی: وضعیتِ مهاجرت، وجودِ قیدها/تریگرها، شمارِ ردیف و بی‌شکافی. شِمای ناموجود = همه معلق (خطا نیست). */
export async function status(db: PolicyPgDatabase, schema: string): Promise<PgPolicyResult<PgPolicyStoreStatus>> {
  try {
    const value = await db.transaction(
      async (tx): Promise<PgPolicyStoreStatus> => {
        const pendingAll = MIGRATIONS.map((m) => m.name);
        const empty = (exists: boolean): PgPolicyStoreStatus => ({ schemaExists: exists, applied: [], pending: pendingAll, problems: [], rows: 0, latestVersion: null, contiguous: true, ready: false });
        if (!(await schemaExists(tx, schema))) return empty(false);
        const led = await tx.execute(sql`SELECT to_regclass(${regclassName(schema, LEDGER_TABLE)}) IS NOT NULL AS present`);
        if (led.rows[0]?.["present"] !== true) return empty(true);
        const rec = reconcile(await readLedger(tx, schema));
        const problems: string[] = [];
        let rows = 0;
        let latest: number | null = null;
        let contiguous = true;
        if (rec.applied.length > 0) {
          const regclass = regclassName(schema, VERSIONS_TABLE);
          const cons = await tx.execute(sql`SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid = to_regclass(${regclass}) AND convalidated`);
          const haveCons = new Set(cons.rows.map((r) => r["conname"]));
          for (const n of EXPECTED_CONSTRAINTS) if (!haveCons.has(n)) problems.push(`constraint_missing:${n}`);
          const trg = await tx.execute(sql`SELECT tgname FROM pg_catalog.pg_trigger WHERE tgrelid = to_regclass(${regclass}) AND NOT tgisinternal AND tgenabled = 'O'`);
          const haveTrg = new Set(trg.rows.map((r) => r["tgname"]));
          for (const n of EXPECTED_TRIGGERS) if (!haveTrg.has(n)) problems.push(`trigger_missing_or_disabled:${n}`);
          const agg = await tx.execute(sql`SELECT count(*)::text AS n, max(version)::text AS m FROM ${tableRef(schema, VERSIONS_TABLE)}`);
          const n = Number(agg.rows[0]?.["n"]);
          const m = agg.rows[0]?.["m"];
          if (!Number.isSafeInteger(n) || (m !== null && typeof m !== "string")) throw unexpectedDb("پاسخِ شمارشِ نسخه‌ها شکل نادرستی دارد.");
          rows = n;
          latest = m === null || m === undefined ? null : Number(m);
          contiguous = latest === null ? rows === 0 : rows === latest;
        }
        return { schemaExists: true, applied: rec.applied, pending: rec.pending, problems, rows, latestVersion: latest, contiguous, ready: rec.pending.length === 0 && problems.length === 0 && contiguous };
      },
      { accessMode: "read only" },
    );
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: toPolicyError(e).error };
  }
}
