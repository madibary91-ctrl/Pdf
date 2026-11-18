/** خواندن حالت و ژورنال (داخلی). فقط‌خواندنی مگر `lock: true` که ردیف حساب را `FOR UPDATE` می‌کند. */
import { sql } from "drizzle-orm";
import type { AccountKey, AccountState, JournalEntry } from "../types";
import { ID_RE } from "../validate";
import { LedgerStoreError } from "./errors";
import { tableRef } from "./naming";
import { journalFromRow, stateFromRows } from "./rows";
import type { LedgerExecutor } from "./types";

/** کلید پورت را سخت می‌سنجد (فراخوان‌های مستقیمِ پورت از مرز سرویس نگذشته‌اند). مقدار نامعتبر هرگز به SQL نمی‌رسد. */
export function assertKey(key: unknown): asserts key is AccountKey {
  const k = key as { tenantId?: unknown; accountId?: unknown } | null;
  if (typeof k !== "object" || k === null || typeof k.tenantId !== "string" || typeof k.accountId !== "string" || !ID_RE.test(k.tenantId) || !ID_RE.test(k.accountId)) {
    throw new LedgerStoreError({ code: "INVALID_INPUT", message: "کلید حساب نامعتبر است (tenantId/accountId باید شناسهٔ معتبر باشند)." });
  }
}

export async function loadState(ex: LedgerExecutor, schema: string, key: AccountKey, lock: boolean): Promise<AccountState | null> {
  const acc = await ex.execute(sql`SELECT unit, created_at_ms, last_at_ms, seq, available, held, granted, charged, forfeited, refunded, shortfall
    FROM ${tableRef(schema, "account")}
    WHERE tenant_id = ${key.tenantId} AND account_id = ${key.accountId}${lock ? sql.raw(" FOR UPDATE") : sql.raw("")}`);
  const row = acc.rows[0];
  if (row === undefined) return null;
  const reservations = await ex.execute(sql`SELECT reservation_id, amount, remaining, charged, closed_amount, status, closed_by, created_at_ms, expires_at_ms, closed_at_ms, attempts
    FROM ${tableRef(schema, "reservation")}
    WHERE tenant_id = ${key.tenantId} AND account_id = ${key.accountId}
    ORDER BY created_at_ms, reservation_id`);
  const processed = await ex.execute(sql`SELECT op_key, fingerprint, receipt
    FROM ${tableRef(schema, "processed")}
    WHERE tenant_id = ${key.tenantId} AND account_id = ${key.accountId}
    ORDER BY op_key`);
  return stateFromRows(key, row, reservations.rows, processed.rows);
}

export async function loadJournal(ex: LedgerExecutor, schema: string, key: AccountKey): Promise<JournalEntry[]> {
  const res = await ex.execute(sql`SELECT seq, at_ms, type, amount, shortfall, reservation_id, attempt_id, ref_id, available_after, held_after
    FROM ${tableRef(schema, "journal")}
    WHERE tenant_id = ${key.tenantId} AND account_id = ${key.accountId}
    ORDER BY seq`);
  return res.rows.map(journalFromRow);
}
