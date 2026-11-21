/**
 * ساختِ نمایهٔ واقعی (داخلی): `createPendingDeadIndex` از رابطِ عمومیِ settlement-pending. نامِ شِمای نامعتبر فقط به‌صورتِ «نامِ متغیر» گزارش می‌شود (مقدار هرگز).
 * `readStatementTimeoutMs` = مهلتِ کلِ فرمان: خواندنِ سنگینِ verify سمتِ پایگاه هم لغو می‌شود، نه فقط سمتِ CLI (پرسشِ رهاشده در پایگاه نماند).
 */
import type { LedgerDatabase } from "@/modules/ledger";
import { createPendingDeadIndex } from "@/modules/settlement-pending";
import { ENV_OUTBOX_SCHEMA } from "./args";
import type { IndexResult } from "./types";

export function createRealIndex(db: LedgerDatabase, options: Readonly<{ schema: string | null; readStatementTimeoutMs: number }>): IndexResult {
  const made = createPendingDeadIndex(db, { ...(options.schema === null ? {} : { schema: options.schema }), readStatementTimeoutMs: options.readStatementTimeoutMs });
  if (!made.ok) return { ok: false, issues: Object.freeze([`${ENV_OUTBOX_SCHEMA} نامعتبر است.`]) };
  return { ok: true, index: made.value };
}
