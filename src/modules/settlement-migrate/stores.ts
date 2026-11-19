/** فروشگاه‌های واقعیِ مهاجرت‌پذیر روی `db` (داخلی): دفتر (`ledger`) و outbox (`settlement`) از رابط‌های عمومیِ خودشان. شِمای نامعتبر ⇒ فقط نامِ متغیر در issues. */
import { createPgAccountStore } from "@/modules/ledger";
import type { LedgerDatabase } from "@/modules/ledger";
import { createPgSettlementOutbox } from "@/modules/settlement";
import { ENV_LEDGER_SCHEMA, ENV_OUTBOX_SCHEMA } from "./args";
import type { StoresResult } from "./types";

export function createRealStores(db: LedgerDatabase, schemas: Readonly<{ ledger: string | null; settlement: string | null }>): StoresResult {
  const ledger = createPgAccountStore(db, schemas.ledger === null ? {} : { schema: schemas.ledger });
  const settlement = createPgSettlementOutbox(db, schemas.settlement === null ? {} : { schema: schemas.settlement });
  const issues: string[] = [];
  if (!ledger.ok) issues.push(`${ENV_LEDGER_SCHEMA} نامعتبر است.`);
  if (!settlement.ok) issues.push(`${ENV_OUTBOX_SCHEMA} نامعتبر است.`);
  if (!ledger.ok || !settlement.ok) return { ok: false, issues: Object.freeze(issues) };
  return { ok: true, ledger: ledger.value, settlement: settlement.value };
}
