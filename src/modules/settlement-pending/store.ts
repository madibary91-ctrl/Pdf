/**
 * سازندهٔ نمایهٔ «مرده‌های در انتظارِ تأیید» (ADR-0046). `db` = `drizzle(pool)` از بیرون (این ماژول اتصال نمی‌سازد).
 * نام شِما همان شِمای outbox است (`settlement` مگر `options.schema` بدهید).
 */
import type { LedgerDatabase, PgStoreResult } from "@/modules/ledger";
import { SETTLEMENT_DEFAULT_SCHEMA } from "@/modules/settlement";
import { migrate, migrationStatus } from "./migrate";
import { parseSchemaName } from "./naming";
import { buildPendingReader, parseReadStatementTimeout } from "./read";
import type { PendingDeadIndex, PendingDeadIndexOptions } from "./types";

const isFn = (v: unknown): boolean => typeof v === "function";

export function createPendingDeadIndex(db: LedgerDatabase, options: PendingDeadIndexOptions = {}): PgStoreResult<PendingDeadIndex> {
  const d = db as Partial<LedgerDatabase> | null;
  if (typeof d !== "object" || d === null || !isFn(d.execute) || !isFn(d.transaction)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "«db» باید پایگاه drizzle (execute و transaction) باشد." } };
  }
  if (typeof options !== "object" || options === null) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "«options» باید شیء باشد." } };
  }
  const schema = parseSchemaName(options.schema ?? SETTLEMENT_DEFAULT_SCHEMA);
  if (!schema.ok) return schema;
  const readTimeout = parseReadStatementTimeout(options.readStatementTimeoutMs);
  if (!readTimeout.ok) return readTimeout;
  const reader = buildPendingReader(db, schema.value, readTimeout.value);
  return {
    ok: true,
    value: Object.freeze({
      migrate: () => migrate(db, schema.value),
      status: () => migrationStatus(db, schema.value),
      verify: reader.verify,
      listUnacknowledgedDead: reader.listUnacknowledgedDead,
    }),
  };
}
